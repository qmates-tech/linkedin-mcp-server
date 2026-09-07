import Database from 'better-sqlite3';

import type { QMateSubject } from '../fleet/acting-qmate.js';
import { seal, unseal } from './sealed-secret.js';

/**
 * Le righe di questo servizio, indicizzate sul subject del QMate.
 *
 * Due identità girano in questo codice e hanno la stessa forma — una stringa di
 * cifre. Il **subject del QMate** è chi ha fatto login su `auth.qmates.tech`, e
 * indicizza tutto. L'**id del membro LinkedIn** è chi si è collegato, e serve
 * solo a comporre l'urn dell'autore verso LinkedIn. Scambiarle è il modo in cui
 * un QMate pubblicherebbe sul profilo di un altro, quindi qui non condividono
 * mai un nome né una colonna.
 */

/** Quanto tempo ha un QMate per consentire su LinkedIn dopo aver iniziato. */
const CONSENT_WINDOW_MS = 10 * 60 * 1000;
/** Quanto tempo ha per riportare il codice di conferma dopo il consenso. */
const CONFIRMATION_WINDOW_MS = 10 * 60 * 1000;
/** Oltre questi, il collegamento in attesa si butta invece di restare indovinabile. */
const MOST_CONFIRMATION_ATTEMPTS = 10;
/** Si rinnova l'access token un po' prima della scadenza, non sul filo. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

export interface LinkedInCredential {
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
  accessExpiresAt: number;
  refreshExpiresAt?: number;
}

export interface LinkSummary {
  linkedInMemberId: string;
  scopes: string[];
  accessExpiresAt: number;
  refreshExpiresAt: number | null;
  linkedAt: number;
}

export type LinkReadout =
  | { readonly kind: 'absent' }
  /** La chiave non apre più i sigilli: per il QMate equivale a non essere collegato. */
  | { readonly kind: 'unreadable'; readonly linkedInMemberId: string }
  | {
      readonly kind: 'linked';
      readonly summary: LinkSummary;
      readonly accessToken: string;
      readonly refreshToken: string | null;
      readonly needsRenewal: boolean;
    };

export interface ConsentedLink {
  linkedInMemberId: string;
  credential: LinkedInCredential;
}

export class LinkStore {
  readonly database: Database.Database;
  private readonly tokenKey: Buffer;

