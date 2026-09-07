import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { canonicalResource } from '../../../src/fleet/audience.js';

/**
 * La fixture è generata da `scripts/audience-parity.py`, che esegue
 * `canonical_resource` dell'auth server su un corpus di ~6000 URI avversariali:
 * `urlsplit` è la colonna prodotta da Python, non da noi, quindi qui si asserisce
 * una parità fra due linguaggi e non la coerenza di questa implementazione con
 * se stessa.
 */
interface ParityCase {
  uri: string;
  /** La forma coniata da Python; `null` dove `urlsplit` solleva `ValueError`. */
  urlsplit: string | null;
  raises: boolean;
  /** Cosa deve rendere questa implementazione: la forma di Python, o `null`. */
  expected: string | null;
}

const PARITY: ParityCase[] = JSON.parse(
  readFileSync(new URL('../../fixtures/audience-parity.json', import.meta.url), 'utf8'),
) as ParityCase[];

describe('canonicalResource contro canonical_resource dell auth server', () => {
  it('rende la stessa forma di urlsplit su ogni caso di parità', () => {
    const divergenti = PARITY.filter((c) => c.expected !== null).flatMap((c) => {
      const ottenuto = canonicalResource(c.uri);
      return ottenuto === c.expected ? [] : [{ uri: c.uri, atteso: c.expected, ottenuto }];
    });
    expect(divergenti).toEqual([]);
  });

  // La proprietà che protegge davvero: un COLLASSO — due URI che l'AS considera
  // resource distinte ridotti alla stessa forma qui — farebbe entrare un token
  // coniato per l'una presentandolo all'altra. È il motivo per cui questa
  // funzione non usa `new URL()`, che normalizza e quindi collassa.
  it('non fa collassare due resource che urlsplit tiene distinte', () => {
    const originiPerForma = new Map<string, Set<string>>();
    for (const caso of PARITY) {
      if (caso.expected === null || caso.urlsplit === null) continue;
      const forme = originiPerForma.get(caso.expected) ?? new Set<string>();
      forme.add(caso.urlsplit);
      originiPerForma.set(caso.expected, forme);
    }
    const collassi = [...originiPerForma]
      .filter(([, forme]) => forme.size > 1)
      .map(([forma, forme]) => ({ forma, distinteInPython: [...forme] }));
    expect(collassi).toEqual([]);
  });

  it('rifiuta, e non approssima, ciò su cui urlsplit conia una forma degenere', () => {
    const accettatiPerErrore = PARITY.filter((c) => c.expected === null).flatMap((c) => {
      const ottenuto = canonicalResource(c.uri);
      return ottenuto === null ? [] : [{ uri: c.uri, urlsplit: c.urlsplit, ottenuto }];
    });
    expect(accettatiPerErrore).toEqual([]);
  });

  it('copre tutte e tre le classi, così una fixture svuotata non passa in silenzio', () => {
    expect({
      parità: PARITY.filter((c) => c.expected !== null).length,
      rifiutiSuFormaDegenere: PARITY.filter((c) => c.expected === null && !c.raises).length,
      rifiutiDoveUrlsplitSolleva: PARITY.filter((c) => c.raises).length,
    }).toEqual({ parità: 883, rifiutiSuFormaDegenere: 336, rifiutiDoveUrlsplitSolleva: 345 });
  });
});

// Gli stessi fatti della fixture, nella forma in cui un umano li legge: se uno di
// questi cambia, è la regola della flotta che è cambiata.
describe('la regola, in chiaro', () => {
  it.each([
    ['https://mcp-linkedin.qmates.tech/', 'https://mcp-linkedin.qmates.tech'],
    ['https://mcp-linkedin.qmates.tech///', 'https://mcp-linkedin.qmates.tech'],
    ['HTTPS://MCP-LinkedIn.QMates.Tech/', 'https://mcp-linkedin.qmates.tech'],
    ['https://mcp-linkedin.qmates.tech/MCP', 'https://mcp-linkedin.qmates.tech/MCP'],
    ['  https://mcp-linkedin.qmates.tech  ', 'https://mcp-linkedin.qmates.tech'],
    ['https://mcp-linkedin.qmates.tech:443', 'https://mcp-linkedin.qmates.tech:443'],
    ['https://mcp-linkedin.qmates.tech:0443/', 'https://mcp-linkedin.qmates.tech:443'],
    ['https://mcp-linkedin.qmates.tech?a=1', 'https://mcp-linkedin.qmates.tech'],
    ['https://user:pw@mcp-linkedin.qmates.tech/mcp', 'https://mcp-linkedin.qmates.tech/mcp'],
  ])('%s -> %s', (uri, forma) => {
    expect(canonicalResource(uri)).toBe(forma);
  });

  it('il path identifica una resource diversa', () => {
    expect(canonicalResource('https://mcp-linkedin.qmates.tech')).not.toBe(
      canonicalResource('https://mcp-linkedin.qmates.tech/mcp'),
    );
  });

  // `new URL()` risolverebbe i dot-segment e le farebbe combaciare: due voci di
  // QAS_AUDIENCES diventerebbero la stessa, e il token dell'una aprirebbe l'altra.
  it('non risolve i dot-segment, che per l AS sono parte del path', () => {
    expect(canonicalResource('https://mcp-linkedin.qmates.tech/a/../b')).toBe(
      'https://mcp-linkedin.qmates.tech/a/../b',
    );
  });

  it.each(['', '   ', 'mcp-linkedin.qmates.tech', 'https://', 'https://h:99999/mcp', 'https://[::1'])(
    'rifiuta %o',
    (uri) => {
      expect(canonicalResource(uri)).toBeNull();
    },
  );
});
