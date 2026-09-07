import { randomBytes } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LinkedInApi } from '../../src/client/api-client.js';
import type { QMateSubject } from '../../src/fleet/acting-qmate.js';
import { LinkStore } from '../../src/linkedin/link-store.js';
import { LinkedInLinks } from '../../src/linkedin/link.js';
import { Linking } from '../../src/linkedin/linking.js';
import { PublishedPostsStore } from '../../src/linkedin/published-posts.js';
import { mcpServerFor } from '../../src/server.js';
import { LinkedInApiMock } from '../mocks/linkedin-api-mock.js';

const FABRIZIO = '106977126509011341120' as QMateSubject;
const ANOTHER_QMATE = '999888777666555444333' as QMateSubject;
const A_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

const mock = new LinkedInApiMock();
let linkedInUrl: string;

beforeAll(async () => {
  await mock.start();
  linkedInUrl = `http://127.0.0.1:${mock.port}`;
  // LinkedIn indica un URL di upload sul proprio dominio; l'allowlist lo
  // accetta, e qui lo si fa atterrare sul mock invece che su Internet.
  mock.addRoute('PUT /upload/image', () => ({ status: 201 }));
});

afterAll(async () => {
  await mock.stop();
});

interface Fixture {
  store: LinkStore;
  linking: Linking;
  serverFor: (qmate: QMateSubject) => ReturnType<ReturnType<typeof mcpServerFor>>;
}

function freshService(): Fixture {
  const store = new LinkStore(':memory:', randomBytes(32));
  const linking = new Linking({
    store,
    clientId: 'client-aziendale',
    clientSecret: 'segreto-aziendale',
    redirectUri: 'https://mcp-linkedin.qmates.tech/linkedin/callback',
    authBaseUrl: `${linkedInUrl}/oauth/v2`,
    apiBaseUrl: linkedInUrl,
  });
  const linkedIn = new LinkedInApi({
    baseUrl: linkedInUrl,
    maxRetries: 0,
    fetch: async (input, init) => {
      const url = String(input).replace('https://mock-upload.linkedin.com', linkedInUrl);
      return globalThis.fetch(url, init);
    },
  });
  return {
    store,
    linking,
    serverFor: mcpServerFor({
      links: new LinkedInLinks(store, linking),
      linking,
      publishedPosts: new PublishedPostsStore(store.database),
      linkedIn,
    }),
  };
}

async function sessionFor(fixture: Fixture, qmate: QMateSubject): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'prova', version: '0' });
  await Promise.all([client.connect(clientSide), fixture.serverFor(qmate).connect(serverSide)]);
  return client;
}

/** Percorre tutto il flusso: avvio, consenso nel browser, conferma in sessione. */
async function linkLinkedIn(fixture: Fixture, qmate: QMateSubject, member: string): Promise<void> {
  const restoreProfile = mock.overrideRoute('GET /v2/userinfo', () => ({
    status: 200,
    body: { sub: member, name: `Membro ${member}` },
  }));
  // Un token riconoscibile per membro: il mock, di suo, ne conia uno che
  // dipende dal millisecondo, quindi due collegamenti vicini ne ricevono uno
  // identico e l asserzione sull isolamento del bearer non proverebbe nulla.
  const restoreToken = mock.overrideRoute('POST /oauth/v2/accessToken', () => ({
    status: 200,
    body: {
      access_token: `access-for-${member}`,
      refresh_token: `refresh-for-${member}`,
      expires_in: 5_184_000,
      scope: 'openid profile email w_member_social',
    },
  }));
  const authorization = new URL(fixture.linking.beginLinking(qmate));
  const consent = await fixture.linking.consentArrived(authorization.searchParams.get('state'), 'un-code');
  restoreProfile();
  restoreToken();
  if (consent.kind !== 'awaiting_confirmation') throw new Error(`consenso rifiutato: ${consent.because}`);
  const confirmed = fixture.linking.confirmLinking(qmate, consent.confirmationCode);
  if (confirmed.kind !== 'linked') throw new Error(`conferma rifiutata: ${confirmed.kind}`);
}

async function textOf(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const answer = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return answer.content.map((part) => part.text).join('\n');
}

let fixture: Fixture;

beforeEach(() => {
  mock.clearRequestLog();
  fixture = freshService();
});

