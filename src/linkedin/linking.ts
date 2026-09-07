import { randomBytes, randomInt } from 'node:crypto';

import type { QMateSubject } from '../fleet/acting-qmate.js';
import { LINKEDIN } from '../fleet/configuration.js';
import { SELF_SERVE_SCOPES } from '../types/index.js';
import type { LinkStore, LinkedInCredential } from './link-store.js';

/**
 * Collegare la LinkedIn di un QMate, in due mosse invece di una.
 *
 * Uno `state` OAuth prova chi ha INIZIATO un flusso. Non dice niente su chi ha
 * CONSENTITO su LinkedIn, e con una sola app aziendale ogni authorization code
 * è riscattabile da noi qualunque membro l'abbia concesso: le due parti sono
 * fatti disgiunti, e nulla nel protocollo le unisce. Un QMate potrebbe quindi
 * mandare il proprio URL di autorizzazione a un collega — «collega la tua
 * LinkedIn all'assistente» — e vedersi agganciare l'account del collega, con
 * `w_member_social` incluso, cioè il permesso di pubblicare a suo nome. Il
 * collega vede una schermata di consenso LinkedIn autentica; niente stona.
 *
 * Il ponte deve quindi portare un'informazione dal browser alla sessione MCP,
 * che è l'unica direzione che uno `state` non copre. Perciò il consenso non
 * collega: parcheggia la credenziale e conia un codice mostrato nel browser, e
 * il collegamento si scrive solo quando il QMate riporta quel codice dalla
 * propria sessione autenticata.
 */

/**
 * Cosa chiediamo a LinkedIn, e lo decide il server.
 *
 * Nel fork era un parametro del tool, castato `as never`: chi chiamava poteva
 * chiedere qualunque scope, quindi l'insieme dei permessi non era una policy
 * ma una richiesta del client. Sono i quattro che LinkedIn concede senza
 * approvare l'app — gli altri del vocabolario richiedono una revisione.
 */
const SCOPES = SELF_SERVE_SCOPES;

/** Senza I, O, 0 e 1: questo codice lo legge un umano da una pagina web. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export type ConsentOutcome =
  | { readonly kind: 'awaiting_confirmation'; readonly confirmationCode: string; readonly memberName: string }
  /** Un solo esito per ogni fallimento: il callback è anonimo e non fa da oracolo. */
  | { readonly kind: 'refused'; readonly because: ConsentRefusal };

export type ConsentRefusal =
  | 'unknown_or_used_state'
  | 'exchange_refused'
  | 'member_unreadable'
  | 'malformed_request';

export type ConfirmOutcome =
  | { readonly kind: 'linked'; readonly linkedInMemberId: string; readonly scopes: string[] }
  | { readonly kind: 'no_such_code' }
  /**
   * Il collegamento esiste già e punta a un altro membro: non lo si sostituisce
   * di soppiatto, perché è la forma che avrebbe un dirottamento riuscito.
   */
  | { readonly kind: 'would_replace'; readonly current: string; readonly incoming: string };

export interface LinkingOptions {
  store: LinkStore;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authBaseUrl?: string;
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  newState?: () => string;
  newConfirmationCode?: () => string;
}

export class Linking {
  private readonly store: LinkStore;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly authBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly newState: () => string;
  private readonly newConfirmationCode: () => string;

  constructor(options: LinkingOptions) {
    this.store = options.store;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.redirectUri = options.redirectUri;
    this.authBaseUrl = options.authBaseUrl ?? LINKEDIN.authBaseUrl;
    this.apiBaseUrl = options.apiBaseUrl ?? LINKEDIN.apiBaseUrl;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.newState = options.newState ?? (() => randomBytes(32).toString('hex'));
    this.newConfirmationCode = options.newConfirmationCode ?? mintConfirmationCode;
  }

