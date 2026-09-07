# Deploy di mcp-linkedin nella flotta MCP

Questo servizio si deploya da qui, non dall'infrastruttura: `qmates-mcp-fleet`
fornisce la macchina, la rete `fleet` e l'edge, e **non sa quali servizi
esistono**. Il contratto per entrarci è in `infra/edge/services/README.md` di
quel repo, e lo standard che il servizio rispetta in
`docs/mcp-service-standard.md`.

`mcp-linkedin` è un **resource server**: l'identità non la gestisce, la chiede a
`auth.qmates.tech` per introspection. Ciò che tiene sono i collegamenti LinkedIn
dei QMate — un token per `sub`, cifrato a riposo — e quelli sono suoi.

Richiede **Docker Compose ≥ 2.30** sul box: il compose usa la forma lunga di
`env_file` con `format: raw`, e serve a impedire che Compose interpoli i VALORI
dei segreti. Misurato: senza, un client secret che contenga un `$` arriva al
container troncato, e uno che contenga `${HOME}` arriva con la home del runner
dentro — con il file su disco perfettamente giusto. Una versione più vecchia
rifiuta la chiave, che è il modo giusto di scoprirlo.

---

## Prerequisiti — quattro cose vere prima del primo deploy

### 1. L'hostname deve essere libero — **questo blocca il primo deploy**

`mcp-linkedin.qmates.tech` è oggi rivendicato dal **probe della milestone §14**,
che vive in `qmates-auth-server/deploy/caddy/mcp-linkedin.caddy`.

`fleet-publish-fragments` non riceve argomenti (sudo non ammette wildcard negli
argomenti), quindi attraversa **tutte** le custodie di deploy: due che portano lo
stesso `<host>.caddy` sono due servizi che reclamano lo stesso nome, e il
pubblicatore **rifiuta e non pubblica nulla** nominandole. Il primo deploy di
questo servizio si fermerà quindi lì — rumorosamente, e prima di toccare l'edge,
che è il guasto giusto.

Sbloccarlo richiede, **in questo ordine**:

1. **Chiudere la checklist §14**, di cui restano due voci
   (`qmates-mcp-fleet/docs/infra/e2e/RUNBOOK.md` §6, stato in `HANDOFF.md`):
   - il login reale da **Cowork** (Settings → Connectors → Add custom connector
     → `https://mcp-linkedin.qmates.tech/mcp`, poi `whoami` deve rispondere con
     lo stesso `sub` di Claude Code);
   - la **controprova negativa** con un account Google **non** `@qmates.tech`,
     che l'AS deve rifiutare con `access_denied` senza emettere alcun token.

   Sono due voci che si provano **solo** contro il probe: smontarlo prima
   significa perdere l'unico banco su cui la topologia è misurabile in
   isolamento, e diagnosticare un fallimento di Cowork mentre il vero servizio
   LinkedIn è in mezzo.

2. **Smontare il probe** nel repo dell'AS: togliere il servizio `rs-probe` dal
   suo compose e **cancellare** `deploy/caddy/mcp-linkedin.caddy` **nello stesso
   commit**. Chi cede l'hostname cancella il proprio frammento quando smonta il
   servizio: se lo lascia, il primo deploy di chiunque fallisce.

3. **Redeployare l'AS**, perché la custodia sul box conserva i file
   dell'ultimo rilascio: finché non ci ripassa un deploy, il frammento del probe
   resta in `/opt/gha-runner/.auth-deploy/caddy/` e continua a reclamare
   l'hostname anche se nel repo non c'è più.

Il deploy di questo servizio se ne accorge da sé, prima di scaricare o avviare
qualsiasi cosa: lo step *Nessun altro reclama l'hostname* nomina la custodia in
conflitto.

### 2. Il posto dei dati, sul box

Qui vivono i token LinkedIn di ogni QMate. Serve un LV proprio: su una directory
qualunque di `/` crescerebbero senza tetto insieme al disco di tutta la flotta.

`infra/provision/bootstrap.sh` lo prevede già (`provision_lv mcp-linkedin 5G`,
il mount fra quelli che `fleet-mounts-ok` pretende, e `own_data mcp-linkedin
1000`). Sul box va **rilanciato una volta**, dal repo `qmates-mcp-fleet`:

