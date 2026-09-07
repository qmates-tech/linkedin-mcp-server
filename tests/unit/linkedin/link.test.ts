import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QMateSubject } from '../../../src/fleet/acting-qmate.js';
import { LinkStore, type LinkedInCredential } from '../../../src/linkedin/link-store.js';
import { LinkedInLinks, LinkNoLongerValid, NotLinked } from '../../../src/linkedin/link.js';
import type { Linking } from '../../../src/linkedin/linking.js';
import { seal } from '../../../src/linkedin/sealed-secret.js';

const KEY = randomBytes(32);
const FABRIZIO = '106977126509011341120' as QMateSubject;
const ANOTHER_QMATE = '999888777666555444333' as QMateSubject;
const HIS_MEMBER = 'membro-abc';
const NOW = 1_757_000_000_000;

function credential(overrides: Partial<LinkedInCredential> = {}): LinkedInCredential {
  return {
    accessToken: 'access-corrente',
    refreshToken: 'refresh-corrente',
    scopes: ['w_member_social'],
    accessExpiresAt: NOW + 60 * 24 * 3600 * 1000,
    ...overrides,
  };
}

let store: LinkStore;
let renew: ReturnType<typeof vi.fn>;
let revoke: ReturnType<typeof vi.fn>;
let awaitingConfirmation: ReturnType<typeof vi.fn>;
let links: LinkedInLinks;

beforeEach(() => {
  store = new LinkStore(':memory:', KEY);
  renew = vi.fn(async () => credential({ accessToken: 'access-rinnovato', refreshToken: 'refresh-ruotato' }));
  revoke = vi.fn(async () => true);
  awaitingConfirmation = vi.fn(() => null);
  links = new LinkedInLinks(store, { renew, revoke, awaitingConfirmation } as unknown as Linking, () => NOW);
});

afterEach(() => {
  store.close();
});

describe('lo stato del collegamento', () => {
  it('è assente per un QMate che non ha mai collegato', () => {
    expect(links.of(FABRIZIO).state()).toEqual({ kind: 'absent' });
  });

  it('dice che c è qualcosa da confermare, quando c è', () => {
    awaitingConfirmation.mockReturnValue({ linkedInMemberId: HIS_MEMBER });
    expect(links.of(FABRIZIO).state()).toEqual({
      kind: 'awaiting_confirmation',
      linkedInMemberId: HIS_MEMBER,
    });
  });

  it('è collegato dopo una conferma', () => {
    store.rememberLink(FABRIZIO, HIS_MEMBER, credential(), NOW);
    const state = links.of(FABRIZIO).state();
    expect(state.kind).toBe('linked');
    expect(state.kind === 'linked' && state.summary.linkedInMemberId).toBe(HIS_MEMBER);
  });

  it('è illeggibile se la chiave è cambiata, e non un errore', () => {
    store.rememberLink(FABRIZIO, HIS_MEMBER, credential(), NOW);
    store.database
      .prepare('UPDATE linkedin_link SET access_token_sealed = ? WHERE qmate_subject = ?')
      .run(seal(randomBytes(32), 'x', FABRIZIO), FABRIZIO);
    expect(links.of(FABRIZIO).state()).toEqual({ kind: 'unreadable', linkedInMemberId: HIS_MEMBER });
  });
});

describe('l urn dell autore', () => {
  it('nomina il membro collegato a QUESTO QMate', () => {
    store.rememberLink(FABRIZIO, HIS_MEMBER, credential(), NOW);
    store.rememberLink(ANOTHER_QMATE, 'membro-xyz', credential(), NOW);
    expect(links.of(FABRIZIO).personUrn()).toBe(`urn:li:person:${HIS_MEMBER}`);
    expect(links.of(ANOTHER_QMATE).personUrn()).toBe('urn:li:person:membro-xyz');
  });

  it('solleva invece di comporre un urn vuoto', () => {
    expect(() => links.of(FABRIZIO).personUrn()).toThrow(NotLinked);
  });
});

