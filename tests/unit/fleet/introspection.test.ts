import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { actingQMate } from '../../../src/fleet/acting-qmate.js';
import { IntrospectionVerifier, type Refusal } from '../../../src/fleet/introspection.js';

const OUR_RESOURCE = 'https://mcp-linkedin.qmates.tech';
const THE_AS = 'https://auth.qmates.tech';
const A_QMATE = '106977126509011341120';

/** Il verdetto che l'AS della flotta conia davvero (authorization_server.py). */
function verdictFor(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    sub: A_QMATE,
    aud: OUR_RESOURCE,
    iss: THE_AS,
    token_type: 'Bearer',
    exp: 1757260800,
    ...overrides,
  };
}

let refusals: Array<{ refusal: Refusal; detail?: Record<string, unknown> }>;

function verifierAnswering(
  answer: (() => Promise<Response>) | Response,
  options: { now?: () => number } = {},
) {
  // `.clone()` a ogni giro: il corpo di una `Response` si legge una volta sola,
  // e i test sul tetto ne chiedono decine.
  const fetch = vi.fn(async () => (typeof answer === 'function' ? answer() : answer.clone()));
  const verifier = new IntrospectionVerifier({
    authorizationServer: THE_AS,
    resource: OUR_RESOURCE,
    clientId: 'mcp-linkedin',
    clientSecret: 'un-segreto',
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: options.now,
    record: (refusal, detail) => refusals.push({ refusal, detail }),
  });
  return { verifier, fetch };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  refusals = [];
});

