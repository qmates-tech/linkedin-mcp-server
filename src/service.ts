import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import { actingQMate, type QMateSubject } from './fleet/acting-qmate.js';
import {
  LINKEDIN_CALLBACK_PATH,
  PROTECTED_RESOURCE_METADATA_PATH,
  type ServiceConfiguration,
} from './fleet/configuration.js';
import { awaitingConfirmationPage, consentRefusedPage } from './linkedin/consent-page.js';
import type { Linking } from './linkedin/linking.js';

/**
 * Il corpo di una chiamata MCP è piccolo, tranne quando porta un'immagine in
 * base64 — che è il prezzo di non accettare percorsi locali (standard §4).
 */
const LARGEST_MCP_BODY = '12mb';

export interface ServiceDependencies {
  configuration: ServiceConfiguration;
  verifier: OAuthTokenVerifier;
  linking: Linking;
  /**
   * Un `McpServer` per richiesta, col QMate già legato.
   *
   * Per richiesta e non condiviso perché `Protocol.connect` solleva
   * `Already connected` se un transport c'è già: un server riusato fra
   * richieste concorrenti non è un'ottimizzazione, non funziona. Ed è la
   * proprietà che vogliamo comunque — il tenant è un parametro di costruzione,
   * quindi nessun tool ha un subject da sbagliare.
   */
  mcpServerFor: (qmate: QMateSubject) => McpServer;
}

export function buildService({
  configuration,
  verifier,
  linking,
  mcpServerFor,
}: ServiceDependencies): Express {
  const service = express();
  service.disable('x-powered-by');
  // Dietro l'edge il socket remoto è sempre Caddy, quindi senza questo `req.ip`
  // sarebbe l'indirizzo del container per tutti: un solo bucket per il mondo.
  service.set('trust proxy', 1);

  // Standard §6: risponde senza toccare nessuna dipendenza, e non dice nulla di
  // più. Il frammento Caddy non ha matcher di path, quindi qualunque cosa esposta
  // qui è pubblica su Internet: un conteggio dei QMate collegati sarebbe una
  // metrica di adozione interna leggibile da chiunque.
  service.get('/healthz', (_request, response) => {
    response.json({ status: 'ok' });
  });

  // RFC 9728, scritta a mano. `mcpAuthMetadataRouter` dell'SDK pubblicherebbe
  // `new URL(resource).href`, che aggiunge uno slash finale, e monterebbe anche
  // una COPIA della metadata dell'AS sotto il nostro host — due cose che non
  // vogliamo: l'AS si dichiara da sé, e una copia invecchia.
  const protectedResource = Object.freeze({
    resource: configuration.resource,
    authorization_servers: [configuration.authorizationServer],
    bearer_methods_supported: ['header'],
  });
  // Solo la forma alla radice. Un client che tirasse a indovinare dal path
  // dell'endpoint MCP (`.../oauth-protected-resource/mcp`) riceve 404 e ripiega
  // qui, che è la forma che il login reale del 2026-09-07 ha percorso; servire
  // lo stesso documento su due path significherebbe invece dichiarare la stessa
  // `resource` sotto due identificatori diversi, e lo standard §5 dice che
  // `https://host` e `https://host/mcp` sono due risorse.
  service.get(PROTECTED_RESOURCE_METADATA_PATH, (_request, response) => {
    response.json(protectedResource);
  });

  // L'unico endpoint anonimo del servizio, e non ha bisogno di un tetto sulle
  // richieste: uno `state` mai emesso viene rifiutato da una lettura di indice,
  // prima di qualunque chiamata verso LinkedIn. Il costo per chi tira a
  // indovinare è quello di una query, non quello di un round-trip in uscita.
  service.get(LINKEDIN_CALLBACK_PATH, async (request, response) => {
    // Il codice di conferma non deve finire in nessuna cache: né del browser,
    // né di un proxy che qualcuno metterà davanti un giorno.
    response.set('cache-control', 'no-store');
    response.type('html');
    const outcome = request.query.error
      ? ({ kind: 'refused' } as const)
      : await linking.consentArrived(request.query.state, request.query.code);
    if (outcome.kind !== 'awaiting_confirmation') {
      response.status(400).send(consentRefusedPage());
      return;
    }
    response.send(awaitingConfirmationPage(outcome.confirmationCode, outcome.memberName));
  });

  const requireQMate = requireBearerAuth({
    verifier,
    resourceMetadataUrl: `${configuration.resource}${PROTECTED_RESOURCE_METADATA_PATH}`,
  });

  // L'ordine è la proprietà di sicurezza: il bearer PRIMA del parser del corpo.
  // Invertiti, una richiesta anonima verrebbe interamente bufferizzata e
  // deserializzata prima di essere rifiutata, e con un solo processo dietro
  // l'edge basterebbero poche connessioni lente a occupare tutta la memoria.
  service.post('/mcp', requireQMate, express.json({ limit: LARGEST_MCP_BODY }), serveMcp(mcpServerFor));

  // In modalità stateless non c'è flusso da riprendere né sessione da chiudere:
  // dirlo con un 405 è più utile del 404 di default, che somiglia a un servizio
  // montato sul path sbagliato.
  service.all('/mcp', (_request, response) => {
    response.status(405).json({ error: 'solo POST: questo servizio non tiene sessioni' });
  });

  service.use(hideInternalFailures);
  return service;
}

function serveMcp(mcpServerFor: (qmate: QMateSubject) => McpServer) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    let server: McpServer;
    try {
      server = mcpServerFor(actingQMate(request.auth));
    } catch (noTenant) {
      next(noTenant);
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (failed) {
      next(failed);
    }
  };
}

/**
 * Un guasto inatteso non racconta com'è fatto il servizio.
 *
 * Senza questo, express risponde con lo stack trace a chiunque quando
 * `NODE_ENV` non è `production` — e la prima volta che si prova l'immagine a
 * mano, `NODE_ENV` non è impostato.
 */
function hideInternalFailures(failure: unknown, _request: Request, response: Response, _next: NextFunction): void {
  process.stderr.write(
    `${JSON.stringify({
      event: 'request_failed',
      failure: failure instanceof Error ? failure.name : typeof failure,
      detail: failure instanceof Error ? failure.message : undefined,
    })}\n`,
  );
  if (response.headersSent) {
    response.end();
    return;
  }
  response.status(500).json({ error: 'errore interno' });
}
