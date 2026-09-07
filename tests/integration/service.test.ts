import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { QMateSubject } from '../../src/fleet/acting-qmate.js';
import {
  LINKEDIN_CALLBACK_PATH,
  PROTECTED_RESOURCE_METADATA_PATH,
  type ServiceConfiguration,
} from '../../src/fleet/configuration.js';
import { IntrospectionVerifier } from '../../src/fleet/introspection.js';
import { LinkStore } from '../../src/linkedin/link-store.js';
import { Linking } from '../../src/linkedin/linking.js';
import { buildService } from '../../src/service.js';

const OUR_RESOURCE = 'https://mcp-linkedin.qmates.tech';
const THE_AS = 'https://auth.qmates.tech';
const A_QMATE = '106977126509011341120';
const ANOTHER_QMATE = '999888777666555444333';

const configuration: ServiceConfiguration = {
  resource: OUR_RESOURCE,
  authorizationServer: THE_AS,
  introspection: { clientId: 'mcp-linkedin', clientSecret: 'un-segreto' },
  linkedIn: { clientId: 'x', clientSecret: 'y', redirectUri: `${OUR_RESOURCE}/linkedin/callback` },
  tokenKey: Buffer.alloc(32),
  databasePath: ':memory:',
  port: 0,
};

/** L'AS della flotta, simulato con i verdetti che conia davvero. */
const authorizationServer = async (_url: string, init?: RequestInit): Promise<Response> => {
  const token = new URLSearchParams(String(init?.body)).get('token') ?? '';
  const verdicts: Record<string, unknown> = {
    [`per-${A_QMATE}`]: { active: true, sub: A_QMATE, aud: OUR_RESOURCE, iss: THE_AS, exp: farFuture() },
    [`per-${ANOTHER_QMATE}`]: { active: true, sub: ANOTHER_QMATE, aud: OUR_RESOURCE, iss: THE_AS, exp: farFuture() },
    'per-il-council': { active: true, sub: A_QMATE, aud: 'https://mcp-council.qmates.tech', iss: THE_AS, exp: farFuture() },
    revocato: { active: false },
  };
  return new Response(JSON.stringify(verdicts[token] ?? { active: false }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

const store = new LinkStore(':memory:', Buffer.alloc(32, 3));

/** Un LinkedIn finto che consente sempre, con un nome ostile di proposito. */
const linkedIn = async (url: string): Promise<Response> => {
  const body = url.endsWith('/v2/userinfo')
    ? { sub: 'membro-1', name: '<script>alert(1)</script> Machella' }
    : { access_token: 'a', refresh_token: 'r', expires_in: 5_184_000, scope: 'openid' };
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
};

const linking = new Linking({
  store,
  clientId: 'client-aziendale',
  clientSecret: 'segreto-aziendale',
  redirectUri: `${OUR_RESOURCE}${LINKEDIN_CALLBACK_PATH}`,
  fetch: linkedIn as unknown as typeof globalThis.fetch,
});

const service = buildService({
  configuration,
  linking,
  verifier: new IntrospectionVerifier({
    authorizationServer: THE_AS,
    resource: OUR_RESOURCE,
    clientId: 'mcp-linkedin',
    clientSecret: 'un-segreto',
    fetch: authorizationServer as unknown as typeof globalThis.fetch,
    record: () => {},
  }),
  // Il subject è legato alla costruzione: il tool non lo riceve e non può sbagliarlo.
  mcpServerFor: (qmate: QMateSubject) => {
    const server = new McpServer({ name: 'prova', version: '0' });
    server.tool('per_chi_agisco', 'Il QMate dietro questa richiesta.', {}, () => ({
      content: [{ type: 'text' as const, text: qmate }],
    }));
    return server;
  },
});

let listening: ReturnType<typeof service.listen>;
let origin: string;

beforeAll(async () => {
  await new Promise<void>((ready) => {
    listening = service.listen(0, '127.0.0.1', ready);
  });
  origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((closed) => listening.close(() => closed()));
});

async function askAsQMate(token: string): Promise<string> {
  const client = new Client({ name: 'prova', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const answer = (await client.callTool({ name: 'per_chi_agisco', arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    return answer.content[0]!.text;
  } finally {
    await client.close();
  }
}

describe('salute', () => {
  it('risponde senza toccare nessuna dipendenza', async () => {
    const answer = await fetch(`${origin}/healthz`);
    expect(answer.status).toBe(200);
    await expect(answer.json()).resolves.toEqual({ status: 'ok' });
  });

  it('non racconta quanti QMate hanno collegato LinkedIn', async () => {
    // Il frammento Caddy non ha matcher di path: tutto quello che sta qui è
    // pubblico su Internet.
    const body = await (await fetch(`${origin}/healthz`)).text();
    expect(body).not.toMatch(/\d{2,}/);
  });
});

describe('metadata della resource protetta, RFC 9728', () => {
  it('dichiara la nostra resource e l AS che la protegge', async () => {
    const answer = await fetch(`${origin}${PROTECTED_RESOURCE_METADATA_PATH}`);
    expect(answer.status).toBe(200);
    await expect(answer.json()).resolves.toEqual({
      resource: OUR_RESOURCE,
      authorization_servers: [THE_AS],
      bearer_methods_supported: ['header'],
    });
  });

  it('non aggiunge lo slash finale che l AS non ha in QAS_AUDIENCES', async () => {
    const { resource } = (await (await fetch(`${origin}${PROTECTED_RESOURCE_METADATA_PATH}`)).json()) as {
      resource: string;
    };
    expect(resource.endsWith('/')).toBe(false);
  });
});

describe('senza un bearer valido', () => {
  it('risponde 401 dicendo al client dove trovare la metadata', async () => {
    const answer = await fetch(`${origin}/mcp`, { method: 'POST' });
    expect(answer.status).toBe(401);
    expect(answer.headers.get('www-authenticate')).toContain(
      `resource_metadata="${OUR_RESOURCE}${PROTECTED_RESOURCE_METADATA_PATH}"`,
    );
  });

  // L'ordine dei middleware è la proprietà: se il parser del corpo girasse
  // prima, questo JSON rotto darebbe 400 — cioè una richiesta anonima sarebbe
  // stata bufferizzata e deserializzata prima di essere rifiutata.
  it('rifiuta prima di leggere il corpo', async () => {
    const answer = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ questo non è json',
    });
    expect(answer.status).toBe(401);
  });

  it('rifiuta un token revocato', async () => {
    await expect(askAsQMate('revocato')).rejects.toThrow();
  });

  it('rifiuta un token coniato per il council, che è un altra resource', async () => {
    await expect(askAsQMate('per-il-council')).rejects.toThrow();
  });
});

describe('con un bearer valido', () => {
  it('esegue il tool come il QMate che l AS ha nominato', async () => {
    await expect(askAsQMate(`per-${A_QMATE}`)).resolves.toBe(A_QMATE);
  });

  it('due QMate nella stessa istanza non si scambiano identità', async () => {
    const [primo, secondo] = await Promise.all([
      askAsQMate(`per-${A_QMATE}`),
      askAsQMate(`per-${ANOTHER_QMATE}`),
    ]);
    expect([primo, secondo]).toEqual([A_QMATE, ANOTHER_QMATE]);
  });
});

describe('metodi che questo servizio non serve', () => {
  it('dice 405 invece di 404, che somiglierebbe a un path sbagliato', async () => {
    const answer = await fetch(`${origin}/mcp`, { method: 'DELETE' });
    expect(answer.status).toBe(405);
  });
});

describe('il callback di LinkedIn, l unico endpoint anonimo', () => {
  it('mostra il codice e nomina chi si sta collegando', async () => {
    const url = new URL(linking.beginLinking(A_QMATE as QMateSubject));
    const state = url.searchParams.get('state')!;
    const answer = await fetch(`${origin}${LINKEDIN_CALLBACK_PATH}?state=${state}&code=un-code`);
    expect(answer.status).toBe(200);
    const page = await answer.text();
    expect(page).toMatch(/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/);
    expect(page).toContain('non dare il codice a nessuno');
  });

  it('non fa cachare il codice a nessuno', async () => {
    const url = new URL(linking.beginLinking(A_QMATE as QMateSubject));
    const answer = await fetch(
      `${origin}${LINKEDIN_CALLBACK_PATH}?state=${url.searchParams.get('state')}&code=c`,
    );
    expect(answer.headers.get('cache-control')).toContain('no-store');
  });

  // Il nome del membro arriva da LinkedIn: è testo di terzi.
  it('non esegue il nome che LinkedIn restituisce', async () => {
    const url = new URL(linking.beginLinking(A_QMATE as QMateSubject));
    const page = await (
      await fetch(`${origin}${LINKEDIN_CALLBACK_PATH}?state=${url.searchParams.get('state')}&code=c`)
    ).text();
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&lt;script&gt;');
  });

  // Un endpoint anonimo che distingue i motivi dice a chi tira a indovinare
  // quanto si è avvicinato.
  it('rende la stessa pagina per ogni fallimento', async () => {
    const stateMaiEmesso = await fetch(`${origin}${LINKEDIN_CALLBACK_PATH}?state=inventato&code=c`);
    const consensoNegato = await fetch(
      `${origin}${LINKEDIN_CALLBACK_PATH}?error=user_cancelled_login&state=x`,
    );
    const senzaParametri = await fetch(`${origin}${LINKEDIN_CALLBACK_PATH}`);
    const stateRipetuto = await fetch(`${origin}${LINKEDIN_CALLBACK_PATH}?state=a&state=b&code=c`);
    const pagine = await Promise.all(
      [stateMaiEmesso, consensoNegato, senzaParametri, stateRipetuto].map((r) => r.text()),
    );
    expect([stateMaiEmesso, consensoNegato, senzaParametri, stateRipetuto].map((r) => r.status)).toEqual([
      400, 400, 400, 400,
    ]);
    expect(new Set(pagine).size).toBe(1);
  });
});
