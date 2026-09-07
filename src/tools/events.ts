import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { LinkedInAsMember } from '../client/api-client.js';
import type { LinkedInLink } from '../linkedin/link.js';
import type { CreateEventRequest, LinkedInEvent } from '../types/index.js';
import { answering, reported } from './answer.js';

/** Eventi LinkedIn, organizzati dal QMate che sta chiedendo. */
export function registerEventTools(
  server: McpServer,
  linkedIn: LinkedInAsMember,
  link: LinkedInLink,
): void {
  server.tool(
    'linkedin_create_event',
    'Crea un evento LinkedIn a tuo nome: online, in presenza o ibrido.',
    {
      name: z.string().min(1).max(255).describe('Nome dell evento'),
      description: z.string().max(5000).optional().describe('Descrizione, massimo 5000 caratteri'),
      startDate: z.string().describe('Inizio in ISO 8601, per esempio 2026-10-01T10:00:00Z'),
      endDate: z.string().optional().describe('Fine in ISO 8601'),
      format: z.enum(['ONLINE', 'IN_PERSON', 'HYBRID']).default('ONLINE').describe('Formato'),
      eventUrl: z.string().url().optional().describe('Indirizzo dell evento, per esempio il link della call'),
    },
    ({ name, description, startDate, endDate, format, eventUrl }) =>
      answering(async () => {
        const event: CreateEventRequest = {
          organizer: link.personUrn() as `urn:li:person:${string}`,
          name,
          description,
          eventUrl,
          timeRange: { start: startDate, end: endDate },
          format,
        };
        const created = await linkedIn.post<{ id: string }>('/v2/events', event);
        return reported({ creato: true, eventId: created?.id, nome: name });
      }),
  );

  server.tool(
    'linkedin_get_event',
    'I dettagli di un evento LinkedIn.',
    { eventId: z.string().describe('L id o l urn dell evento') },
    ({ eventId }) =>
      answering(async () => reported(await linkedIn.get<LinkedInEvent>(`/v2/events/${encodeURIComponent(eventId)}`))),
  );
}
