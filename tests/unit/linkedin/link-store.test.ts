import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { QMateSubject } from '../../../src/fleet/acting-qmate.js';
import { LinkStore, type LinkedInCredential } from '../../../src/linkedin/link-store.js';
import { seal } from '../../../src/linkedin/sealed-secret.js';

const KEY = randomBytes(32);
const FABRIZIO = '106977126509011341120' as QMateSubject;
const ANOTHER_QMATE = '999888777666555444333' as QMateSubject;
const HIS_LINKEDIN = 'linkedin-member-abc';
const HER_LINKEDIN = 'linkedin-member-xyz';
const NOW = 1_757_000_000_000;
const TEN_MINUTES = 10 * 60 * 1000;

function credential(overrides: Partial<LinkedInCredential> = {}): LinkedInCredential {
  return {
    accessToken: 'AQV8-access',
    refreshToken: 'AQV8-refresh',
    scopes: ['openid', 'profile', 'w_member_social'],
    accessExpiresAt: NOW + 60 * 24 * 3600 * 1000,
    refreshExpiresAt: NOW + 365 * 24 * 3600 * 1000,
    ...overrides,
  };
}

let store: LinkStore;

beforeEach(() => {
  store = new LinkStore(':memory:', KEY);
});

afterEach(() => {
  store.close();
});

describe('il collegamento di un QMate', () => {
  it('non esiste finché non lo si scrive', () => {
    expect(store.linkOf(FABRIZIO)).toEqual({ kind: 'absent' });
  });

  it('rende il membro LinkedIn e il token, sigillato a riposo e leggibile a lui', () => {
    store.rememberLink(FABRIZIO, HIS_LINKEDIN, credential(), NOW);
    const readout = store.linkOf(FABRIZIO, NOW);
    expect(readout.kind).toBe('linked');
    if (readout.kind !== 'linked') return;
    expect(readout.summary.linkedInMemberId).toBe(HIS_LINKEDIN);
    expect(readout.accessToken).toBe('AQV8-access');
    expect(readout.refreshToken).toBe('AQV8-refresh');
    expect(readout.needsRenewal).toBe(false);
  });

  it('non finisce in chiaro nel database', () => {
    store.rememberLink(FABRIZIO, HIS_LINKEDIN, credential(), NOW);
    const row = store.database
      .prepare('SELECT access_token_sealed, refresh_token_sealed FROM linkedin_link')
      .get() as { access_token_sealed: Buffer; refresh_token_sealed: Buffer };
    expect(row.access_token_sealed.toString('binary')).not.toContain('AQV8-access');
    expect(row.refresh_token_sealed.toString('binary')).not.toContain('AQV8-refresh');
  });

  it('con la chiave cambiata legge come illeggibile, non come errore', () => {
    store.rememberLink(FABRIZIO, HIS_LINKEDIN, credential(), NOW);
    // Il caso che accadrà: QLI_TOKEN_KEY ruotata o perduta. Il blob resta, la
    // chiave non lo apre, e per il QMate deve equivalere a «non hai collegato».
    store.database
      .prepare('UPDATE linkedin_link SET access_token_sealed = ? WHERE qmate_subject = ?')
      .run(seal(randomBytes(32), 'AQV8-access', FABRIZIO), FABRIZIO);
    expect(store.linkOf(FABRIZIO, NOW)).toEqual({ kind: 'unreadable', linkedInMemberId: HIS_LINKEDIN });
  });

  it('chiede il rinnovo prima della scadenza, non sul filo', () => {
    store.rememberLink(FABRIZIO, HIS_LINKEDIN, credential({ accessExpiresAt: NOW + 60_000 }), NOW);
    const readout = store.linkOf(FABRIZIO, NOW);
    expect(readout.kind === 'linked' && readout.needsRenewal).toBe(true);
  });

  it('il rinnovo riscrive le credenziali e lascia stare il membro', () => {
    store.rememberLink(FABRIZIO, HIS_LINKEDIN, credential(), NOW);
    store.renewCredential(FABRIZIO, credential({ accessToken: 'nuovo', refreshToken: 'ruotato' }));
    const readout = store.linkOf(FABRIZIO, NOW);
    if (readout.kind !== 'linked') throw new Error('atteso collegato');
    expect(readout.accessToken).toBe('nuovo');
    expect(readout.refreshToken).toBe('ruotato');
    expect(readout.summary.linkedInMemberId).toBe(HIS_LINKEDIN);
  });
});

describe('due QMate nello stesso database', () => {
  beforeEach(() => {
    store.rememberLink(FABRIZIO, HIS_LINKEDIN, credential({ accessToken: 'suo' }), NOW);
    store.rememberLink(ANOTHER_QMATE, HER_LINKEDIN, credential({ accessToken: 'altrui' }), NOW);
  });

  it('leggono ognuno il proprio', () => {
    const suo = store.linkOf(FABRIZIO, NOW);
    const altrui = store.linkOf(ANOTHER_QMATE, NOW);
    expect(suo.kind === 'linked' && suo.accessToken).toBe('suo');
    expect(altrui.kind === 'linked' && altrui.accessToken).toBe('altrui');
  });

  it('scollegarsi non tocca l altro', () => {
    store.forgetLink(FABRIZIO);
    expect(store.linkOf(FABRIZIO, NOW)).toEqual({ kind: 'absent' });
    expect(store.linkOf(ANOTHER_QMATE, NOW).kind).toBe('linked');
  });
});