describe('la superficie dei tool', () => {
  it('espone i quindici tool della flotta', async () => {
    const client = await sessionFor(fixture, FABRIZIO);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'linkedin_create_comment',
      'linkedin_create_event',
      'linkedin_create_post',
      'linkedin_delete_post',
      'linkedin_get_event',
      'linkedin_get_my_email',
      'linkedin_get_my_profile',
      'linkedin_get_my_quotas',
      'linkedin_link_confirm',
      'linkedin_link_start',
      'linkedin_link_status',
      'linkedin_list_my_posts',
      'linkedin_react_to_post',
      'linkedin_unlink',
      'linkedin_upload_image',
    ]);
    await client.close();
  });

  // Standard §4: da remoto quel disco è del SERVIZIO, non del QMate. Si legge
  // dagli schemi che il client riceve davvero, non da un campo privato dell SDK.
  it('non chiede un percorso locale in nessuno schema', async () => {
    const client = await sessionFor(fixture, FABRIZIO);
    const { tools } = await client.listTools();
    const suspicious = tools.flatMap((tool) =>
      Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
        .filter((property) => /path|file|dir|filename/i.test(property))
        .map((property) => `${tool.name}.${property}`),
    );
    expect(suspicious).toEqual([]);
    await client.close();
  });

  it('dice al QMate cosa fare, finché non ha collegato', async () => {
    const client = await sessionFor(fixture, FABRIZIO);
    expect(await textOf(client, 'linkedin_link_status')).toContain('linkedin_link_start');
    expect(await textOf(client, 'linkedin_get_my_profile')).toContain('linkedin_link_start');
    expect(await textOf(client, 'linkedin_create_post', { text: 'ciao' })).toContain('linkedin_link_start');
    await client.close();
  });
});

describe('un QMate collegato', () => {
  let client: Client;

  beforeEach(async () => {
    await linkLinkedIn(fixture, FABRIZIO, 'membro-di-fabrizio');
    client = await sessionFor(fixture, FABRIZIO);
  });

  it('si vede collegato, col proprio membro', async () => {
    const status = JSON.parse(await textOf(client, 'linkedin_link_status')) as Record<string, unknown>;
    expect(status).toMatchObject({ collegato: true, membroLinkedIn: 'membro-di-fabrizio', puoiPubblicare: true });
  });

  it('legge il proprio profilo', async () => {
    const profile = JSON.parse(await textOf(client, 'linkedin_get_my_profile')) as Record<string, unknown>;
    expect(profile).toMatchObject({ email: 'test@example.com' });
  });

  it('pubblica un post attribuito al proprio membro', async () => {
    const published = JSON.parse(await textOf(client, 'linkedin_create_post', { text: 'un post' })) as {
      pubblicato: boolean;
    };
    expect(published.pubblicato).toBe(true);
    const posted = mock.getRequestLog().find((request) => request.path === '/v2/posts');
    expect(JSON.parse(posted!.body)).toMatchObject({ author: 'urn:li:person:membro-di-fabrizio' });
  });

  it('ritrova il post nel proprio elenco', async () => {
    await textOf(client, 'linkedin_create_post', { text: 'da ritrovare' });
    expect(await textOf(client, 'linkedin_list_my_posts')).toContain('da ritrovare');
  });

  // Nel fork i due rami assegnavano entrambi `content`: passando un articolo e
  // un immagine, l articolo spariva senza che nessuno lo dicesse.
  it('rifiuta un post con articolo E immagine, invece di scartarne uno', async () => {
    const refusal = await textOf(client, 'linkedin_create_post', {
      text: 'x',
      articleUrl: 'https://qmates.tech',
      imageUrn: 'urn:li:image:abc',
    });
    expect(refusal).toContain('non entrambi');
  });

  it('rifiuta un urn di immagine che non è un urn di immagine', async () => {
    expect(await textOf(client, 'linkedin_create_post', { text: 'x', imageUrn: '../../etc/passwd' })).toContain(
      'urn di immagine',
    );
  });

  it('carica un immagine dai byte, riconoscendone il tipo senza un nome di file', async () => {
    const uploaded = JSON.parse(
      await textOf(client, 'linkedin_upload_image', { imageBase64: A_PNG.toString('base64') }),
    ) as { caricata: boolean; tipo: string };
    expect(uploaded).toMatchObject({ caricata: true, tipo: 'image/png' });
    const initialized = mock.getRequestLog().find((request) => request.path.startsWith('/v2/images'));
    expect(JSON.parse(initialized!.body)).toMatchObject({
      initializeUploadRequest: { owner: 'urn:li:person:membro-di-fabrizio' },
    });
  });

  it('rifiuta byte che non sono un immagine', async () => {
    const refusal = await textOf(client, 'linkedin_upload_image', {
      imageBase64: Buffer.from('questo e testo, non un immagine').toString('base64'),
    });
    expect(refusal).toContain('non sono un JPEG');
  });

  it('commenta e reagisce come il proprio membro', async () => {
    await textOf(client, 'linkedin_create_comment', { postUrn: 'urn:li:share:1', text: 'bel post' });
    const commented = mock.getRequestLog().find((request) => request.path.includes('/comments'));
    expect(JSON.parse(commented!.body)).toMatchObject({ actor: 'urn:li:person:membro-di-fabrizio' });
  });

  it('crea un evento come organizzatore', async () => {
    await textOf(client, 'linkedin_create_event', { name: 'Un evento', startDate: '2026-10-01T10:00:00Z' });
    const created = mock.getRequestLog().find((request) => request.path === '/v2/events');
    expect(JSON.parse(created!.body)).toMatchObject({ organizer: 'urn:li:person:membro-di-fabrizio' });
  });

  it('riporta solo le proprie quote', async () => {
    await textOf(client, 'linkedin_get_my_profile');
    expect(await textOf(client, 'linkedin_get_my_quotas')).toContain('/v2/userinfo');
  });
});