```bash
ssh root@<box> 'FLEET_VOLUME_ID=<id> bash -s' < infra/provision/bootstrap.sh
```

È idempotente: su un box già apparecchiato crea solo ciò che manca e non tocca i
dati degli altri servizi.

La proprietà della directory conta e si assegna **dopo** il mount: la radice di
un filesystem appena creato appartiene a root, e il container gira come uid 1000
(`USER node`). Se resta di root, SQLite non apre il database e il servizio muore
al primo collegamento LinkedIn con un errore che parla di file, non di permessi.
Il deploy controlla mount e proprietario prima di avviare e si ferma nominando
il rimedio.

### 3. Lato authorization server — non puoi farlo da questo repo

Nel repo `qmates-auth-server`, Environment `production`:

1. `openssl rand -base64 32` → deposita lo stesso valore in **due** posti:
   `QAS_RS_SECRET_MCP_LINKEDIN` là, e `QLI_INTROSPECT_SECRET` qui.
   Usa `printf` e non `echo`: il newline finale diventerebbe parte del segreto e
   l'autenticazione fallirebbe con un errore che non dice nulla.
2. Aggiungi `mcp-linkedin` alla variabile `QAS_RS_CLIENT_IDS` (comma-separated).
3. Aggiungi la riga `RS_SECRET_MCP_LINKEDIN: ${{ secrets.QAS_RS_SECRET_MCP_LINKEDIN }}`
   nel blocco `env:` del suo `deploy.yml`. Un id dichiarato senza il suo segreto
   **ferma il deploy dell'AS** nominandolo, invece di produrre un RS che riceve
   401 su ogni chiamata senza che nessuno capisca perché.
4. Verifica che `https://mcp-linkedin.qmates.tech` sia fra le voci di
   `QAS_AUDIENCES`. C'è già dalla milestone §14 — è l'hostname che il probe
   occupava — quindi in genere non serve toccarla.
5. **Redeploya l'AS**, o il nuovo client di introspection non esiste.

### 4. L'app LinkedIn

Il redirect URI **non** è configurabile: il servizio lo deriva come
`<QLI_RESOURCE_URL>/linkedin/callback`, perché due variabili che devono
combaciare sono due variabili che prima o poi divergono. Registra nell'app
LinkedIn esattamente:

```
https://mcp-linkedin.qmates.tech/linkedin/callback
```

---

## Segreti e variabili, nell'Environment `production` di questo repo

I valori non passano da nessuna persona: GitHub li consegna al runner, il runner
li scrive in un `.env` 0600 sul box. Nessuno li digita, li incolla o li rilegge —
i secret di GitHub sono write-only.

| nome | tipo | cosa è, e cosa deve combaciare |
|---|---|---|
| `QLI_INTROSPECT_SECRET` | secret | `openssl rand -base64 32`. Lo stesso valore di `QAS_RS_SECRET_MCP_LINKEDIN` lato AS |
| `QLI_LINKEDIN_CLIENT_ID` | secret | client id dell'app LinkedIn aziendale |
| `QLI_LINKEDIN_CLIENT_SECRET` | secret | client secret della stessa app |
| `QLI_TOKEN_KEY` | secret | `openssl rand -base64 32`, 32 byte. Cifra i token dei QMate a riposo |
| `QLI_RESOURCE_URL` | variable | `https://mcp-linkedin.qmates.tech` — **identica**, path incluso, a una voce di `QAS_AUDIENCES` |
| `QLI_AS_URL` | variable | `https://auth.qmates.tech` |

`QLI_INTROSPECT_CLIENT_ID` è cablato a `mcp-linkedin` in `deploy.yml`: è lo
stesso nome del servizio, del container e dell'immagine, e una variabile in più
sarebbe solo un posto in più in cui divergere. `QLI_DB_PATH` e `QLI_PORT` li
pinna il compose, accanto al volume e alla healthcheck con cui devono combaciare.

**Su `QLI_TOKEN_KEY`:** perderla significa che ogni QMate deve ricollegare il
proprio account LinkedIn; ruotarla senza migrare i dati ha lo stesso effetto.
Non si ruota per igiene, si ruota per compromissione.

---

## Rilascio