describe('il flusso di collegamento in sospeso', () => {
  it('un secondo avvio sostituisce il primo, così non restano finestre aperte a suo nome', () => {
    store.startPendingLink(FABRIZIO, 'state-1', NOW);
    store.startPendingLink(FABRIZIO, 'state-2', NOW);
    expect(store.claimPendingLink('state-1', NOW)).toBeNull();
    expect(store.claimPendingLink('state-2', NOW)).toBe(FABRIZIO);
  });

  it('lo state si consuma una volta sola: un replay trova la porta chiusa', () => {
    store.startPendingLink(FABRIZIO, 'state-1', NOW);
    expect(store.claimPendingLink('state-1', NOW)).toBe(FABRIZIO);
    expect(store.claimPendingLink('state-1', NOW)).toBeNull();
  });

  it('lo state scade se il consenso non arriva in tempo', () => {
    store.startPendingLink(FABRIZIO, 'state-1', NOW);
    expect(store.claimPendingLink('state-1', NOW + TEN_MINUTES + 1)).toBeNull();
  });

  it('uno state inventato non collega nulla', () => {
    expect(store.claimPendingLink('mai-emesso', NOW)).toBeNull();
  });
});

describe('la conferma, che è ciò che lega chi ha iniziato a chi ha consentito', () => {
  const CODE = 'K7M2QX9P';

  beforeEach(() => {
    store.startPendingLink(FABRIZIO, 'state-1', NOW);
    store.claimPendingLink('state-1', NOW);
    store.holdForConfirmation('state-1', CODE, HIS_LINKEDIN, credential(), NOW);
  });

  it('dice chi sta aspettando conferma, senza consumare nulla', () => {
    expect(store.awaitingConfirmation(FABRIZIO, NOW)).toEqual({ linkedInMemberId: HIS_LINKEDIN });
    expect(store.awaitingConfirmation(FABRIZIO, NOW)).toEqual({ linkedInMemberId: HIS_LINKEDIN });
  });

  it('non è ancora un collegamento: fino alla conferma non esiste', () => {
    expect(store.linkOf(FABRIZIO, NOW)).toEqual({ kind: 'absent' });
  });

  it('col codice giusto consegna le credenziali, una volta sola', () => {
    const confirmed = store.confirmPendingLink(FABRIZIO, CODE, NOW);
    expect(confirmed?.linkedInMemberId).toBe(HIS_LINKEDIN);
    expect(confirmed?.credential.accessToken).toBe('AQV8-access');
    expect(store.confirmPendingLink(FABRIZIO, CODE, NOW)).toBeNull();
  });

  // L'attacco che tutti e tre i design proposti lasciavano aperto: lo state
  // prova chi ha INIZIATO, non chi ha CONSENTITO su LinkedIn. Con una sola app
  // aziendale gli authorization code sono fungibili fra QMate, quindi il legame
  // fra le due parti lo deve fare qualcos'altro — qui, il subject nella WHERE.
  it('un altro QMate non conferma col codice, nemmeno se lo conosce', () => {
    expect(store.confirmPendingLink(ANOTHER_QMATE, CODE, NOW)).toBeNull();
    expect(store.linkOf(ANOTHER_QMATE, NOW)).toEqual({ kind: 'absent' });
    // e il collegamento di chi lo ha iniziato è ancora là, intatto
    expect(store.awaitingConfirmation(FABRIZIO, NOW)).toEqual({ linkedInMemberId: HIS_LINKEDIN });
  });

  it('col codice sbagliato non consegna niente', () => {
    expect(store.confirmPendingLink(FABRIZIO, 'SBAGLIATO', NOW)).toBeNull();
  });

  it('dopo dieci tentativi il codice giusto non vale più', () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      store.confirmPendingLink(FABRIZIO, 'SBAGLIATO', NOW);
    }
    expect(store.confirmPendingLink(FABRIZIO, CODE, NOW)).toBeNull();
  });

  it('scade se il codice non torna in tempo', () => {
    expect(store.confirmPendingLink(FABRIZIO, CODE, NOW + TEN_MINUTES + 1)).toBeNull();
  });
});

describe('la pulizia dei collegamenti abbandonati', () => {
  it('butta gli scaduti e lascia i vivi', () => {
    store.startPendingLink(FABRIZIO, 'vecchio', NOW - TEN_MINUTES - 1);
    store.startPendingLink(ANOTHER_QMATE, 'fresco', NOW);
    expect(store.sweepStalePendingLinks(NOW)).toBe(1);
    expect(store.claimPendingLink('fresco', NOW)).toBe(ANOTHER_QMATE);
  });

  it('butta anche un consenso mai confermato', () => {
    store.startPendingLink(FABRIZIO, 'state-1', NOW - TEN_MINUTES);
    store.claimPendingLink('state-1', NOW - TEN_MINUTES);
    store.holdForConfirmation('state-1', 'CODE1234', HIS_LINKEDIN, credential(), NOW - TEN_MINUTES);
    expect(store.sweepStalePendingLinks(NOW + 1)).toBe(1);
    expect(store.awaitingConfirmation(FABRIZIO, NOW + 1)).toBeNull();
  });
});