describe('un verdetto valido', () => {
  it('rende il subject del QMate, ed è quello che i tool useranno come tenant', async () => {
    const { verifier } = verifierAnswering(jsonResponse(verdictFor()));
    const auth = await verifier.verifyAccessToken('opaco');
    expect(actingQMate(auth)).toBe(A_QMATE);
    expect(auth.expiresAt).toBe(1757260800);
    expect(refusals).toEqual([]);
  });

  it('si autentica come client confidenziale e manda il token nel corpo', async () => {
    const { verifier, fetch } = verifierAnswering(jsonResponse(verdictFor()));
    await verifier.verifyAccessToken('opaco');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${THE_AS}/introspect`);
    const headers = init.headers as Record<string, string>;
    expect(Buffer.from(headers.authorization!.slice('Basic '.length), 'base64').toString()).toBe(
      'mcp-linkedin:un-segreto',
    );
    expect(init.body).toBe('token=opaco');
  });

  it('accetta un aud che differisce solo per la forma, perché è la stessa resource', async () => {
    const { verifier } = verifierAnswering(
      jsonResponse(verdictFor({ aud: 'HTTPS://MCP-LinkedIn.QMates.Tech/' })),
    );
    await expect(verifier.verifyAccessToken('opaco')).resolves.toMatchObject({ expiresAt: 1757260800 });
  });
});

describe('audience binding', () => {
  it('rifiuta un token coniato per un altro servizio della flotta', async () => {
    const { verifier } = verifierAnswering(
      jsonResponse(verdictFor({ aud: 'https://mcp-council.qmates.tech' })),
    );
    await expect(verifier.verifyAccessToken('opaco')).rejects.toBeInstanceOf(InvalidTokenError);
    expect(refusals[0]?.refusal).toBe('other_audience');
  });

  it('rifiuta un aud che differisce per il path, che identifica una resource diversa', async () => {
    const { verifier } = verifierAnswering(jsonResponse(verdictFor({ aud: `${OUR_RESOURCE}/mcp` })));
    await expect(verifier.verifyAccessToken('opaco')).rejects.toBeInstanceOf(InvalidTokenError);
    expect(refusals[0]?.refusal).toBe('other_audience');
  });

  // RFC 7662 permette `aud` come array. L'AS ne conia sempre una sola stringa,
  // quindi un array è una violazione di contratto — ma trattarlo come stringa
  // solleverebbe un TypeError, e `requireBearerAuth` traduce qualunque cosa non
  // sia un OAuthError in 500 SENZA `WWW-Authenticate`: il client non scoprirebbe
  // più l'AS e non ritenterebbe il login.
  it('rifiuta un aud array con un 401, non con un 500', async () => {
    const { verifier } = verifierAnswering(jsonResponse(verdictFor({ aud: [OUR_RESOURCE] })));
    await expect(verifier.verifyAccessToken('opaco')).rejects.toBeInstanceOf(InvalidTokenError);
    expect(refusals[0]).toEqual({ refusal: 'other_audience', detail: { aud: 'object' } });
  });
});

describe('fail-closed su ogni confine', () => {
  it.each<[string, unknown, Refusal]>([
    ['un token revocato o scaduto', { active: false }, 'token_inactive'],
    ['un verdetto senza subject', verdictFor({ sub: undefined }), 'no_subject'],
    ['un subject vuoto', verdictFor({ sub: '' }), 'no_subject'],
    ['un verdetto senza scadenza', verdictFor({ exp: undefined }), 'no_expiry'],
    ['una scadenza non numerica', verdictFor({ exp: '1757260800' }), 'no_expiry'],
    ['un altro issuer', verdictFor({ iss: 'https://auth.example.com' }), 'other_issuer'],
    ['un corpo JSON null', null, 'verdict_unreadable'],
    ['un corpo JSON array', [], 'verdict_unreadable'],
    ['un corpo JSON scalare', 42, 'verdict_unreadable'],
  ])('rifiuta %s', async (_caso, body, atteso) => {
    const { verifier } = verifierAnswering(jsonResponse(body));
    await expect(verifier.verifyAccessToken('opaco')).rejects.toBeInstanceOf(InvalidTokenError);
    expect(refusals[0]?.refusal).toBe(atteso);
  });

  it('rifiuta un corpo che non è JSON', async () => {
    const { verifier } = verifierAnswering(new Response('<html>502</html>', { status: 200 }));
    await expect(verifier.verifyAccessToken('opaco')).rejects.toBeInstanceOf(InvalidTokenError);
    expect(refusals[0]?.refusal).toBe('verdict_unreadable');
  });

  it('rifiuta quando l AS è irraggiungibile, invece di accettare', async () => {
    const { verifier } = verifierAnswering(() => Promise.reject(new TypeError('fetch failed')));
    await expect(verifier.verifyAccessToken('opaco')).rejects.toBeInstanceOf(InvalidTokenError);
    expect(refusals[0]).toEqual({ refusal: 'as_unreachable', detail: { cause: 'TypeError' } });
  });

  it('distingue nel log un AS rotto da un nostro secret sbagliato', async () => {
    const rotto = verifierAnswering(jsonResponse({ error: 'boom' }, 503));
    await expect(rotto.verifier.verifyAccessToken('opaco')).rejects.toThrow();
    const respinti = verifierAnswering(jsonResponse({ error: 'invalid_client' }, 401));
    await expect(respinti.verifier.verifyAccessToken('opaco')).rejects.toThrow();
    expect(refusals.map((r) => r.refusal)).toEqual(['as_unreachable', 'as_refused_us']);
  });

  it('dice sempre la stessa cosa al chiamante, qualunque sia il motivo', async () => {
    const motivi = [jsonResponse({ active: false }), jsonResponse(verdictFor({ aud: 'https://altro' }))];
    const messaggi: string[] = [];
    for (const risposta of motivi) {
      const { verifier } = verifierAnswering(risposta);
      await verifier.verifyAccessToken('opaco').catch((rifiuto: Error) => messaggi.push(rifiuto.message));
    }
    expect(new Set(messaggi).size).toBe(1);
  });

  it('non scrive il token nel log del rifiuto', async () => {
    const { verifier } = verifierAnswering(() => Promise.reject(new Error('POST https://as/introspect?token=segretissimo')));
    await expect(verifier.verifyAccessToken('segretissimo')).rejects.toThrow();
    expect(JSON.stringify(refusals)).not.toContain('segretissimo');
  });
});

describe('tetto sulle introspection generate', () => {
  it('smette di chiamare l AS quando il burst si esaurisce, e non accetta nessuno', async () => {
    let adesso = 1_000_000;
    const { verifier, fetch } = verifierAnswering(jsonResponse(verdictFor()), { now: () => adesso });
    for (let i = 0; i < 60; i += 1) await verifier.verifyAccessToken('opaco');
    expect(fetch).toHaveBeenCalledTimes(60);

    await expect(verifier.verifyAccessToken('opaco')).rejects.toBeInstanceOf(InvalidTokenError);
    expect(fetch).toHaveBeenCalledTimes(60);
    expect(refusals.at(-1)?.refusal).toBe('introspections_exhausted');

    adesso += 1000;
    await expect(verifier.verifyAccessToken('opaco')).resolves.toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(61);
  });
});
