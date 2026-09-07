/**
 * Gli header che LinkedIn pretende sulle sue API versionate.
 *
 * Le versioni sono mensili in forma `YYYYMM` e vengono dismesse dopo circa
 * dodici mesi, quindi fissarne una nel codice significa una rottura silenziosa
 * fra un anno senza che nessuno abbia toccato niente. Si deriva dalla data.
 *
 * Il mese è quello PRECEDENTE, non quello corrente: una versione non può
 * esistere prima che il suo mese inizi, e derivare il mese corrente
 * romperebbe ogni primo del mese fino alla pubblicazione. È una differenza
 * rispetto al fork, che usava il mese corrente; da verificare al primo
 * contatto con l'API vera, dove un errore di versione è esplicito.
 */
export function linkedInVersionHeaders(now = new Date()): Record<string, string> {
  const released = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const month = String(released.getUTCMonth() + 1).padStart(2, '0');
  return {
    'LinkedIn-Version': `${released.getUTCFullYear()}${month}`,
    'X-Restli-Protocol-Version': '2.0.0',
  };
}
