#!/usr/bin/env bash
# Apparecchia l'Environment `production` di mcp-linkedin, sui due repo che
# devono combaciare.
#
#   ./scripts/provision-production.sh [percorso-del-file]     (default: envs.txt)
#
# I DUE SEGRETI CONDIVISI LI GENERA LO SCRIPT, e li deposita in entrambi i posti
# nello stesso giro. È il rimedio al problema vero: un secret di GitHub, una
# volta scritto, non si rilegge — quindi allineare a mano lo stesso valore in due
# repo significa tenerne una copia da qualche parte, che è la copia che poi
# finisce in una chat o in un file. Qui il valore non compare mai: né a schermo,
# né in un file, né nella storia della shell.
#
# Il client id e il client secret dell'app LinkedIn li legge da un file di righe
# `CHIAVE=valore` — non da un prompt, che pretende un TTY e non c'è quando lo
# script parte da una shell non interattiva. Il file NON viene stampato e NON
# deve stare in git: lo script si ferma se è tracciato.
#
# Tutto è idempotente: rilanciarlo rigenera i due segreti che genera lui e
# lascia stare il resto.
set -euo pipefail

CREDENTIALS_FILE="${1:-envs.txt}"

LINKEDIN_REPO="qmates-tech/linkedin-mcp-server"
AUTH_REPO="qmates-tech/qmates-auth-server"
ENVIRONMENT="production"
RESOURCE_URL="https://mcp-linkedin.qmates.tech"
AS_URL="https://auth.qmates.tech"
# Lo stesso nome che il servizio ha nel compose, nell'immagine e nel frammento
# Caddy, e che deve comparire in QAS_RS_CLIENT_IDS lato AS.
CLIENT_ID="mcp-linkedin"

say() { printf '\n=== %s\n' "$1"; }
fatale() { printf 'FERMO: %s\n' "$1" >&2; exit 1; }

command -v gh >/dev/null || fatale "serve la CLI gh (brew install gh)"
command -v openssl >/dev/null || fatale "serve openssl"
gh auth status >/dev/null 2>&1 || fatale "gh non è autenticato: gh auth login"

say "l'Environment production su ${LINKEDIN_REPO}"
# `gh secret set --env` non crea l'Environment: su uno che non esiste risponde
# 404 e non si capisce che manca il contenitore, non il segreto.
# Corpo JSON e non `-f`: quei due campi sono booleani, e `-f` manda stringhe —
# l'API risponde 422 dicendo che `"false"` non è un boolean.
gh api -X PUT "repos/${LINKEDIN_REPO}/environments/${ENVIRONMENT}" --input - >/dev/null <<'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
echo "  creato (o già c'era)"

# Il presidio che rende vere le righe di sicurezza in deploy.yml: un Environment
# nasce con «All branches», e senza questa restrizione chiunque possa pushare
# spinge un branch con deploy.yml modificato, lo lancia dal menu Actions
# scegliendo quel ref, e GitHub gli consegna la chiave di cifratura dei token
# LinkedIn di tutti i QMate — su un runner con privilegi di root sul box.
if ! gh api "repos/${LINKEDIN_REPO}/environments/${ENVIRONMENT}/deployment-branch-policies" \
     --jq '.branch_policies[].name' 2>/dev/null | grep -qx master; then
  gh api -X POST "repos/${LINKEDIN_REPO}/environments/${ENVIRONMENT}/deployment-branch-policies" \
    -f name=master -f type=branch >/dev/null
  echo "  deployment branch policy: solo master"
else
  echo "  deployment branch policy: solo master (già impostata)"
fi

say "il segreto di introspection, nei DUE posti che devono combaciare"
# Generato qui e depositato due volte nello stesso giro: è l'unico modo di
# averlo identico in entrambi senza che nessuno ne tenga una copia.
introspection_secret="$(openssl rand -base64 32)"
printf '%s' "${introspection_secret}" \
  | gh secret set QLI_INTROSPECT_SECRET --env "${ENVIRONMENT}" -R "${LINKEDIN_REPO}"
printf '%s' "${introspection_secret}" \
  | gh secret set QAS_RS_SECRET_MCP_LINKEDIN --env "${ENVIRONMENT}" -R "${AUTH_REPO}"
unset introspection_secret
echo "  QLI_INTROSPECT_SECRET → ${LINKEDIN_REPO}"
echo "  QAS_RS_SECRET_MCP_LINKEDIN → ${AUTH_REPO}"

say "la chiave con cui i token LinkedIn stanno cifrati a riposo"
# Perderla non è una catastrofe: ogni QMate rifà `linkedin_link_start`. Per
# questo non esiste un sottosistema di rotazione — costerebbe più del danno che
# evita, e oggi il danno è zero perché nessuno ha ancora collegato niente.
printf '%s' "$(openssl rand -base64 32)" \
  | gh secret set QLI_TOKEN_KEY --env "${ENVIRONMENT}" -R "${LINKEDIN_REPO}"
echo "  QLI_TOKEN_KEY → ${LINKEDIN_REPO}"

say "le due variabili (non sono segreti: si rileggono)"
gh variable set QLI_RESOURCE_URL --env "${ENVIRONMENT}" -R "${LINKEDIN_REPO}" --body "${RESOURCE_URL}"
gh variable set QLI_AS_URL --env "${ENVIRONMENT}" -R "${LINKEDIN_REPO}" --body "${AS_URL}"
echo "  QLI_RESOURCE_URL=${RESOURCE_URL}"
echo "  QLI_AS_URL=${AS_URL}"

