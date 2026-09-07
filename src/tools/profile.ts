import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { LinkedInAsMember } from '../client/api-client.js';
import type { UserInfo } from '../types/index.js';
import { answering, reported, said } from './answer.js';

/**
 * Il profilo del QMate che sta chiedendo.
 *
 * «Mio» qui vuol dire suo. Nel fork voleva dire «di chiunque il processo si
 * fosse collegato per ultimo», quindi questi tre tool restituivano nome,
 * fotografia e indirizzo email di un altro QMate.
 */
export function registerProfileTools(server: McpServer, linkedIn: LinkedInAsMember): void {
  server.tool(
    'linkedin_get_my_profile',
    'Il tuo profilo LinkedIn: nome, immagine, lingua e indirizzo email.',
    {},
    () =>
      answering(async () => {
        // `/v2/userinfo` non è versionato e rifiuta l'header di versione.
        const profile = await linkedIn.get<UserInfo>('/v2/userinfo', false);
        return reported({
          id: profile.sub,
          nome: profile.name,
          nomeProprio: profile.given_name,
          cognome: profile.family_name,
          immagine: profile.picture,
          email: profile.email,
          emailVerificata: profile.email_verified,
          lingua: profile.locale,
        });
      }),
  );

  server.tool('linkedin_get_my_email', 'Il tuo indirizzo email su LinkedIn.', {}, () =>
    answering(async () => {
      const profile = await linkedIn.get<UserInfo>('/v2/userinfo', false);
      return reported({ email: profile.email, emailVerificata: profile.email_verified });
    }),
  );

  server.tool(
    'linkedin_get_my_quotas',
    'Quanta parte delle tue quote LinkedIn hai consumato, per endpoint chiamato.',
    {},
    () =>
      answering(() => {
        // Solo le sue: il fork rendeva i bucket di tutti, cioè un conteggio
        // aggregato dell'attività della flotta leggibile da chiunque avesse una
        // sessione. E le quote di LinkedIn sono per membro, quindi i numeri
        // aggregati non erano nemmeno quelli di qualcuno.
        const quotas = linkedIn.quotasSoFar();
        if (quotas.length === 0) {
          return said('Nessuna chiamata a LinkedIn ancora, in questa vita del servizio.');
        }
        return reported(
          quotas.map((quota) => ({
            endpoint: quota.endpoint,
            usate: quota.used,
            limite: quota.limit,
            siAzzeraIl: new Date(quota.resetAt).toISOString(),
          })),
        );
      }),
  );
}