  constructor(databasePath: string, tokenKey: Buffer) {
    this.database = new Database(databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('busy_timeout = 5000');
    this.tokenKey = tokenKey;
    this.createSchema();
  }

  private createSchema(): void {
    // Le tabelle del fork erano indicizzate sull'id del membro LinkedIn e
    // tenevano i token in chiaro. Non sono migrabili: non esiste, in quelle
    // righe, il QMate a cui attribuirle — quel concetto non c'era. Si buttano,
    // così un database di sviluppo smette anche di contenere segreti in chiaro.
    this.database.exec(`
      DROP TABLE IF EXISTS tokens;
      DROP TABLE IF EXISTS pkce_state;
      DROP TABLE IF EXISTS post_history;

      CREATE TABLE IF NOT EXISTS linkedin_link (
        qmate_subject         TEXT PRIMARY KEY,
        linkedin_member_id    TEXT NOT NULL,
        access_token_sealed   BLOB NOT NULL,
        refresh_token_sealed  BLOB,
        scopes                TEXT NOT NULL,
        access_expires_at     INTEGER NOT NULL,
        refresh_expires_at    INTEGER,
        linked_at             INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_link (
        state                 TEXT PRIMARY KEY,
        qmate_subject         TEXT NOT NULL,
        stage                 TEXT NOT NULL,
        started_at            INTEGER NOT NULL,
        consented_at          INTEGER,
        confirmation_code     TEXT,
        confirmation_attempts INTEGER NOT NULL DEFAULT 0,
        linkedin_member_id    TEXT,
        access_token_sealed   BLOB,
        refresh_token_sealed  BLOB,
        scopes                TEXT,
        access_expires_at     INTEGER,
        refresh_expires_at    INTEGER
      );

      CREATE INDEX IF NOT EXISTS pending_link_by_qmate ON pending_link (qmate_subject, stage);

      CREATE TABLE IF NOT EXISTS published_post (
        post_urn      TEXT PRIMARY KEY,
        qmate_subject TEXT NOT NULL,
        text_preview  TEXT NOT NULL,
        visibility    TEXT NOT NULL,
        has_image     INTEGER NOT NULL DEFAULT 0,
        has_article   INTEGER NOT NULL DEFAULT 0,
        article_url   TEXT,
        created_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS published_post_by_qmate
        ON published_post (qmate_subject, created_at DESC);
    `);
  }

  linkOf(qmate: QMateSubject, now = Date.now()): LinkReadout {
    const row = this.database
      .prepare('SELECT * FROM linkedin_link WHERE qmate_subject = ?')
      .get(qmate) as LinkRow | undefined;
    if (!row) return { kind: 'absent' };

    const accessToken = unseal(this.tokenKey, row.access_token_sealed, qmate);
    if (accessToken === null) return { kind: 'unreadable', linkedInMemberId: row.linkedin_member_id };

    return {
      kind: 'linked',
      summary: {
        linkedInMemberId: row.linkedin_member_id,
        scopes: JSON.parse(row.scopes) as string[],
        accessExpiresAt: row.access_expires_at,
        refreshExpiresAt: row.refresh_expires_at ?? null,
        linkedAt: row.linked_at,
      },
      accessToken,
      refreshToken: row.refresh_token_sealed
        ? unseal(this.tokenKey, row.refresh_token_sealed, qmate)
        : null,
      needsRenewal: now >= row.access_expires_at - RENEW_BEFORE_MS,
    };
  }

  rememberLink(qmate: QMateSubject, linkedInMemberId: string, credential: LinkedInCredential, now = Date.now()): void {
    this.database
      .prepare(
        `INSERT INTO linkedin_link (qmate_subject, linkedin_member_id, access_token_sealed,
           refresh_token_sealed, scopes, access_expires_at, refresh_expires_at, linked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (qmate_subject) DO UPDATE SET
           linkedin_member_id = excluded.linkedin_member_id,
           access_token_sealed = excluded.access_token_sealed,
           refresh_token_sealed = excluded.refresh_token_sealed,
           scopes = excluded.scopes,
           access_expires_at = excluded.access_expires_at,
           refresh_expires_at = excluded.refresh_expires_at,
           linked_at = excluded.linked_at`,
      )
      .run(
        qmate,
        linkedInMemberId,
        seal(this.tokenKey, credential.accessToken, qmate),
        credential.refreshToken ? seal(this.tokenKey, credential.refreshToken, qmate) : null,
        JSON.stringify(credential.scopes),
        credential.accessExpiresAt,
        credential.refreshExpiresAt ?? null,
        now,
      );
  }

  /**
   * Sostituisce le sole credenziali dopo un rinnovo, lasciando stare il membro.
   *
   * LinkedIn ruota il refresh token a ogni rinnovo: la riga va riscritta in un
   * colpo, o una seconda chiamata concorrente ne salverebbe uno che LinkedIn ha
   * già consumato e il collegamento morirebbe senza che nessuno lo abbia toccato.
   */
  renewCredential(qmate: QMateSubject, credential: LinkedInCredential): void {
    this.database
      .prepare(
        `UPDATE linkedin_link SET access_token_sealed = ?, refresh_token_sealed = ?, scopes = ?,
           access_expires_at = ?, refresh_expires_at = ?
         WHERE qmate_subject = ?`,
      )
      .run(
        seal(this.tokenKey, credential.accessToken, qmate),
        credential.refreshToken ? seal(this.tokenKey, credential.refreshToken, qmate) : null,
        JSON.stringify(credential.scopes),
        credential.accessExpiresAt,
        credential.refreshExpiresAt ?? null,
        qmate,
      );
  }

  forgetLink(qmate: QMateSubject): void {
    this.database.prepare('DELETE FROM linkedin_link WHERE qmate_subject = ?').run(qmate);
  }

  startPendingLink(qmate: QMateSubject, state: string, now = Date.now()): void {
    // Un QMate per volta: un secondo `link_start` sostituisce il primo, così non
    // si accumulano finestre aperte a nome suo che qualcun altro può completare.
    this.database.prepare('DELETE FROM pending_link WHERE qmate_subject = ?').run(qmate);
    this.database
      .prepare(`INSERT INTO pending_link (state, qmate_subject, stage, started_at) VALUES (?, ?, 'started', ?)`)
      .run(state, qmate, now);
  }

  /**
   * Il callback prende possesso dello state, una volta sola.
   *
   * `UPDATE ... RETURNING` in un colpo perché due richieste sullo stesso state
   * sono la forma normale di un replay: la seconda deve trovare la porta chiusa,
   * non una riga ancora in stato `started`.
   */
  claimPendingLink(state: string, now = Date.now()): QMateSubject | null {
    const claimed = this.database
      .prepare(
        `UPDATE pending_link SET stage = 'consenting'
         WHERE state = ? AND stage = 'started' AND started_at > ?
         RETURNING qmate_subject`,
      )
      .get(state, now - CONSENT_WINDOW_MS) as { qmate_subject: string } | undefined;
    return claimed ? (claimed.qmate_subject as QMateSubject) : null;
  }

  /** Le credenziali restano in sospeso, non collegate, finché il QMate non conferma. */
  holdForConfirmation(
    state: string,
    confirmationCode: string,
    linkedInMemberId: string,
    credential: LinkedInCredential,
    now = Date.now(),
  ): void {
    const owner = this.database
      .prepare('SELECT qmate_subject FROM pending_link WHERE state = ?')
      .get(state) as { qmate_subject: string } | undefined;
    if (!owner) return;
    this.database
      .prepare(
        `UPDATE pending_link SET stage = 'awaiting_confirmation', consented_at = ?,
           confirmation_code = ?, linkedin_member_id = ?, access_token_sealed = ?,
           refresh_token_sealed = ?, scopes = ?, access_expires_at = ?, refresh_expires_at = ?
         WHERE state = ? AND stage = 'consenting'`,
      )
      .run(
        now,
        confirmationCode,
        linkedInMemberId,
        seal(this.tokenKey, credential.accessToken, owner.qmate_subject),
        credential.refreshToken ? seal(this.tokenKey, credential.refreshToken, owner.qmate_subject) : null,
        JSON.stringify(credential.scopes),
        credential.accessExpiresAt,
        credential.refreshExpiresAt ?? null,
        state,
      );
  }

  /** Che cosa sta aspettando conferma per questo QMate, senza consumarlo. */
  awaitingConfirmation(qmate: QMateSubject, now = Date.now()): { linkedInMemberId: string } | null {
    const row = this.database
      .prepare(
        `SELECT linkedin_member_id FROM pending_link
         WHERE qmate_subject = ? AND stage = 'awaiting_confirmation' AND consented_at > ?`,
      )
      .get(qmate, now - CONFIRMATION_WINDOW_MS) as { linkedin_member_id: string } | undefined;
    return row ? { linkedInMemberId: row.linkedin_member_id } : null;
  }

  /**
   * Il codice giusto, dal QMate giusto, una volta sola.
   *
   * Il subject entra nella clausola `WHERE`, non nel confronto a valle: è ciò
   * che impedisce a chi ha consentito su LinkedIn di completare un collegamento
   * a nome di chi lo ha iniziato, e viceversa.
   */
  confirmPendingLink(qmate: QMateSubject, confirmationCode: string, now = Date.now()): ConsentedLink | null {
    const confirmed = this.database
      .prepare(
        `DELETE FROM pending_link
         WHERE qmate_subject = ? AND confirmation_code = ? AND stage = 'awaiting_confirmation'
           AND consented_at > ? AND confirmation_attempts < ?
         RETURNING *`,
      )
      .get(qmate, confirmationCode, now - CONFIRMATION_WINDOW_MS, MOST_CONFIRMATION_ATTEMPTS) as
      | PendingRow
      | undefined;

    if (!confirmed) {
      // Un tentativo sbagliato costa: senza contatore il codice resterebbe
      // indovinabile per tutta la finestra da chi ha iniziato il flusso.
      this.database
        .prepare(
          `UPDATE pending_link SET confirmation_attempts = confirmation_attempts + 1
           WHERE qmate_subject = ? AND stage = 'awaiting_confirmation'`,
        )
        .run(qmate);
      return null;
    }

    const accessToken = unseal(this.tokenKey, confirmed.access_token_sealed!, qmate);
    if (accessToken === null) return null;
    return {
      linkedInMemberId: confirmed.linkedin_member_id!,
      credential: {
        accessToken,
        refreshToken: confirmed.refresh_token_sealed
          ? (unseal(this.tokenKey, confirmed.refresh_token_sealed, qmate) ?? undefined)
          : undefined,
        scopes: JSON.parse(confirmed.scopes!) as string[],
        accessExpiresAt: confirmed.access_expires_at!,
        refreshExpiresAt: confirmed.refresh_expires_at ?? undefined,
      },
    };
  }

  /**
   * Butta i collegamenti in sospeso scaduti.
   *
   * Resta un residuo che vale dirlo: se un QMate consente su LinkedIn e poi non
   * conferma, il grant su LinkedIn resta vivo mentre la nostra copia del token
   * sparisce — quindi non possiamo più revocarlo noi. È lo stesso residuo di
   * qualunque consenso OAuth abbandonato, e si chiude dalle impostazioni di
   * LinkedIn.
   */
  sweepStalePendingLinks(now = Date.now()): number {
    return this.database
      .prepare(
        `DELETE FROM pending_link
         WHERE (stage = 'started' AND started_at <= ?)
            OR (stage = 'consenting' AND started_at <= ?)
            OR (stage = 'awaiting_confirmation' AND consented_at <= ?)`,
      )
      .run(now - CONSENT_WINDOW_MS, now - CONSENT_WINDOW_MS, now - CONFIRMATION_WINDOW_MS).changes;
  }

  close(): void {
    this.database.close();
  }
}

interface LinkRow {
  qmate_subject: string;
  linkedin_member_id: string;
  access_token_sealed: Buffer;
  refresh_token_sealed: Buffer | null;
  scopes: string;
  access_expires_at: number;
  refresh_expires_at: number | null;
  linked_at: number;
}

interface PendingRow {
  state: string;
  qmate_subject: string;
  stage: string;
  started_at: number;
  consented_at: number | null;
  confirmation_code: string | null;
  confirmation_attempts: number;
  linkedin_member_id: string | null;
  access_token_sealed: Buffer | null;
  refresh_token_sealed: Buffer | null;
  scopes: string | null;
  access_expires_at: number | null;
  refresh_expires_at: number | null;
}
