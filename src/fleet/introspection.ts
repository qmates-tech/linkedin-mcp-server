import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { QMATE_SUBJECT } from './acting-qmate.js';
import { canonicalResource } from './audience.js';

/**
 * Perché un bearer è stato rifiutato. Va nel log, non nella risposta.
 *
 * Al chiamante arriva sempre la stessa frase: distinguere «token scaduto» da
 * «token di un'altra resource» da «AS irraggiungibile» darebbe a un anonimo un
 * oracolo su token che non possiede. Chi deve distinguerle è chi legge i log
 * alle tre di notte, e per lui il motivo c'è tutto.
 */
export type Refusal =
  | 'as_unreachable'
  | 'as_refused_us'
  | 'verdict_unreadable'
  | 'token_inactive'
  | 'other_issuer'
  | 'other_audience'
  | 'no_subject'
  | 'no_expiry'
  | 'introspections_exhausted';

/** Ciò che il chiamante legge, sempre, qualunque sia il motivo vero. */
const SAME_ANSWER_TO_EVERYONE = 'token non accettato';

const INTROSPECTION_TIMEOUT_MS = 10_000;

/**
 * Tetto sulle introspection che questo servizio genera, non sulle richieste che
 * riceve.
 *
 * `requireBearerAuth` respinge da solo la sola richiesta SENZA header; qualunque
 * `Authorization: Bearer x` arriva fin qui e costa una POST verso
 * `auth.qmates.tech`. Senza un tetto, un estraneo che POSTa bearer inventati a
 * mille al secondo non fa 401 su LinkedIn: li fa su OGNI servizio della flotta,
 * perché l'AS è la porta di tutti. Il tetto è molto sopra l'uso reale (una
 * manciata di QMate) e molto sotto un'amplificazione, e quando si esaurisce si
 * rifiuta senza chiamare — cioè si protegge l'AS, non se stessi.
 */
const INTROSPECTIONS_PER_SECOND = 20;
const INTROSPECTION_BURST = 60;

interface IntrospectionVerdict {
  active?: unknown;
  sub?: unknown;
  aud?: unknown;
  iss?: unknown;
  exp?: unknown;
  client_id?: unknown;
}

export interface IntrospectionOptions {
  /** L'URL dell'AS, già in forma canonica. */
  authorizationServer: string;
  /** La nostra resource, già in forma canonica: è con questa che si confronta `aud`. */
  resource: string;
  /** Il client_id con cui questo RS si autentica su `/introspect`. */
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  record?: (refusal: Refusal, detail?: Record<string, unknown>) => void;
}

/**
 * Valida un bearer opaco contro l'AS della flotta via RFC 7662, FAIL-CLOSED.
 *
 * Contratto verso `requireBearerAuth`: rende un `AuthInfo` o solleva
 * `InvalidTokenError`. Solo quel tipo diventa un 401 con l'header
 * `WWW-Authenticate` che dice al client dove autenticarsi; qualunque altra
 * eccezione — un `TypeError` su un corpo inatteso, per dire — diventa un 500
 * muto, e un client davanti a un 500 non scopre l'AS e non ritenta il login. Per
 * questo qui non esiste un percorso che sollevi altro.
 */
export class IntrospectionVerifier implements OAuthTokenVerifier {
  private readonly introspectionEndpoint: string;
  private readonly credentials: string;
  private readonly resource: string;
  private readonly authorizationServer: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly record: (refusal: Refusal, detail?: Record<string, unknown>) => void;
  private introspectionsLeft = INTROSPECTION_BURST;
  private lastRefill: number;

