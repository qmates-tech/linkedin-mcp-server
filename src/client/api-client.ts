import { LINKEDIN } from '../fleet/configuration.js';
import type { LinkedInLink } from '../linkedin/link.js';
import type { LinkedInApiErrorResponse } from '../types/index.js';
import { LinkedInApiError, RetryableError } from './errors.js';
import { linkedInVersionHeaders } from './linkedin-version.js';
import { RateLimiter, type RateLimitInfo } from './rate-limiter.js';

/**
 * LinkedIn, parlato come un QMate preciso.
 *
 * `LinkedInApi` è condiviso — tiene i contatori delle quote, che devono
 * sopravvivere alle singole richieste — e `as(link)` ne rende una facciata già
 * legata a un collegamento. I metodi della facciata non prendono un'identità,
 * quindi un tool non ha un bearer né un autore da sbagliare: nel fork il token
 * si risolveva da uno stato di processo, in un punto del codice diverso da
 * quello che componeva l'urn dell'autore, e le due cose potevano divergere.
 */

/**
 * Dove è lecito spedire il bearer di un QMate fuori dalle rotte API.
 *
 * L'URL di upload arriva dentro una risposta di LinkedIn, quindi è un dato
 * ricevuto: senza questo controllo una risposta manomessa — o un endpoint
 * sbagliato — farebbe fare una PUT autenticata verso un host scelto da altri,
 * con l'access token del QMate nell'header. L'elenco è nel codice, non in
 * configurazione: un confine che la configurazione può allargare è un confine
 * che si apre per un refuso in una env var.
 */
const HOSTS_ALLOWED_TO_RECEIVE_UPLOADS = ['linkedin.com', 'licdn.com'];

export interface RequestShape {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Gli endpoint non versionati (`/v2/userinfo`) rifiutano l'header di versione. */
  versioned?: boolean;
}

export interface LinkedInApiOptions {
  baseUrl?: string;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
}

export class LinkedInApi {
  private readonly quotas = new RateLimiter();
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: LinkedInApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? LINKEDIN.apiBaseUrl;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  as(link: LinkedInLink): LinkedInAsMember {
    return new LinkedInAsMember(link, this.baseUrl, this.maxRetries, this.fetch, this.quotas);
  }
}

export class LinkedInAsMember {
  constructor(
    private readonly link: LinkedInLink,
    private readonly baseUrl: string,
    private readonly maxRetries: number,
    private readonly fetch: typeof globalThis.fetch,
    private readonly quotas: RateLimiter,
  ) {}

  async request<T>(shape: RequestShape): Promise<T> {
    const endpoint = `${shape.method} ${shape.path}`;
    let rejectedOnce = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        await this.quotas.waitIfNeeded(this.link.forQMate, endpoint);
        // Il bearer e l'urn dell'autore vengono dallo stesso collegamento: se
        // il token si rinnova qui, resta il token di QUESTO membro.
        const token = await this.link.accessToken(rejectedOnce);

        const response = await this.fetch(`${this.baseUrl}${shape.path}`, {
          method: shape.method,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            ...((shape.versioned ?? true) ? linkedInVersionHeaders() : {}),
            ...shape.headers,
          },
          body: shape.body === undefined ? undefined : JSON.stringify(shape.body),
        });

        this.quotas.track(this.link.forQMate, endpoint, response.status, response.headers);

        if (response.status === 401 && attempt < this.maxRetries) {
          // Il fork ripresentava lo stesso token morto: il rinnovo scattava
          // solo sull'orologio locale, mai su un rifiuto vero.
          rejectedOnce = true;
          throw new RetryableError('LinkedIn ha rifiutato il token');
        }
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          throw new RetryableError('quota esaurita', retryAfter ? Number(retryAfter) * 1000 : undefined);
        }
        if (response.status >= 500 && attempt < this.maxRetries) {
          throw new RetryableError(`LinkedIn ha risposto ${response.status}`);
        }
        if (!response.ok) throw await asApiError(response);

        return (await readBody<T>(response)) as T;
      } catch (failure) {
        if (failure instanceof RetryableError && attempt < this.maxRetries) {
          await pause(failure.retryAfterMs ?? this.quotas.getBackoffDelay(attempt));
          continue;
        }
        throw failure;
      }
    }
    throw new Error('LinkedIn non ha risposto entro i tentativi previsti');
  }

  get<T>(path: string, versioned?: boolean): Promise<T> {
    return this.request<T>({ method: 'GET', path, versioned });
  }

  post<T>(path: string, body?: unknown, versioned?: boolean): Promise<T> {
    return this.request<T>({ method: 'POST', path, body, versioned });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>({ method: 'DELETE', path });
  }

  /** Il secondo passo dell'upload: i byte vanno all'URL che LinkedIn ha indicato. */
  async sendImageBytes(uploadUrl: string, bytes: Buffer, contentType: string): Promise<void> {
    if (!mayReceiveUploads(uploadUrl)) {
      throw new LinkedInApiError(0, `LinkedIn ha indicato un host di upload non previsto`);
    }
    const response = await this.fetch(uploadUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${await this.link.accessToken()}`, 'content-type': contentType },
      body: new Uint8Array(bytes),
    });
    if (!response.ok) {
      throw new LinkedInApiError(response.status, `upload dell immagine rifiutato (${response.status})`);
    }
  }

  /** Le quote di questo QMate: quelle di un altro non sono affar suo. */
  quotasSoFar(): RateLimitInfo[] {
    return this.quotas.infoFor(this.link.forQMate);
  }
}

function mayReceiveUploads(uploadUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uploadUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return HOSTS_ALLOWED_TO_RECEIVE_UPLOADS.some(
    (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
  );
}

async function asApiError(response: Response): Promise<LinkedInApiError> {
  let body: LinkedInApiErrorResponse;
  try {
    body = (await response.json()) as LinkedInApiErrorResponse;
  } catch {
    body = { status: response.status, message: response.statusText };
  }
  return LinkedInApiError.fromResponse(response.status, body);
}

async function readBody<T>(response: Response): Promise<T | undefined> {
  if (response.status === 204) return undefined;
  if (response.headers.get('content-type')?.includes('application/json')) {
    return (await response.json()) as T;
  }
  // Le creazioni rendono l'id della risorsa in un header, non nel corpo.
  const created = response.headers.get('x-restli-id');
  return created === null ? undefined : ({ id: created } as T);
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((elapsed) => setTimeout(elapsed, milliseconds));
}
