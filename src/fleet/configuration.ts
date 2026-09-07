import { canonicalResource } from './audience.js';

/**
 * Gli endpoint di LinkedIn NON sono configurabili, e non è una dimenticanza.
 *
 * Da `authBaseUrl` passa il client secret dell'app aziendale, da `apiBaseUrl`
 * passa l'access token di ogni QMate. Una variabile d'ambiente sbagliata di un
 * carattere — o copiata da un file di staging — li consegnerebbe a un terzo, e
 * quel secret è l'unico punto di compromissione che valga per tutti i QMate
 * insieme. I test non hanno bisogno di cambiarli qui: iniettano il proprio URL
 * costruendo direttamente il client.
 */
export const LINKEDIN = {
  apiBaseUrl: 'https://api.linkedin.com',
  authBaseUrl: 'https://www.linkedin.com/oauth/v2',
} as const;

/** Dove il servizio serve la propria metadata RFC 9728. */
export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
/** Dove LinkedIn rimanda il browser di un QMate dopo il consenso. */
export const LINKEDIN_CALLBACK_PATH = '/linkedin/callback';

const TOKEN_KEY_BYTES = 32;
const DEFAULT_PORT = 8080;

export interface ServiceConfiguration {
  /** La nostra resource in forma canonica: una voce di `QAS_AUDIENCES` lato AS. */
  resource: string;
  authorizationServer: string;
  introspection: { clientId: string; clientSecret: string };
  linkedIn: { clientId: string; clientSecret: string; redirectUri: string };
  /** La chiave con cui i token LinkedIn stanno cifrati a riposo. */
  tokenKey: Buffer;
  databasePath: string;
  port: number;
}

export class UnusableConfiguration extends Error {
  constructor(readonly problems: string[]) {
    super(`configurazione inutilizzabile:\n  ${problems.join('\n  ')}`);
  }
}

/**
 * Legge l'ambiente, o solleva nominando TUTTI i campi che non vanno.
 *
 * Tutti insieme, non il primo: un deploy che riparte sei volte per scoprire sei
 * variabili mancanti è sei finestre di servizio giù, e chi le sistema una per
 * volta non sa mai quante ne restano.
 */
export function loadConfiguration(environment: NodeJS.ProcessEnv = process.env): ServiceConfiguration {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = environment[name]?.trim();
    if (!value) {
      problems.push(`${name} manca`);
      return '';
    }
    return value;
  };

  const requiredResource = (name: string): string => {
    const value = environment[name]?.trim();
    if (!value) {
      problems.push(`${name} manca`);
      return '';
    }
    const canonical = canonicalResource(value);
    if (canonical === null) {
      problems.push(`${name} non è un URI (${JSON.stringify(value)})`);
      return '';
    }
    if (!canonical.startsWith('https://') && !servedFromThisMachine(canonical)) {
      problems.push(`${name} deve essere https (${canonical})`);
      return '';
    }
    return canonical;
  };

  const resource = requiredResource('QLI_RESOURCE_URL');
  const authorizationServer = requiredResource('QLI_AS_URL');
  const introspectionClientId = required('QLI_INTROSPECT_CLIENT_ID');
  const introspectionSecret = required('QLI_INTROSPECT_SECRET');
  const linkedInClientId = required('QLI_LINKEDIN_CLIENT_ID');
  const linkedInClientSecret = required('QLI_LINKEDIN_CLIENT_SECRET');
  // Nessun default: senza il volume il servizio scriverebbe nel filesystem del
  // container, e ogni collegamento LinkedIn spariresse al deploy successivo
  // senza un errore da nessuna parte.
  const databasePath = required('QLI_DB_PATH');
  const tokenKey = decodeTokenKey(environment.QLI_TOKEN_KEY?.trim(), problems);
  const port = decodePort(environment.QLI_PORT?.trim(), problems);

  if (problems.length > 0) throw new UnusableConfiguration(problems);

  return {
    resource,
    authorizationServer,
    introspection: { clientId: introspectionClientId, clientSecret: introspectionSecret },
    linkedIn: {
      clientId: linkedInClientId,
      clientSecret: linkedInClientSecret,
      // Derivata, non configurata: deve combaciare con ciò che è registrato
      // nell'app LinkedIn E con l'host su cui siamo serviti, e due variabili che
      // devono combaciare sono due variabili che prima o poi divergono.
      redirectUri: `${resource}${LINKEDIN_CALLBACK_PATH}`,
    },
    tokenKey,
    databasePath,
    port,
  };
}

/** L'unico caso in cui `http` è accettabile: il giro e2e in locale. */
function servedFromThisMachine(canonical: string): boolean {
  return canonical.startsWith('http://localhost') || canonical.startsWith('http://127.0.0.1');
}

function decodeTokenKey(encoded: string | undefined, problems: string[]): Buffer {
  if (!encoded) {
    problems.push('QLI_TOKEN_KEY manca');
    return Buffer.alloc(0);
  }
  const key = Buffer.from(encoded, 'base64');
  // `Buffer.from` non solleva su base64 invalida, tronca: la lunghezza è l'unico
  // controllo che distingue una chiave da un refuso.
  if (key.length !== TOKEN_KEY_BYTES) {
    problems.push(
      `QLI_TOKEN_KEY deve essere ${TOKEN_KEY_BYTES} byte in base64, ne ha ${key.length} ` +
        `(generane una con: openssl rand -base64 ${TOKEN_KEY_BYTES})`,
    );
    return Buffer.alloc(0);
  }
  return key;
}

function decodePort(value: string | undefined, problems: string[]): number {
  if (!value) return DEFAULT_PORT;
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    problems.push(`QLI_PORT non è una porta (${JSON.stringify(value)})`);
    return DEFAULT_PORT;
  }
  return Number(value);
}
