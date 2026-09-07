import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { QMateSubject } from '../fleet/acting-qmate.js';
import type { LinkedInLink } from '../linkedin/link.js';
import type { Linking } from '../linkedin/linking.js';
import { answering, reported, said } from './answer.js';

/**
 * Collegare e scollegare la propria LinkedIn.
 *
 * Nel fork il callback OAuth era un TOOL che prendeva `code` e `state` come
 * parametri liberi e poi installava l'identità nello stato di processo: da
 * remoto un QMate poteva replicare il flusso di un altro e diventare l'autore
 * di tutto. Qui il callback è una rotta HTTP e nessun tool riceve un code.
 */
export function registerLinkTools(
  server: McpServer,
  qmate: QMateSubject,
  link: LinkedInLink,
  linking: Linking,
): void {
  server.tool(
    'linkedin_link_start',
    'Avvia il collegamento del TUO account LinkedIn. Restituisce un indirizzo da aprire nel browser; al termine il browser mostra un codice da riportare con linkedin_link_confirm.',
    {},
    () =>
      answering(() => {
        const authorization = linking.beginLinking(qmate);
        return said(
          [
            'Apri questo indirizzo nel tuo browser e concedi l accesso a LinkedIn:',
            '',
            authorization,
            '',
            'Al ritorno il browser mostrerà un codice di conferma. Riportalo qui con',
            'linkedin_link_confirm — il collegamento non viene scritto prima.',
            '',
            'Il codice vale dieci minuti e serve solo a te: non darlo a nessuno.',
          ].join('\n'),
        );
      }),
  );

  server.tool(
    'linkedin_link_confirm',
    'Completa il collegamento riportando il codice mostrato dal browser.',
    {
      code: z.string().min(1).describe('Il codice di conferma mostrato dal browser, con o senza trattino'),
      replaceExistingLink: z
        .boolean()
        .optional()
        .describe('Necessario solo se stai collegando un account LinkedIn diverso da quello già collegato'),
    },
    ({ code, replaceExistingLink }) =>
      answering(() => {
        const outcome = linking.confirmLinking(qmate, code, replaceExistingLink ?? false);
        if (outcome.kind === 'linked') {
          return reported({
            collegato: true,
            membroLinkedIn: outcome.linkedInMemberId,
            permessi: outcome.scopes,
          });
        }
        if (outcome.kind === 'would_replace') {
          return {
            ...said(
              [
                `Hai già collegato il membro LinkedIn ${outcome.current}, e questo codice`,
                `collegherebbe ${outcome.incoming}.`,
                '',
                'Se è davvero il tuo secondo account, richiama linkedin_link_confirm con',
                'replaceExistingLink a true. Se non lo riconosci, non farlo: qualcun altro',
                'potrebbe aver consentito al posto tuo.',
              ].join('\n'),
            ),
            isError: true,
          };
        }
        return {
          ...said(
            'Codice non valido, già usato o scaduto. Riparti da linkedin_link_start.',
          ),
          isError: true,
        };
      }),
  );

  server.tool(
    'linkedin_link_status',
    'Dice se hai collegato LinkedIn, con quale account e fino a quando.',
    {},
    () =>
      answering(() => {
        // Si legge dalla propria riga, non con un giro su LinkedIn: il tool del
        // fork chiamava /v2/userinfo e quindi non poteva distinguere «non hai
        // collegato» da «il processo è collegato come qualcun altro».
        const state = link.state();
        if (state.kind === 'linked') {
          return reported({
            collegato: true,
            membroLinkedIn: state.summary.linkedInMemberId,
            permessi: state.summary.scopes,
            // L'unico permesso che cambia cosa si può fare: senza, ogni tool di
            // scrittura fallirà su LinkedIn e non qui.
            puoiPubblicare: state.summary.scopes.includes('w_member_social'),
            accessoValidoFino: new Date(state.summary.accessExpiresAt).toISOString(),
            collegatoIl: new Date(state.summary.linkedAt).toISOString(),
          });
        }
        if (state.kind === 'awaiting_confirmation') {
          return reported({
            collegato: false,
            inAttesaDiConferma: state.linkedInMemberId,
            cosaFare: 'Riporta il codice mostrato dal browser con linkedin_link_confirm.',
          });
        }
        if (state.kind === 'unreadable') {
          return reported({
            collegato: false,
            motivo: 'La chiave di cifratura non apre più il collegamento memorizzato.',
            cosaFare: 'Ricollega con linkedin_link_start.',
          });
        }
        return reported({ collegato: false, cosaFare: 'Collega con linkedin_link_start.' });
      }),
  );

  server.tool(
    'linkedin_unlink',
    'Scollega il tuo account LinkedIn da questo servizio e revoca l accesso.',
    {},
    () =>
      answering(async () => {
        const { revoked } = await link.forget();
        return reported({
          scollegato: true,
          revocatoSuLinkedIn: revoked,
          nota: revoked
            ? undefined
            : 'LinkedIn non ha confermato la revoca: controlla le app collegate nelle sue impostazioni.',
        });
      }),
  );
}