// Il test che il fork non poteva avere: la sua identità era un `let` di
// processo, quindi due QMate nello stesso processo erano lo stesso autore.
describe('due QMate nello stesso processo', () => {
  beforeEach(async () => {
    await linkLinkedIn(fixture, FABRIZIO, 'membro-di-fabrizio');
    await linkLinkedIn(fixture, ANOTHER_QMATE, 'membro-di-lei');
  });

  it('pubblicano ognuno sul proprio profilo, con il proprio token', async () => {
    const his = await sessionFor(fixture, FABRIZIO);
    const hers = await sessionFor(fixture, ANOTHER_QMATE);
    mock.clearRequestLog();

    await Promise.all([
      textOf(his, 'linkedin_create_post', { text: 'il suo post' }),
      textOf(hers, 'linkedin_create_post', { text: 'il post di lei' }),
    ]);

    const posted = mock.getRequestLog().filter((request) => request.path === '/v2/posts');
    expect(posted).toHaveLength(2);
    const authors = posted.map((request) => (JSON.parse(request.body) as { author: string }).author).sort();
    expect(authors).toEqual(['urn:li:person:membro-di-fabrizio', 'urn:li:person:membro-di-lei']);
    // Ogni richiesta ha portato il token del PROPRIO membro: l urn dell autore
    // e il bearer vengono dallo stesso collegamento e non possono divergere.
    const carried = posted.map((request) => ({
      author: (JSON.parse(request.body) as { author: string }).author,
      bearer: request.headers.authorization,
    }));
    for (const { author, bearer } of carried) {
      const member = author.replace('urn:li:person:', '');
      expect(bearer).toBe(`Bearer access-for-${member}`);
    }

    await his.close();
    await hers.close();
  });

  it('non vedono i post l uno dell altro', async () => {
    const his = await sessionFor(fixture, FABRIZIO);
    const hers = await sessionFor(fixture, ANOTHER_QMATE);
    await textOf(his, 'linkedin_create_post', { text: 'solo suo' });

    expect(await textOf(hers, 'linkedin_list_my_posts')).toContain('Nessun post');
    expect(await textOf(his, 'linkedin_list_my_posts')).toContain('solo suo');

    await his.close();
    await hers.close();
  });

  it('scollegarsi non stacca l altro', async () => {
    const his = await sessionFor(fixture, FABRIZIO);
    const hers = await sessionFor(fixture, ANOTHER_QMATE);

    await textOf(his, 'linkedin_unlink');
    expect(await textOf(his, 'linkedin_link_status')).toContain('linkedin_link_start');
    expect(await textOf(hers, 'linkedin_link_status')).toContain('membro-di-lei');

    await his.close();
    await hers.close();
  });
});