Actions → **deploy** → *Run workflow*. Un `workflow_dispatch` e nient'altro: la
messa in opera è un atto umano esplicito. Il campo `image_tag` accetta uno sha di
commit a 40 esadecimali per cui la CI ha già pubblicato l'immagine; vuoto = il
commit del run.

Due ordini contano, e per un motivo:

- l'hostname si reclama **dopo** che il servizio risponde. Il frammento entra
  nella custodia solo a valle del cancello di salute, altrimenti un deploy
  fallito lascerebbe una rivendicazione che il deploy di un **altro** repo
  pubblicherebbe per noi — `fleet-publish-fragments` attraversa tutte le
  custodie a ogni invocazione — puntando l'hostname a un container morto;
- i controlli sul box (mount, proprietario, rete `fleet`, hostname libero) stanno
  **prima** della scrittura del `.env`, così un prerequisito mancante non lascia
  segreti in una custodia per un deploy che non partirà.

**Non ribuilda mai.** Mette in opera l'immagine `:<sha>` che la CI ha già
validato: un `build` nel deploy reintrodurrebbe la possibilità che il codice
testato e quello in esecuzione divergano.

### Tornare indietro

`up -d` sostituisce il container prima che `/healthz` sia verificato, e con
`restart: unless-stopped` un container che esce 78 per configurazione
inutilizzabile va in crash-loop: da quel momento l'hostname risponde 502. Il
rimedio è ripartire dallo sha precedente, che esiste su GHCR perché i tag sono
per sha e nessuno li muove.

```bash
# lo sha in opera adesso
docker inspect --format '{{.Config.Image}}' mcp-linkedin-deploy-mcp-linkedin-1

# gli sha disponibili: la storia di master
git log --format='%h %s' -20 master
```

Poi Actions → **deploy** → *Run workflow*, con `image_tag` = lo sha buono. Il
frammento sull'edge non va toccato: punta al nome del container, non
all'immagine, quindi resta valido attraverso un rollback.

Se il guasto è nel `.env` e non nel codice, correggi il secret nell'Environment e
rilancia il deploy sullo **stesso** sha: il `.env` si riscrive a ogni giro.

### Un presidio che vive fuori dai file

Environment `production` → *Deployment branches and tags* = **solo `master`**. Un
Environment nasce con «All branches»: senza la restrizione, chiunque possa
pushare spinge un branch con `deploy.yml` modificato, lo lancia dal menu Actions
scegliendo quel ref, e GitHub gli consegna la chiave di cifratura dei token
LinkedIn di tutti i QMate — su un runner con privilegi equivalenti a root sul box.

### A mano, se il runner non c'è

```bash
cp deploy/env.mcp-linkedin.example deploy/.env.mcp-linkedin
openssl rand -base64 32          # QLI_TOKEN_KEY
$EDITOR deploy/.env.mcp-linkedin
chmod 600 deploy/.env.mcp-linkedin

export MCP_LINKEDIN_IMAGE=ghcr.io/qmates-tech/mcp-linkedin:<sha>
# -p mcp-linkedin-deploy NON è decorativo: senza, il nome del progetto viene
# dalla directory (`deploy`) e nasce un SECONDO container con lo stesso alias
# `mcp-linkedin` sulla rete fleet. Il DNS di Docker alterna fra i due, e metà
# delle richieste finisce su un servizio che non è quello che credi.
docker compose -p mcp-linkedin-deploy -f deploy/docker-compose.yml pull
docker compose -p mcp-linkedin-deploy -f deploy/docker-compose.yml up -d

# il frammento sull'edge, poi il reload — questi due DA ROOT: la regola sudoers
# del runner concede solo /usr/local/bin/fleet-publish-fragments, quindi da
# `ghrunner` l'install chiede una password che non esiste.
install -m 644 deploy/caddy/mcp-linkedin.caddy /srv/fleet/edge/services/
# La forma del contratto (infra/edge/services/README.md), dal repo della flotta:
# il nome del container lo compone Compose dalla cartella da cui l'edge e' stato
# avviato, quindi cablarlo qui e' un comando che smette di funzionare da solo.
docker compose -f infra/edge/docker-compose.yml exec caddy \
  caddy reload --config /etc/caddy/Caddyfile
```