  /** L'URL che il QMate apre nel proprio browser per consentire su LinkedIn. */
  beginLinking(qmate: QMateSubject): string {
    this.store.sweepStalePendingLinks(this.now());
    const state = this.newState();
    this.store.startPendingLink(qmate, state, this.now());
    const parameters = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      state,
      scope: SCOPES.join(' '),
    });
    return `${this.authBaseUrl}/authorization?${parameters.toString()}`;
  }

  /** LinkedIn ha rimandato qui un browser dopo il consenso. */
  async consentArrived(state: unknown, code: unknown): Promise<ConsentOutcome> {
    // Express rende un array quando un parametro compare due volte: trattarlo
    // come stringa più avanti farebbe sollevare, e da un endpoint anonimo un
    // errore inatteso è una pagina di stack trace.
    if (typeof state !== 'string' || typeof code !== 'string' || state === '' || code === '') {
      return { kind: 'refused', because: 'malformed_request' };
    }
    const qmate = this.store.claimPendingLink(state, this.now());
    if (qmate === null) return { kind: 'refused', because: 'unknown_or_used_state' };

    const credential = await this.exchangeCode(code);
    if (credential === null) return { kind: 'refused', because: 'exchange_refused' };

    const member = await this.whoConsented(credential.accessToken);
    if (member === null) return { kind: 'refused', because: 'member_unreadable' };

    const confirmationCode = this.newConfirmationCode();
    this.store.holdForConfirmation(state, confirmationCode, member.id, credential, this.now());
    return { kind: 'awaiting_confirmation', confirmationCode, memberName: member.name };
  }

  /** Il QMate riporta, dalla propria sessione, il codice visto nel browser. */
  confirmLinking(qmate: QMateSubject, confirmationCode: string, replacing = false): ConfirmOutcome {
    // La sostituzione si controlla PRIMA di consumare: il consumo è single-use,
    // quindi rifiutare dopo brucerebbe la credenziale e il QMate non potrebbe
    // più riprovare acconsentendo alla sostituzione.
    const incoming = this.store.awaitingConfirmation(qmate, this.now());
    const currentMember = this.linkedMember(qmate);
    if (
      !replacing &&
      incoming !== null &&
      currentMember !== null &&
      currentMember !== incoming.linkedInMemberId
    ) {
      return { kind: 'would_replace', current: currentMember, incoming: incoming.linkedInMemberId };
    }

    const consented = this.store.confirmPendingLink(qmate, normalizeCode(confirmationCode), this.now());
    if (consented === null) return { kind: 'no_such_code' };

    this.store.rememberLink(qmate, consented.linkedInMemberId, consented.credential, this.now());
    return { kind: 'linked', linkedInMemberId: consented.linkedInMemberId, scopes: consented.credential.scopes };
  }

  /** Il membro collegato oggi, anche se la sua credenziale non è più leggibile. */
  private linkedMember(qmate: QMateSubject): string | null {
    const existing = this.store.linkOf(qmate, this.now());
    if (existing.kind === 'linked') return existing.summary.linkedInMemberId;
    if (existing.kind === 'unreadable') return existing.linkedInMemberId;
    return null;
  }

  /** Che cosa il QMate deve confermare, se qualcosa lo attende. */
  awaitingConfirmation(qmate: QMateSubject): { linkedInMemberId: string } | null {
    return this.store.awaitingConfirmation(qmate, this.now());
  }

  private async exchangeCode(code: string): Promise<LinkedInCredential | null> {
    return this.mintCredential(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    );
  }

  /** Rinnova un access token scaduto; `null` se LinkedIn ha ritirato il grant. */
  async renew(refreshToken: string): Promise<LinkedInCredential | null> {
    const renewed = await this.mintCredential(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    );
    // LinkedIn ruota il refresh token, ma non sempre lo rimanda: senza questa
    // riga un rinnovo cancellerebbe l'unica copia di ciò che tiene vivo il grant.
    if (renewed && !renewed.refreshToken) renewed.refreshToken = refreshToken;
    return renewed;
  }

  /** Revoca ciò che tiene vivo il grant, non solo l'access token. */
  async revoke(token: string): Promise<boolean> {
    try {
      const response = await this.fetch(`${this.authBaseUrl}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          token,
        }).toString(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async mintCredential(body: URLSearchParams): Promise<LinkedInCredential | null> {
    let minted: unknown;
    try {
      const response = await this.fetch(`${this.authBaseUrl}/accessToken`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!response.ok) return null;
      minted = await response.json();
    } catch {
      return null;
    }
    if (typeof minted !== 'object' || minted === null) return null;

    const { access_token, expires_in, refresh_token, refresh_token_expires_in, scope } =
      minted as Record<string, unknown>;
    if (typeof access_token !== 'string' || access_token === '') return null;
    if (typeof expires_in !== 'number' || !Number.isFinite(expires_in)) return null;

    return {
      accessToken: access_token,
      refreshToken: typeof refresh_token === 'string' ? refresh_token : undefined,
      scopes: typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [...SCOPES],
      accessExpiresAt: this.now() + expires_in * 1000,
      refreshExpiresAt:
        typeof refresh_token_expires_in === 'number' && Number.isFinite(refresh_token_expires_in)
          ? this.now() + refresh_token_expires_in * 1000
          : undefined,
    };
  }

  /**
   * Chi ha consentito, per nome: è il nome che la pagina mostra, e serve al
   * QMate per accorgersi che il membro collegato non è il suo.
   */
  private async whoConsented(accessToken: string): Promise<{ id: string; name: string } | null> {
    try {
      const response = await this.fetch(`${this.apiBaseUrl}/v2/userinfo`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return null;
      const profile = (await response.json()) as { sub?: unknown; name?: unknown };
      if (typeof profile.sub !== 'string' || profile.sub === '') return null;
      return { id: profile.sub, name: typeof profile.name === 'string' ? profile.name : profile.sub };
    } catch {
      return null;
    }
  }
}

export function mintConfirmationCode(): string {
  let code = '';
  for (let position = 0; position < CODE_LENGTH; position += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** Come si mostra: a gruppi, perché va riletto da uno schermo e ridigitato. */
export function readableCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Come si confronta: senza trattini, senza spazi, in maiuscolo. */
export function normalizeCode(typed: string): string {
  return typed.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
