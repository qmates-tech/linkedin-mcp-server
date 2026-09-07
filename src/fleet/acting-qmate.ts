import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

/**
 * Il subject Google di un QMate, come l'introspection dell'AS lo restituisce.
 *
 * È un tipo distinto da `string` perché è la chiave di tenancy: ogni riga che
 * questo servizio scrive è indicizzata su di esso, e uno scambio con l'id di un
 * membro LinkedIn — l'altra identità che gira in questo codice, con la stessa
 * forma — farebbe agire un QMate come un altro.
 */
export type QMateSubject = string & { readonly __qmate: unique symbol };

/** Dove `verifyAccessToken` deposita il subject perché `AuthInfo` non ha un campo suo. */
export const QMATE_SUBJECT = 'qmateSubject';

export class NoActingQMate extends Error {}

/**
 * Il QMate per cui questa richiesta sta agendo.
 *
 * Solleva invece di rendere `undefined`: un tool che ricevesse un subject
 * assente proseguirebbe senza tenant, e la sua prima query toccherebbe le righe
 * di chiunque. L'unico modo di non averlo qui è un bug di montaggio — il
 * middleware bearer non è passato — e in quel caso l'unica risposta corretta è
 * non eseguire nulla.
 */
export function actingQMate(auth: AuthInfo | undefined): QMateSubject {
  const subject = auth?.extra?.[QMATE_SUBJECT];
  if (typeof subject !== 'string' || subject === '') {
    throw new NoActingQMate('richiesta senza subject autenticato');
  }
  return subject as QMateSubject;
}
