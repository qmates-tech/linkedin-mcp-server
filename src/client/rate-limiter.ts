/**
 * Il consumo delle quote LinkedIn, per QMate e per endpoint.
 *
 * Le quote di LinkedIn sono PER MEMBRO, quindi un contatore condiviso fra tutti
 * i QMate sbaglia due volte: riporta numeri che non sono quelli di nessuno, e
 * `waitIfNeeded` fa aspettare un QMate sul budget consumato da un altro. Nel
 * fork il bucket era chiavato sul solo `"METODO /path"` — un limitatore per
 * processo, in un servizio multi-tenant.
 *
 * I limiti si imparano dagli header di risposta e dai 429; la finestra è di 24
 * ore e si azzera a mezzanotte UTC.
 */

export interface RateLimitInfo {
  endpoint: string;
  used: number;
  limit: number;
  resetAt: number; // Unix timestamp ms
}

interface EndpointBucket {
  used: number;
  limit: number; // Learned from headers or 429s; starts conservative
  resetAt: number;
  lastUpdated: number;
}

const DEFAULT_LIMIT = 80; // Conservative default until we learn actual limits
const BACKOFF_BASE_MS = 1000;

export class RateLimiter {
  private buckets = new Map<string, EndpointBucket>();

  /**
   * Track a response to update rate limit counters.
   * Extracts limits from LinkedIn response headers when available.
   */
  track(caller: string, endpoint: string, status: number, headers: Headers): void {
    const bucket = this.getOrCreateBucket(bucketFor(caller, endpoint));
    bucket.used++;
    bucket.lastUpdated = Date.now();

    // LinkedIn sometimes sends rate limit headers
    const limit = headers.get('x-ratelimit-limit');
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');

    if (limit) {
      bucket.limit = parseInt(limit, 10);
    }
    if (remaining !== null) {
      // Adjust used count based on actual remaining
      bucket.used = bucket.limit - parseInt(remaining, 10);
    }
    if (reset) {
      bucket.resetAt = parseInt(reset, 10) * 1000; // Convert to ms
    }

    // If we got a 429, reduce our limit estimate
    if (status === 429) {
      bucket.limit = Math.max(1, bucket.used - 1);
      const retryAfter = headers.get('retry-after');
      if (retryAfter) {
        bucket.resetAt = Date.now() + parseInt(retryAfter, 10) * 1000;
      }
    }
  }

  /**
   * Check if we can make a call to this endpoint.
   */
  canCall(caller: string, endpoint: string): boolean {
    const bucket = this.getOrCreateBucket(bucketFor(caller, endpoint));
    this.resetIfExpired(bucket);
    return bucket.used < bucket.limit;
  }

  /**
   * Get current rate limit info for an endpoint.
   */
  getInfo(caller: string, endpoint: string): RateLimitInfo {
    const bucket = this.getOrCreateBucket(bucketFor(caller, endpoint));
    this.resetIfExpired(bucket);
    return {
      endpoint,
      used: bucket.used,
      limit: bucket.limit,
      resetAt: bucket.resetAt,
    };
  }

  /**
   * Quanto ha consumato QUESTO QMate.
   *
   * Il fork rendeva i bucket di tutti: un conteggio aggregato dell'attività
   * della flotta, leggibile da chiunque avesse una sessione.
   */
  infoFor(caller: string): RateLimitInfo[] {
    const mine = `${caller}\u0000`;
    return Array.from(this.buckets.entries())
      .filter(([key]) => key.startsWith(mine))
      .map(([key, bucket]) => {
        this.resetIfExpired(bucket);
        return {
          endpoint: key.slice(mine.length),
          used: bucket.used,
          limit: bucket.limit,
          resetAt: bucket.resetAt,
        };
      });
  }

  /**
   * Calculate delay (ms) if we need to wait before calling.
   * Returns 0 if we can call immediately.
   */
  getDelay(caller: string, endpoint: string): number {
    const bucket = this.getOrCreateBucket(bucketFor(caller, endpoint));
    this.resetIfExpired(bucket);

    if (bucket.used < bucket.limit) return 0;
    return Math.max(0, bucket.resetAt - Date.now());
  }

  /**
   * Wait if necessary before making a call.
   */
  async waitIfNeeded(caller: string, endpoint: string): Promise<void> {
    const delay = this.getDelay(caller, endpoint);
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /**
   * Get exponential backoff delay for retries.
   */
  getBackoffDelay(attempt: number): number {
    const jitter = Math.random() * 500;
    return Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt) + jitter, 60000);
  }

  private getOrCreateBucket(key: string): EndpointBucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        used: 0,
        limit: DEFAULT_LIMIT,
        resetAt: this.getNextMidnightUtc(),
        lastUpdated: Date.now(),
      };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private resetIfExpired(bucket: EndpointBucket): void {
    if (Date.now() >= bucket.resetAt) {
      bucket.used = 0;
      bucket.resetAt = this.getNextMidnightUtc();
    }
  }

  private getNextMidnightUtc(): number {
    const now = new Date();
    const midnight = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0, 0, 0, 0,
    ));
    return midnight.getTime();
  }
}

/** Il byte nullo non compare né in un subject né in un path: separa senza ambiguità. */
function bucketFor(caller: string, endpoint: string): string {
  return `${caller}\u0000${endpoint}`;
}
