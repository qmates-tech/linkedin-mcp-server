import { readableCode } from './linking.js';

/**
 * Le due pagine che un browser vede tornando da LinkedIn.
 *
 * Il fallimento ne rende UNA sola, sempre la stessa: questo endpoint è anonimo,
 * e distinguere «state mai emesso» da «state già usato» da «LinkedIn ha
 * rifiutato lo scambio» direbbe a chi tira a indovinare quanto si è avvicinato.
 *
 * La pagina di successo mostra il codice e nomina il membro LinkedIn che si sta
 * collegando, perché è l'unico punto del flusso in cui una persona può
 * accorgersi che sta consentendo per la sessione di qualcun altro — ed è il
 * motivo per cui dice di non riportarlo a nessuno.
 */

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         margin: 0; display: grid; place-items: center; min-height: 100vh; padding: 2rem; }
  main { max-width: 34rem; }
  h1 { font-size: 1.3rem; margin: 0 0 1rem; }
  code { font-size: 2rem; letter-spacing: .12em; font-weight: 600;
         display: block; padding: 1rem 0; }
  .who { font-weight: 600; }
  .warn { border-left: 3px solid currentColor; padding-left: 1rem; opacity: .85; }
  p { margin: 0 0 1rem; }
`;

export function awaitingConfirmationPage(confirmationCode: string, memberName: string): string {
  return page(
    'LinkedIn: un passo ancora',
    `<h1>Un passo ancora</h1>
     <p>Stai collegando l'account LinkedIn di <span class="who">${escaped(memberName)}</span>.</p>
     <p>Riporta questo codice nella sessione in cui hai avviato il collegamento:</p>
     <code>${escaped(readableCode(confirmationCode))}</code>
     <p class="warn">Se non hai avviato tu questo collegamento dal tuo Claude, chiudi questa
     pagina e <strong>non dare il codice a nessuno</strong>: servirebbe a collegare il tuo
     LinkedIn all'assistente di un'altra persona, che potrebbe poi pubblicare a tuo nome.</p>`,
  );
}

export function consentRefusedPage(): string {
  return page(
    'LinkedIn: collegamento non completato',
    `<h1>Collegamento non completato</h1>
     <p>Questo link non è più valido, oppure il consenso non è andato a buon fine.</p>
     <p>Riparti dalla tua sessione Claude con <code style="font-size:1rem">linkedin_link_start</code>.</p>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

/** Il nome del membro arriva da LinkedIn: è testo di terzi, non nostro. */
function escaped(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