say "il client di introspection nell'elenco dell'AS"
# Append idempotente: un id dichiarato senza il suo segreto ferma il deploy
# dell'AS nominandolo, e un segreto senza l'id non viene mai seminato.
current_ids="$(gh variable get QAS_RS_CLIENT_IDS --env "${ENVIRONMENT}" -R "${AUTH_REPO}" 2>/dev/null || echo '')"
if printf '%s' "${current_ids}" | tr ',' '\n' | grep -qx "${CLIENT_ID}"; then
  echo "  QAS_RS_CLIENT_IDS contiene già ${CLIENT_ID}: ${current_ids}"
else
  updated_ids="${current_ids:+${current_ids},}${CLIENT_ID}"
  gh variable set QAS_RS_CLIENT_IDS --env "${ENVIRONMENT}" -R "${AUTH_REPO}" --body "${updated_ids}"
  echo "  QAS_RS_CLIENT_IDS=${updated_ids}"
fi

say "l'audience, che deve combaciare carattere per carattere"
audiences="$(gh variable get QAS_AUDIENCES --env "${ENVIRONMENT}" -R "${AUTH_REPO}" 2>/dev/null || echo '')"
if printf '%s' "${audiences}" | tr ',' '\n' | grep -qx "${RESOURCE_URL}"; then
  echo "  QAS_AUDIENCES contiene già ${RESOURCE_URL}"
else
  # Non la si tocca in automatico: un'audience sbagliata non si vede al login,
  # che riesce, ma a ogni chiamata successiva con un 401.
  echo "  MANCA ${RESOURCE_URL} in QAS_AUDIENCES (ora: ${audiences:-vuota})"
  echo "  aggiungila a mano, poi redeploya l'AS"
fi

say "le credenziali dell'app LinkedIn aziendale"
if [ ! -f "${CREDENTIALS_FILE}" ]; then
  echo "  ${CREDENTIALS_FILE} non c'è: le due credenziali restano da depositare."
  echo "  Scrivi un file così (una riga per credenziale, niente virgolette):"
  echo "    QLI_LINKEDIN_CLIENT_ID=..."
  echo "    QLI_LINKEDIN_CLIENT_SECRET=..."
  echo "  poi rilancia. Tutto il resto è già a posto."
else
  # In git quel file sarebbe il client secret dell'app aziendale dentro la
  # storia del repo, da cui non si toglie con una `rm`.
  if git ls-files --error-unmatch "${CREDENTIALS_FILE}" >/dev/null 2>&1; then
    fatale "${CREDENTIALS_FILE} è TRACCIATO da git: toglilo dall'indice prima di usarlo (git rm --cached)"
  fi
  mode="$(stat -f '%Lp' "${CREDENTIALS_FILE}" 2>/dev/null || stat -c '%a' "${CREDENTIALS_FILE}")"
  case "${mode}" in
    *00) ;;
    *) echo "  attenzione: ${CREDENTIALS_FILE} è leggibile da altri (${mode}); chmod 600";;
  esac

  # Lettura riga per riga, taglio al PRIMO `=`: un valore può contenerne altri.
  # `$'\r'` via: un file passato da Windows o da un incolla porta il ritorno a
  # capo dentro il valore, e il segreto arriverebbe diverso di un byte.
  deposita_da_file() {
    local chiave="$1" valore
    valore="$(sed -n "s/^${chiave}=//p" "${CREDENTIALS_FILE}" | head -1 | tr -d '\r')"
    if [ -z "${valore}" ]; then
      echo "  MANCA ${chiave} in ${CREDENTIALS_FILE}"
      return 1
    fi
    printf '%s' "${valore}" | gh secret set "${chiave}" --env "${ENVIRONMENT}" -R "${LINKEDIN_REPO}"
    echo "  ${chiave} → ${LINKEDIN_REPO}"
  }
  # `|| mancante=1` e non la chiamata nuda: con `set -e` una chiave vuota
  # ucciderebbe lo script e la coda non girerebbe mai.
  mancante=0
  deposita_da_file QLI_LINKEDIN_CLIENT_ID || mancante=1
  deposita_da_file QLI_LINKEDIN_CLIENT_SECRET || mancante=1
  if [ "${mancante}" = 1 ]; then
    echo "  riempi le chiavi mancanti in ${CREDENTIALS_FILE} e rilancia"
  else
    echo "  ora cancella ${CREDENTIALS_FILE}: i segreti vivono nell'Environment, non su disco"
  fi
fi

say "cosa resta, e lo fa una persona"
cat <<'FINE'
  1. redeploya l'AUTH SERVER: il client di introspection non esiste finché non
     ci ripassa un deploy (Actions → deploy, sul suo repo)
  2. rilancia bootstrap.sh sul box, dal repo qmates-mcp-fleet:
       ssh root@<box> 'FLEET_VOLUME_ID=<id> bash -s' < infra/provision/bootstrap.sh
     porta l'LV di mcp-linkedin, la proprietà della sua directory e il fix del
     pubblicatore dei frammenti
  3. smonta il probe della milestone §14 e cancella il suo frammento nello
     stesso commit, poi redeploya l'AS: finché quel file esiste, il pubblicatore
     rifiuta e il primo deploy di mcp-linkedin si ferma
  4. Actions → deploy su questo repo
FINE
