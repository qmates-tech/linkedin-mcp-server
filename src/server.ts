import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { LinkedInApi } from './client/api-client.js';
import type { QMateSubject } from './fleet/acting-qmate.js';
import type { LinkedInLinks } from './linkedin/link.js';
import type { Linking } from './linkedin/linking.js';
import type { PublishedPostsStore } from './linkedin/published-posts.js';
import { registerEventTools } from './tools/events.js';
import { registerLinkTools } from './tools/link.js';
import { registerPostingTools } from './tools/posting.js';
import { registerProfileTools } from './tools/profile.js';

const NAME = 'mcp-linkedin';
const VERSION = '1.0.0';

export interface LinkedInService {
  links: LinkedInLinks;
  linking: Linking;
  publishedPosts: PublishedPostsStore;
  linkedIn?: LinkedInApi;
}

/**
 * Un `McpServer` per richiesta, col QMate legato alla costruzione.
 *
 * Tutti i quindici tool sono registrati sempre. Il fork calcolava quali abilitare
 * dagli scope concessi e poi buttava il risultato; farlo davvero, qui, sarebbe
 * peggio: la lista dei tool cambierebbe sotto i piedi di un client che l'ha
 * chiesta al collegamento, e un tool che manca è più difficile da capire di un
 * tool che dice «non hai collegato LinkedIn, usa linkedin_link_start».
 */
export function mcpServerFor(service: LinkedInService): (qmate: QMateSubject) => McpServer {
  const linkedInApi = service.linkedIn ?? new LinkedInApi();

  return (qmate: QMateSubject): McpServer => {
    const server = new McpServer({ name: NAME, version: VERSION });
    const link = service.links.of(qmate);
    const asMember = linkedInApi.as(link);

    registerLinkTools(server, qmate, link, service.linking);
    registerProfileTools(server, asMember);
    registerPostingTools(server, asMember, link, service.publishedPosts.of(qmate));
    registerEventTools(server, asMember, link);

    return server;
  };
}
