import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Un token LinkedIn a riposo: cifrato, e legato alla riga che lo contiene.
 *
 * Lo standard §3 chiede le credenziali downstream cifrate at-rest perché su un
 * servizio multi-tenant i permessi del file non bastano: il file finisce in un
 * backup, in un volume clonato, nello snapshot di un disco. La chiave sta
 * nell'ambiente, il file no.
 *
 * Il subject del QMate entra come dato autenticato aggiuntivo, non come parte
 * del testo cifrato: così spostare un blob da una riga a un'altra non lo rende
 * illeggibile per errore, lo rende illeggibile per costruzione. Chi ottiene
 * scrittura sul database non può promuoversi al token di un altro copiandogli
 * la riga addosso.
 */

const CIPHER = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function seal(key: Buffer, secret: string, boundTo: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER, key, nonce);
  cipher.setAAD(Buffer.from(boundTo, 'utf8'));
  const sealed = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), sealed]);
}

/**
 * `null` su qualunque fallimento: chiave sbagliata, blob troncato, altro
 * subject, byte manomessi.
 *
 * Rende `null` invece di sollevare perché il chiamante deve trattare un token
 * illeggibile come un collegamento assente — «non hai collegato LinkedIn», che
 * un QMate può risolvere da solo — e non come un errore interno, che non gli
 * dice cosa fare. Il caso che accadrà davvero è la chiave persa o cambiata.
 */
export function unseal(key: Buffer, sealed: Buffer, boundTo: string): string | null {
  if (sealed.length <= NONCE_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv(CIPHER, key, sealed.subarray(0, NONCE_BYTES));
    decipher.setAAD(Buffer.from(boundTo, 'utf8'));
    decipher.setAuthTag(sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    return (
      decipher.update(sealed.subarray(NONCE_BYTES + TAG_BYTES), undefined, 'utf8') +
      decipher.final('utf8')
    );
  } catch {
    return null;
  }
}
