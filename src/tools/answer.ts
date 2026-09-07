import { LinkedInApiError } from '../client/errors.js';
import { LinkNoLongerValid, NotLinked } from '../linkedin/link.js';

/**
 * Cosa un tool risponde, e cosa NON racconta quando va male.
 *
 * Nel fork ogni tool ripeteva lo stesso try/catch che stringificava qualunque
 * cosa fosse stata sollevata: quindici copie della stessa decisione, e un
 * guasto interno finiva nel testo che il modello legge. Qui la decisione sta in
 * un posto: i guasti che il QMate può risolvere portano il proprio messaggio,
 * gli altri diventano una frase sola e una riga di log.
 */

export interface ToolAnswer {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export function said(text: string): ToolAnswer {
  return { content: [{ type: 'text', text }] };
}

export function reported(value: unknown): ToolAnswer {
  return said(JSON.stringify(value, null, 2));
}

export async function answering(work: () => Promise<ToolAnswer> | ToolAnswer): Promise<ToolAnswer> {
  try {
    return await work();
  } catch (failure) {
    return { ...said(explain(failure)), isError: true };
  }
}

function explain(failure: unknown): string {
  // Questi tre il QMate li può risolvere da sé, e il messaggio dice come.
  if (failure instanceof NotLinked || failure instanceof LinkNoLongerValid) return failure.message;
  if (failure instanceof LinkedInApiError) return `LinkedIn ha rifiutato: ${failure.message}`;
  process.stderr.write(
    `${JSON.stringify({
      event: 'tool_failed',
      failure: failure instanceof Error ? failure.name : typeof failure,
      detail: failure instanceof Error ? failure.message : undefined,
    })}\n`,
  );
  return 'Qualcosa è andato storto dentro il servizio; il dettaglio è nei log.';
}