describe('il bearer verso LinkedIn', () => {
  it('è quello memorizzato, se è ancora buono', async () => {
    store.rememberLink(FABRIZIO, HIS_MEMBER, credential(), NOW);
    await expect(links.of(FABRIZIO).accessToken()).resolves.toBe('access-corrente');
    expect(renew).not.toHaveBeenCalled();
  });

  it('si rinnova prima della scadenza, e il nuovo resta memorizzato', async () => {
    store.rememberLink(FABRIZIO, HIS_MEMBER, credential({ accessExpiresAt: NOW + 1000 }), NOW);
    await expect(links.of(FABRIZIO).accessToken()).resolves.toBe('access-rinnovato');
    const readout = store.linkOf(FABRIZIO, NOW);
    expect(readout.kind === 'linked' && readout.accessToken).toBe('access-rinnovato');
    expect(readout.kind === 'linked' && readout.refreshToken).toBe('refresh-ruotato');
  });

  // Il fork, davanti a un 401 di LinkedIn, ripresentava QUATTRO volte lo stesso
  // token morto con backoff esponenziale: il rinnovo scattava solo sull'orologio
  // locale, mai su un rifiuto vero.
  it('si rinnova anche su un rifiuto di LinkedIn, non solo sull orologio', async () => {
    store.rememberLink(FABRIZIO, HIS_MEMBER, credential(), NOW);
    await expect(links.of(FABRIZIO).accessToken(true)).resolves.toBe('access-rinnovato');
    expect(renew).toHaveBeenCalledOnce();
  });

  // LinkedIn ruota il refresh token a ogni rinnovo: due rinnovi concorrenti si
  // invaliderebbero a vicenda e il collegamento morirebbe da solo.
  it('rinnova una volta sola anche se due richieste arrivano insieme', async () => {
    store.rememberLink(FABRIZIO, HIS_MEMBER, credential({ accessExpiresAt: NOW + 1000 }), NOW);
    const [primo, secondo] = await Promise.all([
      links.of(FABRIZIO).accessToken(),
      links.of(FABRIZIO).accessToken(),
    ]);
    expect([primo, secondo]).toEqual(['access-rinnovato', 'access-rinnovato']);
    expect(renew).toHaveBeenCalledOnce();
  });

  it('due QMate che rinnovano insieme non si intralciano', async () => {
    store.rememberLink(FABRIZIO, HIS_MEMBER, credential({ accessExpiresAt: NOW + 1000 }), NOW);
    store.rememberLink(ANOTHER_QMATE, 'membro-xyz', credential({ accessExpiresAt: NOW + 1000 }), NOW);
    await Promise.all([links.of(FABRIZIO).accessToken(), links.of(ANOTHER_QMATE).accessToken()]);
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('dice al QMate cosa fare se non ha collegato', async () => {
    await expect(links.of(FABRIZIO).accessToken()).rejects.toBeInstanceOf(NotLinked);
    await expect(links.of(FABRIZIO).accessToken()).rejects.toThrow(/linkedin_link_start/);
  });

  it('tratta un sigillo che non si apre come un collegamento da rifare', async () => {
    store.rememberLink(FABRIZIO, HIS_MEMBER, credential(), NOW);
    store.database
      .prepare('UPDATE linkedin_link SET access_token_sealed = ? WHERE qmate_subject = ?')
      .run(seal(randomBytes(32), 'x', FABRIZIO), FABRIZIO);
    await expect(links.of(FABRIZIO).accessToken()).rejects.toBeInstanceOf(NotLinked);
  });

  it('dice che il grant è finito se LinkedIn rifiuta il rinnovo', async () => {
    renew.mockResolvedValue(null);
    store.rememberLink(FABRIZIO, HIS_MEMBER, credential({ accessExpiresAt: NOW + 1000 }), NOW);
    await expect(links.of(FABRIZIO).accessToken()).rejects.toBeInstanceOf(LinkNoLongerValid);
  });

  it('e anche se non c è un refresh token da usare', async () => {
    store.rememberLink(
      FABRIZIO,
      HIS_MEMBER,
      credential({ refreshToken: undefined, accessExpiresAt: NOW + 1000 }),
      NOW,
    );
    await expect(links.of(FABRIZIO).accessToken()).rejects.toBeInstanceOf(LinkNoLongerValid);
  });
});

describe('scollegarsi', () => {
  beforeEach(() => {
    store.rememberLink(FABRIZIO, HIS_MEMBER, credential(), NOW);
  });

  // Il fork revocava l'ACCESS token e poi cancellava la riga: il refresh
  // restava valido per mesi, senza piu una copia con cui revocarlo.
  it('revoca ciò che tiene vivo il grant, non l access token', async () => {
    await links.of(FABRIZIO).forget();
    expect(revoke).toHaveBeenCalledWith('refresh-corrente');
  });

  it('cancella il collegamento anche se la revoca fallisce', async () => {
    revoke.mockResolvedValue(false);
    expect(await links.of(FABRIZIO).forget()).toEqual({ revoked: false });
    expect(store.linkOf(FABRIZIO, NOW)).toEqual({ kind: 'absent' });
  });

  it('non tocca il collegamento di un altro QMate', async () => {
    store.rememberLink(ANOTHER_QMATE, 'membro-xyz', credential(), NOW);
    await links.of(FABRIZIO).forget();
    expect(store.linkOf(ANOTHER_QMATE, NOW).kind).toBe('linked');
  });
});