  constructor(options: IntrospectionOptions) {
    this.introspectionEndpoint = `${options.authorizationServer}/introspect`;
    this.credentials = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');
    this.resource = options.resource;
    this.authorizationServer = options.authorizationServer;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.record = options.record ?? reportRefusal;
    this.lastRefill = this.now();
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const verdict = await this.askTheAuthorizationServer(token);

    if (verdict.active !== true) return this.refuse('token_inactive');
    if (typeof verdict.sub !== 'string' || verdict.sub === '') return this.refuse('no_subject');
    if (typeof verdict.exp !== 'number' || !Number.isFinite(verdict.exp)) {
      // `requireBearerAuth` rifiuta un AuthInfo senza `expiresAt` numerico, ma
      // lo fa con un messaggio che parla di token: qui il motivo vero è che
      // l'AS ha risposto qualcosa che non contiene una scadenza.
      return this.refuse('no_expiry');
    }
    if (typeof verdict.iss === 'string' && canonicalResource(verdict.iss) !== this.authorizationServer) {
      // Non è tautologico: coglie un `QLI_AS_URL` che punta a un AS che non è il
      // nostro, cioè la configurazione in cui staremmo chiedendo a un estraneo
      // se un token è valido.
      return this.refuse('other_issuer', { iss: verdict.iss });
    }

    // L'audience: un token coniato per `mcp-council` non entra qui. RFC 7662
    // permette che `aud` sia un array, e l'AS della flotta ne conia sempre una
    // sola come stringa — quindi un array è una violazione di contratto, e la si
    // rifiuta invece di lasciare che `canonicalResource` gli chiami `.trim()`
    // sopra e trasformi un 401 in un 500 muto.
    if (typeof verdict.aud !== 'string' || canonicalResource(verdict.aud) !== this.resource) {
      return this.refuse('other_audience', { aud: typeof verdict.aud === 'string' ? verdict.aud : typeof verdict.aud });
    }

    return {
      token,
      clientId: typeof verdict.client_id === 'string' ? verdict.client_id : '',
      scopes: [],
      expiresAt: verdict.exp,
      extra: { [QMATE_SUBJECT]: verdict.sub },
    };
  }

  private async askTheAuthorizationServer(token: string): Promise<IntrospectionVerdict> {
    if (!this.spendOneIntrospection()) return this.refuse('introspections_exhausted');

    let response: Response;
    try {
      response = await this.fetch(this.introspectionEndpoint, {
        method: 'POST',
        headers: {
          authorization: `Basic ${this.credentials}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(INTROSPECTION_TIMEOUT_MS),
      });
    } catch (unreachable) {
      return this.refuse('as_unreachable', { cause: describe(unreachable) });
    }

    if (response.status === 401 || response.status === 403) {
      // Il nostro secret di introspection non combacia con la voce lato AS:
      // nulla funzionerà finché non lo si allinea, e va detto con quel nome.
      return this.refuse('as_refused_us', { status: response.status });
    }
    if (!response.ok) return this.refuse('as_unreachable', { status: response.status });

    let verdict: unknown;
    try {
      verdict = await response.json();
    } catch (unreadable) {
      return this.refuse('verdict_unreadable', { cause: describe(unreadable) });
    }
    // `null` è JSON valido, e leggerne un campo solleva: senza questa riga un AS
    // che rispondesse `null` renderebbe ogni chiamata MCP un 500 senza
    // `WWW-Authenticate`, e nessun client si riautenticherebbe più.
    if (typeof verdict !== 'object' || verdict === null || Array.isArray(verdict)) {
      return this.refuse('verdict_unreadable', { shape: verdict === null ? 'null' : typeof verdict });
    }
    return verdict as IntrospectionVerdict;
  }

  private spendOneIntrospection(): boolean {
    const now = this.now();
    const refill = ((now - this.lastRefill) / 1000) * INTROSPECTIONS_PER_SECOND;
    if (refill > 0) {
      this.introspectionsLeft = Math.min(INTROSPECTION_BURST, this.introspectionsLeft + refill);
      this.lastRefill = now;
    }
    if (this.introspectionsLeft < 1) return false;
    this.introspectionsLeft -= 1;
    return true;
  }

  private refuse(refusal: Refusal, detail?: Record<string, unknown>): never {
    this.record(refusal, detail);
    throw new InvalidTokenError(SAME_ANSWER_TO_EVERYONE);
  }
}

/** Una riga per rifiuto su stderr, perché è lì che si guarda quando non funziona. */
function reportRefusal(refusal: Refusal, detail?: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ event: 'bearer_refused', refusal, ...detail })}\n`);
}

/** Il nome dell'errore, non il suo messaggio: un messaggio può contenere l'URL e il token. */
function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.name : typeof thrown;
}