`install` diretto **scavalca** il controllo di collisione di
`fleet-publish-fragments`: qui l'hostname si sovrascrive senza che nessuno
protesti. È l'uscita di emergenza, non la strada — usala sapendo che stai
sfrattando chiunque altro reclami quel nome.

Caddy valida prima di applicare: un frammento rotto fa fallire il reload e
lascia in piedi la configurazione precedente. Un servizio che si deploya male non
porta giù la flotta.

---

## Dopo il deploy: la checklist §8 dello standard

La salute (§6) e le prime **due** voci — la metadata e il 401 che la cita — le
verifica `deploy.yml` dall'esterno, e il run è rosso se non passano. L'audience
binding, che è la terza, NON la verifica: serve un token vero coniato per
un'altra resource. Le altre si controllano una volta, qui.

```bash
# [x] la resource dichiarata è quella giusta
curl -s https://mcp-linkedin.qmates.tech/.well-known/oauth-protected-resource
# → {"resource":"https://mcp-linkedin.qmates.tech","authorization_servers":["https://auth.qmates.tech"],...}

# [x] POST /mcp senza token → 401 con WWW-Authenticate che cita la metadata
curl -si -X POST https://mcp-linkedin.qmates.tech/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{}}' | head -8

# [x] salute, senza toccare dipendenze
curl -s https://mcp-linkedin.qmates.tech/healthz     # → {"status":"ok"}

# [ ] nessuna porta pubblicata: la colonna PORTS deve essere VUOTA
docker compose -p mcp-linkedin-deploy \
  -f ~/.mcp-linkedin-deploy/docker-compose.yml ps

# [ ] un campo di config mancante fa fallire l'avvio nominandolo
docker run --rm --env-file /dev/null \
  ghcr.io/qmates-tech/mcp-linkedin:<sha>
# → configurazione inutilizzabile:
#     QLI_RESOURCE_URL manca
#     QLI_AS_URL manca
#     ... tutti insieme, non il primo
```

### Le tre voci che curl non prova

**Un token per un'altra resource è rifiutato.** È l'unico controllo che
impedisce a un bearer coniato per `mcp-council` di entrare qui, quindi va
guardato una volta, dal vivo. Serve un token vero per un'altra audience: fai un
login MCP contro un altro servizio della flotta, prendi il suo bearer e
presentalo qui.

```bash
curl -si -X POST https://mcp-linkedin.qmates.tech/mcp \
  -H "authorization: Bearer <un token coniato per mcp-council>" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{}}' | head -3
# deve essere 401 — e nei log del servizio deve comparire
#   {"event":"bearer_refused","refusal":"other_audience","aud":"https://mcp-council.qmates.tech"}
```

**L'AS irraggiungibile fa rifiutare, non accettare.** Coperto da
`tests/unit/fleet/introspection.test.ts` (`as_unreachable`). Dal vivo si osserva
sui log: al client arriva sempre la stessa frase, perché distinguere i motivi
nella risposta darebbe a un anonimo un oracolo sui token che non possiede.

