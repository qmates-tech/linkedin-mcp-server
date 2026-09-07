#!/usr/bin/env node

/**
 * `mcp-linkedin`: il resource server LinkedIn della flotta QMates.
 *
 * Un normale processo HTTP che parla MCP Streamable HTTP su `/mcp` e non
 * pubblica porte: sta sulla rete `fleet` e lo espone l'edge. Chi sei lo dice
 * `auth.qmates.tech`; cosa colleghi resta qui.
 */

import { IntrospectionVerifier } from './fleet/introspection.js';
import { loadConfiguration, UnusableConfiguration } from './fleet/configuration.js';
import { LinkedInLinks } from './linkedin/link.js';
import { LinkStore } from './linkedin/link-store.js';
import { Linking } from './linkedin/linking.js';
import { PublishedPostsStore } from './linkedin/published-posts.js';
import { mcpServerFor } from './server.js';
import { buildService } from './service.js';

/**
 * `EX_CONFIG` di sysexits: distingue «mal configurato» da «crashato», e serve
 * al deploy per non riprovare ciò che non può riuscire.
 *
 * Va usato con `process.exit` esplicito: `process.exitCode` seguito da un
 * throw esce con 1, perché il percorso di eccezione fatale di Node lo ignora.
 */
const MISCONFIGURED = 78;

function main(): void {
  let configuration;
  try {
    configuration = loadConfiguration();
  } catch (unusable) {
    if (unusable instanceof UnusableConfiguration) {
      process.stderr.write(`${unusable.message}\n`);
      process.exit(MISCONFIGURED);
    }
    throw unusable;
  }

  const store = new LinkStore(configuration.databasePath, configuration.tokenKey);
  const linking = new Linking({
    store,
    clientId: configuration.linkedIn.clientId,
    clientSecret: configuration.linkedIn.clientSecret,
    redirectUri: configuration.linkedIn.redirectUri,
  });

  const service = buildService({
    configuration,
    linking,
    verifier: new IntrospectionVerifier({
      authorizationServer: configuration.authorizationServer,
      resource: configuration.resource,
      clientId: configuration.introspection.clientId,
      clientSecret: configuration.introspection.clientSecret,
    }),
    mcpServerFor: mcpServerFor({
      links: new LinkedInLinks(store, linking),
      linking,
      publishedPosts: new PublishedPostsStore(store.database),
    }),
  });

  const listening = service.listen(configuration.port, '0.0.0.0', () => {
    process.stdout.write(
      `${JSON.stringify({
        event: 'listening',
        port: configuration.port,
        resource: configuration.resource,
        authorizationServer: configuration.authorizationServer,
      })}\n`,
    );
  });

  const stopServing = (): void => {
    listening.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', stopServing);
  process.on('SIGTERM', stopServing);
}

main();
