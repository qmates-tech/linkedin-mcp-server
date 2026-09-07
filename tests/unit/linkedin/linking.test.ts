import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QMateSubject } from '../../../src/fleet/acting-qmate.js';
import { LinkStore } from '../../../src/linkedin/link-store.js';
import { Linking, mintConfirmationCode, normalizeCode } from '../../../src/linkedin/linking.js';

const FABRIZIO = '106977126509011341120' as QMateSubject;
const ANOTHER_QMATE = '999888777666555444333' as QMateSubject;
const NOW = 1_757_000_000_000;
const REDIRECT = 'https://mcp-linkedin.qmates.tech/linkedin/callback';

interface FakeLinkedIn {
  fetch: ReturnType<typeof vi.fn>;
  exchangeStatus: number;
  userinfoStatus: number;
  refreshBody: Record<string, unknown> | null;
  member: { sub: string; name: string };
}

function fakeLinkedIn(): FakeLinkedIn {
  const linkedIn: FakeLinkedIn = {
    exchangeStatus: 200,
    userinfoStatus: 200,
    refreshBody: null,
    member: { sub: 'membro-di-fabrizio', name: 'Fabrizio Machella' },
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/accessToken')) {
        const grant = new URLSearchParams(String(init?.body)).get('grant_type');
        if (linkedIn.exchangeStatus !== 200) {
          return new Response('no', { status: linkedIn.exchangeStatus });
        }
        const body =
          grant === 'refresh_token' && linkedIn.refreshBody
            ? linkedIn.refreshBody
            : {
                access_token: `access-${grant}`,
                refresh_token: `refresh-${grant}`,
                expires_in: 5_184_000,
                refresh_token_expires_in: 31_536_000,
                scope: 'openid profile email w_member_social',
              };
        return json(body);
      }
      if (url.endsWith('/v2/userinfo')) {
        if (linkedIn.userinfoStatus !== 200) return new Response('no', { status: linkedIn.userinfoStatus });
        return json(linkedIn.member);
      }
      if (url.endsWith('/revoke')) return new Response('', { status: 200 });
      return new Response('rotta non prevista dal falso LinkedIn', { status: 404 });
    }),
  };
  return linkedIn;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

let store: LinkStore;
let linkedIn: FakeLinkedIn;
let linking: Linking;

beforeEach(() => {
  store = new LinkStore(':memory:', randomBytes(32));
  linkedIn = fakeLinkedIn();
  linking = new Linking({
    store,
    clientId: 'client-aziendale',
    clientSecret: 'segreto-aziendale',
    redirectUri: REDIRECT,
    fetch: linkedIn.fetch as unknown as typeof globalThis.fetch,
    now: () => NOW,
    newState: () => 'state-fisso',
    newConfirmationCode: () => 'K7M2QX9P',
  });
});

afterEach(() => {
  store.close();
});

