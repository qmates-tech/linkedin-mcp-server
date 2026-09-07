/**
 * L'audience di un token: la resource della fleet per cui quel token vale.
 *
 * CONTRATTO DELLA FLEET, riscritto in TypeScript perché questo servizio non può
 * importare l'originale eseguibile (`qmates_auth_server/audience.py`). L'`aud`
 * che l'AS conia e restituisce all'introspection è SEMPRE in forma canonica:
 * scheme e host minuscoli, porta conservata se esplicita, query e frammento via,
 * nessuno slash finale — e il path, invece, significativo.
 *
 * Confrontare la stringa che si ha in configurazione invece della sua forma
 * canonica è un guasto che non si vede al login, che riesce, ma a ogni chiamata
 * successiva: 401 con la causa a un carattere di distanza in una env var.
 *
 * `new URL()` NON serve a implementarla, ed è la trappola in cui si cade per
 * prima: il parser WHATWG *normalizza* (risolve `..`, decodifica `%2e`,
 * percent-encoda gli spazi, punycoda gli IDN, tiene le parentesi dell'IPv6),
 * mentre `urlsplit` fa una scomposizione puramente sintattica. Ogni
 * normalizzazione in più è un potenziale COLLASSO: due audience che per l'AS
 * sono distinte diventerebbero la stessa per noi, e un token coniato per l'una
 * entrerebbe con l'altra. Quindi qui la scomposizione è a mano, e
 * `tests/unit/fleet/audience.test.ts` la confronta con quella di Python su un
 * corpus generato, non su una tabella di casi scelti da chi l'ha scritta.
 *
 * L'unica divergenza deliberata è il rifiuto: dove `urlsplit` conia una forma
 * degenere (`://h/x` senza scheme, `https://` senza host) o solleva
 * `ValueError` (porta non numerica o fuori range, parentesi IPv6 spaiate), qui
 * si rende `null`. È la direzione sicura — `null` non combacia con nulla — e
 * sul confine della configurazione diventa un errore d'avvio che nomina il
 * campo.
 */

/** Caratteri che `urlsplit` cancella dovunque compaiano, prima di scomporre. */
const IGNORED_ANYWHERE = /[\t\r\n]/g;
/** `urlsplit` toglie i controlli C0 e gli spazi solo in testa, non in coda. */
const LEADING_CONTROLS = /^[\x00-\x20]+/;
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/;
const AUTHORITY_END = /[/?#]/;
const ASCII_DIGITS = /^[0-9]+$/;
const HIGHEST_PORT = 65535;
const TRAILING_SLASHES = /\/+$/;

/** La forma su cui si confrontano le audience; `null` se non è una resource. */
export function canonicalResource(uri: string): string | null {
  const uniform = uri.trim().replace(IGNORED_ANYWHERE, '').replace(LEADING_CONTROLS, '');

  const scheme = SCHEME.exec(uniform);
  if (!scheme) return null;

  let rest = uniform.slice(scheme[0].length);
  let authority = '';
  if (rest.startsWith('//')) {
    const afterAuthority = rest.slice(2).search(AUTHORITY_END);
    authority = afterAuthority < 0 ? rest.slice(2) : rest.slice(2, 2 + afterAuthority);
    rest = afterAuthority < 0 ? '' : rest.slice(2 + afterAuthority);
  }

  const host = hostOf(authority);
  if (host === null || host === '') return null;
  const port = portOf(authority);
  if (port === null) return null;

  const path = (rest.split('#', 1)[0] ?? '').split('?', 1)[0] ?? '';
  return `${scheme[1].toLowerCase()}://${host}${port}${path.replace(TRAILING_SLASHES, '')}`;
}

/** `null` quando l'authority non è scomponibile, non quando l'host è assente. */
function hostOf(authority: string): string | null {
  if (authority.includes('[') !== authority.includes(']')) return null;
  const afterUserinfo = authority.slice(authority.lastIndexOf('@') + 1);
  if (afterUserinfo.includes('[')) {
    const bracketed = afterUserinfo.slice(afterUserinfo.indexOf('[') + 1);
    return bracketed.slice(0, bracketed.indexOf(']')).toLowerCase();
  }
  const colon = afterUserinfo.indexOf(':');
  return (colon < 0 ? afterUserinfo : afterUserinfo.slice(0, colon)).toLowerCase();
}

/** `""` quando la porta è assente o è lo zero, `null` quando è inaccettabile. */
function portOf(authority: string): string | null {
  const afterUserinfo = authority.slice(authority.lastIndexOf('@') + 1);
  const afterHost = afterUserinfo.includes('[')
    ? afterUserinfo.slice(afterUserinfo.indexOf(']') + 1)
    : afterUserinfo.slice(afterUserinfo.indexOf(':') >= 0 ? afterUserinfo.indexOf(':') : Infinity);
  const colon = afterHost.indexOf(':');
  if (colon < 0) return '';
  const digits = afterHost.slice(colon + 1);
  if (digits === '') return '';
  if (!ASCII_DIGITS.test(digits)) return null;
  const port = Number(digits);
  if (port > HIGHEST_PORT) return null;
  return port === 0 ? '' : `:${port}`;
}
