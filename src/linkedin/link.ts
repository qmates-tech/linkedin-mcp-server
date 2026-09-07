import type { QMateSubject } from '../fleet/acting-qmate.js';
import type { LinkSummary, LinkStore } from './link-store.js';
import type { Linking } from './linking.js';

/**
 * Il collegamento LinkedIn di UN QMate, legato alla costruzione.
 *
 * Nessun metodo prende un subject. È la differenza fra «ogni tool si ricorda di
 * passare il tenant giusto» e «un tool non ha un tenant da sbagliare»: nel fork
 * l'identità viveva in un `let currentUserId` di processo, quindi il primo
 * QMate che si collegava diventava l'autore di tutto ciò che chiedeva chiunque.
 */

export class NotLinked extends Error {
  constructor(message = 'LinkedIn non è collegato: usa linkedin_link_start.') {
    super(message);
  }
}

export class LinkNoLongerValid extends Error {
  constructor(message = 'LinkedIn ha ritirato l accesso: ricollega con linkedin_link_start.') {
    super(message);
  }
}

export type LinkState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'awaiting_confirmation'; readonly linkedInMemberId: string }
  /** Il sigillo non si apre più: per il QMate equivale a non essere collegato. */
  | { readonly kind: 'unreadable'; readonly linkedInMemberId: string }
  | { readonly kind: 'linked'; readonly summary: LinkSummary };

/**
 * La fabbrica condivisa. Tiene i rinnovi in volo, che devono essere per
 * processo e non per richiesta: LinkedIn ruota il refresh token a ogni rinnovo,
 * quindi due richieste concorrenti che rinnovano entrambe si invalidano a
 * vicenda e il collegamento muore senza che nessuno lo abbia toccato.
 */
export class LinkedInLinks {
  private readonly renewalsInFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly store: LinkStore,
    private readonly linking: Linking,
    private readonly now: () => number = Date.now,
  ) {}

  of(qmate: QMateSubject): LinkedInLink {
    return new LinkedInLink(qmate, this.store, this.linking, this.renewalsInFlight, this.now);
  }
}

export class LinkedInLink {
  constructor(
    /** Pubblico perché le quote di LinkedIn sono per membro: il contatore va chiavato qui. */
    readonly forQMate: QMateSubject,
    private readonly store: LinkStore,
    private readonly linking: Linking,
    private readonly renewalsInFlight: Map<string, Promise<string>>,
    private readonly now: () => number,
  ) {}

  state(): LinkState {
    const readout = this.store.linkOf(this.forQMate, this.now());
    if (readout.kind === 'linked') return { kind: 'linked', summary: readout.summary };
    if (readout.kind === 'unreadable') {
      return { kind: 'unreadable', linkedInMemberId: readout.linkedInMemberId };
    }
    const pending = this.linking.awaitingConfirmation(this.forQMate);
    return pending === null
      ? { kind: 'absent' }
      : { kind: 'awaiting_confirmation', linkedInMemberId: pending.linkedInMemberId };
  }

  /** L'urn con cui LinkedIn attribuisce ciò che pubblichiamo. */
  personUrn(): string {
    const readout = this.store.linkOf(this.forQMate, this.now());
    if (readout.kind !== 'linked') throw new NotLinked();
    return `urn:li:person:${readout.summary.linkedInMemberId}`;
  }

  /**
   * Il bearer con cui parlare a LinkedIn come questo QMate.
   *
   * `afterRejection` esiste perché il fork, davanti a un 401 di LinkedIn,
   * ripresentava QUATTRO volte lo stesso token morto con backoff esponenziale:
   * il rinnovo scattava solo sull'orologio locale, mai su un rifiuto vero.
   */
  async accessToken(afterRejection = false): Promise<string> {
    const readout = this.store.linkOf(this.forQMate, this.now());
    if (readout.kind === 'absent') throw new NotLinked();
    if (readout.kind === 'unreadable') {
      throw new NotLinked('La chiave di cifratura non apre più il tuo collegamento: ricollega con linkedin_link_start.');
    }
    if (!readout.needsRenewal && !afterRejection) return readout.accessToken;
    if (readout.refreshToken === null) throw new LinkNoLongerValid();
    return this.renewOnce(readout.refreshToken);
  }

  /**
   * Scollega, revocando ciò che tiene vivo il grant.
   *
   * Il fork revocava l'ACCESS token e poi cancellava la riga: il refresh non
   * veniva mai revocato e restava valido per mesi, senza più una copia con cui
   * revocarlo. E la riga si cancella comunque — se la revoca fallisce e noi ci
   * tenessimo il collegamento, un QMate non potrebbe più staccarsi.
   */
  async forget(): Promise<{ revoked: boolean }> {
    const readout = this.store.linkOf(this.forQMate, this.now());
    const grant = readout.kind === 'linked' ? (readout.refreshToken ?? readout.accessToken) : null;
    const revoked = grant === null ? false : await this.linking.revoke(grant);
    this.store.forgetLink(this.forQMate);
    return { revoked };
  }

  private async renewOnce(refreshToken: string): Promise<string> {
    const alreadyRunning = this.renewalsInFlight.get(this.forQMate);
    if (alreadyRunning) return alreadyRunning;

    const renewal = this.linking
      .renew(refreshToken)
      .then((renewed) => {
        if (renewed === null) throw new LinkNoLongerValid();
        this.store.renewCredential(this.forQMate, renewed);
        return renewed.accessToken;
      })
      .finally(() => this.renewalsInFlight.delete(this.forQMate));

    this.renewalsInFlight.set(this.forQMate, renewal);
    return renewal;
  }
}