describe('l URL di autorizzazione', () => {
  it('porta il nostro client, la nostra redirect e uno state', () => {
    const url = new URL(linking.beginLinking(FABRIZIO));
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(url.searchParams.get('client_id')).toBe('client-aziendale');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe('state-fisso');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  // Nel fork gli scope erano un parametro del tool, castato `as never`: chi
  // chiamava poteva chiederne qualunque, quindi non erano una policy del server.
  it('chiede gli scope che decide il server, e nessun altro', () => {
    const url = new URL(linking.beginLinking(FABRIZIO));
    expect(url.searchParams.get('scope')).toBe('openid profile email w_member_social');
  });

  it('non contiene il client secret', () => {
    expect(linking.beginLinking(FABRIZIO)).not.toContain('segreto-aziendale');
  });
});

describe('il consenso torna dal browser', () => {
  beforeEach(() => {
    linking.beginLinking(FABRIZIO);
  });

  it('parcheggia la credenziale e conia un codice, nominando chi ha consentito', async () => {
    const outcome = await linking.consentArrived('state-fisso', 'un-code');
    expect(outcome).toEqual({
      kind: 'awaiting_confirmation',
      confirmationCode: 'K7M2QX9P',
      memberName: 'Fabrizio Machella',
    });
  });

  it('non collega ancora niente: il consenso da solo non basta', async () => {
    await linking.consentArrived('state-fisso', 'un-code');
    expect(store.linkOf(FABRIZIO, NOW)).toEqual({ kind: 'absent' });
  });

  it('rifiuta uno state mai emesso senza nemmeno parlare con LinkedIn', async () => {
    const outcome = await linking.consentArrived('inventato', 'un-code');
    expect(outcome).toEqual({ kind: 'refused', because: 'unknown_or_used_state' });
    expect(linkedIn.fetch).not.toHaveBeenCalled();
  });

  it('rifiuta un replay dello stesso state', async () => {
    await linking.consentArrived('state-fisso', 'un-code');
    expect(await linking.consentArrived('state-fisso', 'un-code')).toEqual({
      kind: 'refused',
      because: 'unknown_or_used_state',
    });
  });

  // Express rende un array quando un parametro compare due volte nella query.
  // Trattarlo come stringa più avanti solleverebbe, e da un endpoint anonimo
  // un errore inatteso è una pagina di stack trace.
  it.each([
    ['uno state ripetuto', ['a', 'b'], 'un-code'],
    ['un code ripetuto', 'state-fisso', ['a', 'b']],
    ['uno state assente', undefined, 'un-code'],
    ['un code vuoto', 'state-fisso', ''],
  ])('rifiuta %s senza sollevare', async (_caso, state, code) => {
    expect(await linking.consentArrived(state, code)).toEqual({
      kind: 'refused',
      because: 'malformed_request',
    });
  });

  it('rifiuta se LinkedIn non scambia il code', async () => {
    linkedIn.exchangeStatus = 400;
    expect(await linking.consentArrived('state-fisso', 'un-code')).toEqual({
      kind: 'refused',
      because: 'exchange_refused',
    });
  });

  it('rifiuta se non riesce a sapere chi ha consentito', async () => {
    linkedIn.userinfoStatus = 403;
    expect(await linking.consentArrived('state-fisso', 'un-code')).toEqual({
      kind: 'refused',
      because: 'member_unreadable',
    });
  });
});

describe('la conferma dalla sessione del QMate', () => {
  beforeEach(async () => {
    linking.beginLinking(FABRIZIO);
    await linking.consentArrived('state-fisso', 'un-code');
  });

  it('scrive il collegamento e lo rende leggibile a lui', () => {
    expect(linking.confirmLinking(FABRIZIO, 'K7M2QX9P')).toEqual({
      kind: 'linked',
      linkedInMemberId: 'membro-di-fabrizio',
      scopes: ['openid', 'profile', 'email', 'w_member_social'],
    });
    const readout = store.linkOf(FABRIZIO, NOW);
    expect(readout.kind === 'linked' && readout.accessToken).toBe('access-authorization_code');
  });

  it('accetta il codice come lo si rilegge da uno schermo', () => {
    expect(linking.confirmLinking(FABRIZIO, ' k7m2-qx9p ').kind).toBe('linked');
  });

  // L'attacco: il QMate manda il proprio URL a un collega, il collega consente
  // in buona fede. Senza questo passo, la LinkedIn del collega finirebbe
  // agganciata alla riga di chi ha mandato l'URL, con w_member_social.
  it('un altro QMate col codice in mano non collega niente', () => {
    expect(linking.confirmLinking(ANOTHER_QMATE, 'K7M2QX9P')).toEqual({ kind: 'no_such_code' });
    expect(store.linkOf(ANOTHER_QMATE, NOW)).toEqual({ kind: 'absent' });
  });

  it('col codice sbagliato non collega niente', () => {
    expect(linking.confirmLinking(FABRIZIO, 'AAAAAAAA')).toEqual({ kind: 'no_such_code' });
    expect(store.linkOf(FABRIZIO, NOW)).toEqual({ kind: 'absent' });
  });

  it('dice cosa sta aspettando, prima che lui confermi', () => {
    expect(linking.awaitingConfirmation(FABRIZIO)).toEqual({ linkedInMemberId: 'membro-di-fabrizio' });
  });
});

describe('quando il membro entrante non è quello già collegato', () => {
  beforeEach(async () => {
    linking.beginLinking(FABRIZIO);
    await linking.consentArrived('state-fisso', 'un-code');
    linking.confirmLinking(FABRIZIO, 'K7M2QX9P');
    linkedIn.member = { sub: 'membro-di-qualcun-altro', name: 'Qualcun Altro' };
    linking.beginLinking(FABRIZIO);
    await linking.consentArrived('state-fisso', 'un-altro-code');
  });

  // È la forma che avrebbe un dirottamento riuscito, quindi non passa in silenzio.
  it('non sostituisce di soppiatto, e dice quale membro sostituirebbe', () => {
    expect(linking.confirmLinking(FABRIZIO, 'K7M2QX9P')).toEqual({
      kind: 'would_replace',
      current: 'membro-di-fabrizio',
      incoming: 'membro-di-qualcun-altro',
    });
  });

  it('e non brucia la credenziale: si può riprovare acconsentendo', () => {
    linking.confirmLinking(FABRIZIO, 'K7M2QX9P');
    expect(linking.confirmLinking(FABRIZIO, 'K7M2QX9P', true)).toEqual({
      kind: 'linked',
      linkedInMemberId: 'membro-di-qualcun-altro',
      scopes: ['openid', 'profile', 'email', 'w_member_social'],
    });
  });
});

describe('il rinnovo', () => {
  it('conserva il refresh token quando LinkedIn non ne rimanda uno', async () => {
    // Senza questo, un rinnovo cancellerebbe l'unica copia di ciò che tiene
    // vivo il grant, e il collegamento morirebbe alla scadenza successiva.
    linkedIn.refreshBody = { access_token: 'access-nuovo', expires_in: 5_184_000, scope: 'openid' };
    const renewed = await linking.renew('il-vecchio-refresh');
    expect(renewed?.accessToken).toBe('access-nuovo');
    expect(renewed?.refreshToken).toBe('il-vecchio-refresh');
  });

  it('rende null se LinkedIn ha ritirato il grant', async () => {
    linkedIn.exchangeStatus = 400;
    expect(await linking.renew('revocato')).toBeNull();
  });
});

describe('la revoca', () => {
  it('rende false invece di sollevare se la rete non risponde', async () => {
    const offline = new Linking({
      store,
      clientId: 'x',
      clientSecret: 'y',
      redirectUri: REDIRECT,
      fetch: (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof globalThis.fetch,
    });
    expect(await offline.revoke('un-token')).toBe(false);
  });
});

describe('il codice di conferma', () => {
  it('non contiene caratteri che un umano confonde', () => {
    const codes = Array.from({ length: 200 }, mintConfirmationCode).join('');
    expect(codes).not.toMatch(/[IO01]/);
    expect(codes).toMatch(/^[A-HJ-NP-Z2-9]+$/);
  });

  it('è lungo otto caratteri', () => {
    expect(mintConfirmationCode()).toHaveLength(8);
  });

  it('si confronta senza trattini, spazi e maiuscole', () => {
    expect(normalizeCode(' k7m2-qx9p ')).toBe('K7M2QX9P');
  });
});