**Nessun percorso locale nell'interfaccia dei tool.** Non è una voce da
spuntare a mano: `tests/integration/tools.test.ts` legge gli schemi come li
riceve un client (`listTools`, non il registro privato dell'SDK) e fallisce se
un tool qualsiasi dichiara una proprietà il cui nome contiene `path`, `file`,
`dir` o `filename`. È la lezione nata in questo repo — `imagePath` finiva in
`readFile` — quindi il presidio sta nella CI e non in una checklist.

**Il `sub` autenticato è ciò che indicizza i dati** si vede al primo
collegamento reale, quando un QMate collega LinkedIn e ritrova i propri post — e
solo i propri — alla sessione successiva.

---

## Quando non funziona

I log del servizio: una riga JSON per evento, su stderr.

```bash
docker compose -p mcp-linkedin-deploy \
  -f ~/.mcp-linkedin-deploy/docker-compose.yml logs --tail 60 mcp-linkedin
```

Funziona senza sapere lo sha in opera: il deploy scrive un `.env` nella custodia
con `MCP_LINKEDIN_IMAGE`, e Compose lo carica da sé dalla cartella del compose.
Senza quel file ogni comando muore in interpolazione — `required variable
MCP_LINKEDIN_IMAGE is missing a value` — prima di stampare qualsiasi cosa.

### Il container non sta su

| nel log | significa | rimedio |
|---|---|---|
| `configurazione inutilizzabile:` seguito da `QLI_… manca` | il `.env` non ha quel campo: manca il secret o la variabile nell'Environment `production` | depositalo e rilancia il deploy. Il messaggio elenca **tutti** i campi rotti, non il primo |
| `QLI_TOKEN_KEY deve essere 32 byte in base64, ne ha N` | il secret è troncato o non è base64 | rigenera con `openssl rand -base64 32`, deposita con `printf` |
| `QLI_RESOURCE_URL deve essere https` | la variabile punta a un `http://` non-loopback | correggi la variabile |
| `SQLITE_CANTOPEN` **all'avvio**, senza che il servizio arrivi a rispondere | `/srv/fleet/mcp-linkedin` non è scrivibile da uid 1000. Il database si apre in `new LinkStore(...)` **prima** di mettersi in ascolto, quindi non esiste nessuna riga `request_failed` da cercare | `install -d -o 1000 -g 1000 -m 700 /srv/fleet/mcp-linkedin`, oppure rilancia `bootstrap.sh` (vedi prerequisito 2) |
| `network fleet declared as external, but could not be found` | la rete della flotta non esiste: box ricostruito, o un `docker network prune` | rilancia `infra/provision/bootstrap.sh`. Il deploy lo controlla nel preflight, prima di scrivere il `.env` |

### Il container sta su, ma le chiamate MCP falliscono

Ogni rifiuto lascia `{"event":"bearer_refused","refusal":"…"}`. Il `refusal` è
l'unico posto dove il motivo vero è scritto: al client arriva sempre
`token non accettato`.

| `refusal` | causa | rimedio |
|---|---|---|
| `as_refused_us` | il nostro secret di introspection non combacia con la voce dell'AS. **Nulla funzionerà** finché non si allinea | rideposita lo stesso valore in `QLI_INTROSPECT_SECRET` e in `QAS_RS_SECRET_MCP_LINKEDIN`, redeploya **entrambi** |
| `other_audience` | il token è stato coniato per un'altra resource, oppure `QLI_RESOURCE_URL` non è identica alla voce di `QAS_AUDIENCES`. Sintomo tipico: **il login riesce** e ogni chiamata torna 401 | confronta le due stringhe **carattere per carattere**, path compreso: slash finale e maiuscole sono normalizzati, un path diverso no |
| `other_issuer` | `QLI_AS_URL` punta a un AS che non è il nostro | correggi la variabile |
| `as_unreachable` | l'AS è giù, o il container non è sulla rete `fleet` | `docker network inspect fleet`, e i log dell'AS |
| `token_inactive` | il token è scaduto o revocato | il QMate si riautentica: è il caso normale, non un guasto |
| `introspections_exhausted` | qualcuno sta sparando bearer inventati: il tetto protegge **l'AS**, che è la porta di tutta la flotta, non noi | guarda gli access log dell'edge; il tetto è molto sopra l'uso reale |
| `no_subject`, `no_expiry`, `verdict_unreadable` | l'AS ha risposto qualcosa di inatteso | versioni disallineate fra AS e RS: guarda i log dell'AS |

### L'hostname non risponde affatto

| sintomo | causa | rimedio |
|---|---|---|
| `not a fleet service` con 404 | il frammento non è mai arrivato sull'edge | `ls /srv/fleet/edge/services/`; se manca, il deploy non ha eseguito la pubblicazione, oppure la custodia è fuori dal glob `/opt/gha-runner/.*-deploy` |
| `frammenti reclamati da piu di una custodia` | un altro repo reclama ancora `mcp-linkedin.qmates.tech` | prerequisito 1: cancella il frammento del probe e redeploya l'AS |
| 502 dall'edge | il container è giù, oppure il nome dopo `reverse_proxy` non è il nome del servizio nel compose | `docker compose ps`; il nome nel frammento è `mcp-linkedin`, come il servizio |
| errore TLS su ogni host della flotta | il wildcard `*.qmates.tech` è scaduto (rinnovo **manuale**) | è già capitato il 2026-08-03: vedi `infra/edge/Caddyfile` |
| 401 su ogni chiamata **dopo** un login riuscito | è quasi sempre `other_audience` | guarda i log, riga sopra |
