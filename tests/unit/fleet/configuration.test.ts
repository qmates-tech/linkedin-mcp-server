import { describe, expect, it } from 'vitest';

import { LINKEDIN, loadConfiguration, UnusableConfiguration } from '../../../src/fleet/configuration.js';

const COMPLETE = {
  QLI_RESOURCE_URL: 'https://mcp-linkedin.qmates.tech',
  QLI_AS_URL: 'https://auth.qmates.tech',
  QLI_INTROSPECT_CLIENT_ID: 'mcp-linkedin',
  QLI_INTROSPECT_SECRET: 'un-segreto',
  QLI_LINKEDIN_CLIENT_ID: 'un-client-id',
  QLI_LINKEDIN_CLIENT_SECRET: 'un-client-secret',
  QLI_DB_PATH: '/data/linkedin.db',
  QLI_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
};

function problemsOf(environment: Record<string, string | undefined>): string[] {
  try {
    loadConfiguration(environment);
  } catch (refused) {
    if (refused instanceof UnusableConfiguration) return refused.problems;
    throw refused;
  }
  return [];
}

describe('un ambiente completo', () => {
  it('rende le due URL in forma canonica, che è quella su cui si confronterà l aud', () => {
    const configuration = loadConfiguration({
      ...COMPLETE,
      QLI_RESOURCE_URL: '  HTTPS://MCP-LinkedIn.QMates.Tech/  ',
      QLI_AS_URL: 'https://auth.qmates.tech/',
    });
    expect(configuration.resource).toBe('https://mcp-linkedin.qmates.tech');
    expect(configuration.authorizationServer).toBe('https://auth.qmates.tech');
  });

  it('deriva la redirect URI di LinkedIn dalla resource, invece di farsela dire', () => {
    // Due variabili che devono combaciare sono due variabili che divergono.
    expect(loadConfiguration(COMPLETE).linkedIn.redirectUri).toBe(
      'https://mcp-linkedin.qmates.tech/linkedin/callback',
    );
  });

  it('usa 8080 se nessuno dice altrimenti', () => {
    expect(loadConfiguration(COMPLETE).port).toBe(8080);
    expect(loadConfiguration({ ...COMPLETE, QLI_PORT: '9001' }).port).toBe(9001);
  });

  it('non permette a nessuna variabile di spostare gli endpoint di LinkedIn', () => {
    // Da authBaseUrl passa il client secret aziendale, da apiBaseUrl l access
    // token di ogni QMate: un refuso li consegnerebbe a un terzo.
    const configuration = loadConfiguration({
      ...COMPLETE,
      QLI_LINKEDIN_AUTH_BASE_URL: 'https://evil.example.com',
      QLI_LINKEDIN_API_BASE_URL: 'https://evil.example.com',
    });
    expect(JSON.stringify(configuration)).not.toContain('evil.example.com');
    expect(LINKEDIN.authBaseUrl).toBe('https://www.linkedin.com/oauth/v2');
    expect(LINKEDIN.apiBaseUrl).toBe('https://api.linkedin.com');
  });
});

describe('un ambiente incompleto', () => {
  it('nomina TUTTI i campi che mancano, non il primo', () => {
    // Un deploy che riparte otto volte per scoprire otto variabili è otto
    // finestre di servizio giù.
    expect(problemsOf({})).toEqual([
      'QLI_RESOURCE_URL manca',
      'QLI_AS_URL manca',
      'QLI_INTROSPECT_CLIENT_ID manca',
      'QLI_INTROSPECT_SECRET manca',
      'QLI_LINKEDIN_CLIENT_ID manca',
      'QLI_LINKEDIN_CLIENT_SECRET manca',
      'QLI_DB_PATH manca',
      'QLI_TOKEN_KEY manca',
    ]);
  });

  it('tratta una variabile di soli spazi come assente', () => {
    expect(problemsOf({ ...COMPLETE, QLI_INTROSPECT_SECRET: '   ' })).toEqual([
      'QLI_INTROSPECT_SECRET manca',
    ]);
  });

  it.each([
    ['QLI_RESOURCE_URL', 'mcp-linkedin.qmates.tech', 'non è un URI'],
    ['QLI_AS_URL', 'auth.qmates.tech', 'non è un URI'],
    ['QLI_RESOURCE_URL', 'http://mcp-linkedin.qmates.tech', 'deve essere https'],
    ['QLI_AS_URL', 'http://auth.qmates.tech', 'deve essere https'],
  ])('rifiuta %s = %o', (name, value, because) => {
    const problems = problemsOf({ ...COMPLETE, [name]: value });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(name);
    expect(problems[0]).toContain(because);
  });

  it('accetta http solo in locale, dove gira il giro e2e', () => {
    expect(problemsOf({ ...COMPLETE, QLI_RESOURCE_URL: 'http://localhost:8080' })).toEqual([]);
  });

  it.each([
    ['una chiave troppo corta', Buffer.alloc(16).toString('base64')],
    ['una chiave troppo lunga', Buffer.alloc(64).toString('base64')],
    ['qualcosa che non è base64', 'non-una-chiave!!'],
  ])('rifiuta %s e dice come generarne una', (_caso, key) => {
    const problems = problemsOf({ ...COMPLETE, QLI_TOKEN_KEY: key });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('QLI_TOKEN_KEY');
    expect(problems[0]).toContain('openssl rand -base64 32');
  });

  it.each(['0', '65536', 'ottomila', '80.5'])('rifiuta QLI_PORT = %o', (port) => {
    expect(problemsOf({ ...COMPLETE, QLI_PORT: port })).toEqual([
      `QLI_PORT non è una porta (${JSON.stringify(port)})`,
    ]);
  });
});
