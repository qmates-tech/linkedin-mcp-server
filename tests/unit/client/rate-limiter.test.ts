import { beforeEach, describe, expect, it } from 'vitest';

import { RateLimiter } from '../../../src/client/rate-limiter.js';

const FABRIZIO = '106977126509011341120';
const ANOTHER_QMATE = '999888777666555444333';

let quotas: RateLimiter;

beforeEach(() => {
  quotas = new RateLimiter();
});

function headers(values: Record<string, string> = {}): Headers {
  return new Headers(values);
}

describe('il consumo di un QMate', () => {
  it('parte da zero e cresce a ogni chiamata', () => {
    quotas.track(FABRIZIO, 'POST /v2/posts', 200, headers());
    quotas.track(FABRIZIO, 'POST /v2/posts', 200, headers());
    expect(quotas.getInfo(FABRIZIO, 'POST /v2/posts').used).toBe(2);
  });

  it('impara il limite vero dagli header di LinkedIn', () => {
    quotas.track(FABRIZIO, 'GET /v2/userinfo', 200, headers({
      'x-ratelimit-limit': '500',
      'x-ratelimit-remaining': '498',
    }));
    const info = quotas.getInfo(FABRIZIO, 'GET /v2/userinfo');
    expect(info).toMatchObject({ limit: 500, used: 2 });
  });

  it('abbassa la stima quando LinkedIn risponde 429', () => {
    for (let call = 0; call < 5; call += 1) {
      quotas.track(FABRIZIO, 'POST /v2/posts', 200, headers());
    }
    quotas.track(FABRIZIO, 'POST /v2/posts', 429, headers({ 'retry-after': '60' }));
    expect(quotas.getInfo(FABRIZIO, 'POST /v2/posts').limit).toBeLessThanOrEqual(6);
  });

  it('blocca le chiamate quando ha esaurito', () => {
    expect(quotas.canCall(FABRIZIO, 'GET /v2/test')).toBe(true);
    for (let call = 0; call < 80; call += 1) {
      quotas.track(FABRIZIO, 'GET /v2/test', 200, headers());
    }
    expect(quotas.canCall(FABRIZIO, 'GET /v2/test')).toBe(false);
    expect(quotas.getDelay(FABRIZIO, 'GET /v2/test')).toBeGreaterThan(0);
  });
});

// Le quote di LinkedIn sono PER MEMBRO. Nel fork il bucket era chiavato sul
// solo `"METODO /path"`, quindi il traffico di un QMate consumava — e faceva
// aspettare — il budget di tutti gli altri.
describe('due QMate non si consumano le quote a vicenda', () => {
  beforeEach(() => {
    for (let call = 0; call < 80; call += 1) {
      quotas.track(FABRIZIO, 'POST /v2/posts', 200, headers());
    }
  });

  it('chi non ha chiamato può ancora chiamare', () => {
    expect(quotas.canCall(FABRIZIO, 'POST /v2/posts')).toBe(false);
    expect(quotas.canCall(ANOTHER_QMATE, 'POST /v2/posts')).toBe(true);
    expect(quotas.getDelay(ANOTHER_QMATE, 'POST /v2/posts')).toBe(0);
  });

  it('e non legge i conteggi dell altro', () => {
    expect(quotas.infoFor(ANOTHER_QMATE)).toEqual([]);
    expect(quotas.infoFor(FABRIZIO)).toEqual([
      expect.objectContaining({ endpoint: 'POST /v2/posts', used: 80 }),
    ]);
  });
});

describe('l elenco delle proprie quote', () => {
  it('nomina gli endpoint chiamati, senza il subject davanti', () => {
    quotas.track(FABRIZIO, 'GET /v2/userinfo', 200, headers());
    quotas.track(FABRIZIO, 'POST /v2/posts', 201, headers());
    expect(quotas.infoFor(FABRIZIO).map((quota) => quota.endpoint).sort()).toEqual([
      'GET /v2/userinfo',
      'POST /v2/posts',
    ]);
  });

  it('è vuoto finché non si è chiamato niente', () => {
    expect(quotas.infoFor(FABRIZIO)).toEqual([]);
  });
});

describe('il backoff fra i tentativi', () => {
  it('cresce a ogni tentativo', () => {
    const delays = [0, 1, 2].map((attempt) => quotas.getBackoffDelay(attempt));
    expect(delays[1]).toBeGreaterThan(delays[0]!);
    expect(delays[2]).toBeGreaterThan(delays[1]!);
  });

  it('non supera il minuto', () => {
    expect(quotas.getBackoffDelay(100)).toBeLessThanOrEqual(60_500);
  });
});
