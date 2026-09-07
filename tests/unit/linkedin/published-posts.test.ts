import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { QMateSubject } from '../../../src/fleet/acting-qmate.js';
import { LinkStore } from '../../../src/linkedin/link-store.js';
import { PublishedPostsStore, type PublishedPosts } from '../../../src/linkedin/published-posts.js';

const FABRIZIO = '106977126509011341120' as QMateSubject;
const ANOTHER_QMATE = '999888777666555444333' as QMateSubject;
const NOW = 1_757_000_000_000;

function aPost(postUrn: string, textPreview = 'un post') {
  return { postUrn, textPreview, visibility: 'PUBLIC', hasImage: false, hasArticle: false, articleUrl: null };
}

let store: LinkStore;
let his: PublishedPosts;
let hers: PublishedPosts;

beforeEach(() => {
  store = new LinkStore(':memory:', randomBytes(32));
  const posts = new PublishedPostsStore(store.database);
  his = posts.of(FABRIZIO);
  hers = posts.of(ANOTHER_QMATE);
});

afterEach(() => {
  store.close();
});

describe('il registro dei post', () => {
  it('rende i suoi, dal più recente', () => {
    his.record(aPost('urn:1', 'il primo'), NOW);
    his.record(aPost('urn:2', 'il secondo'), NOW + 1000);
    expect(his.mostRecent(10).map((post) => post.textPreview)).toEqual(['il secondo', 'il primo']);
  });

  it('rispetta il limite chiesto', () => {
    his.record(aPost('urn:1'), NOW);
    his.record(aPost('urn:2'), NOW + 1000);
    expect(his.mostRecent(1)).toHaveLength(1);
  });

  it('conta i suoi', () => {
    his.record(aPost('urn:1'), NOW);
    expect(his.howMany()).toBe(1);
  });
});

// Nel fork la tabella non aveva colonna di proprietà: `list` leggeva le righe
// di tutti e `remove` cancellava per chiave primaria.
describe('due QMate nello stesso registro', () => {
  beforeEach(() => {
    his.record(aPost('urn:suo', 'roba sua'), NOW);
    hers.record(aPost('urn:altrui', 'roba altrui'), NOW + 1000);
  });

  it('non leggono le anteprime dell altro', () => {
    expect(his.mostRecent(10).map((post) => post.postUrn)).toEqual(['urn:suo']);
    expect(hers.mostRecent(10).map((post) => post.postUrn)).toEqual(['urn:altrui']);
  });

  it('non si contano a vicenda', () => {
    expect(his.howMany()).toBe(1);
    expect(hers.howMany()).toBe(1);
  });

  it('non cancellano la traccia dell altro, nemmeno conoscendone l urn', () => {
    expect(his.forget('urn:altrui')).toBe(false);
    expect(hers.mostRecent(10)).toHaveLength(1);
  });

  it('cancellano la propria', () => {
    expect(his.forget('urn:suo')).toBe(true);
    expect(his.mostRecent(10)).toEqual([]);
  });
});
