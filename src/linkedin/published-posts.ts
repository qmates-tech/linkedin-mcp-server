import type Database from 'better-sqlite3';

import type { QMateSubject } from '../fleet/acting-qmate.js';

/**
 * Il registro locale di ciò che un QMate ha pubblicato.
 *
 * Nel fork la tabella non aveva una colonna di proprietà: `list` leggeva le
 * righe di tutti e `remove` cancellava per chiave primaria, quindi un QMate
 * vedeva l'anteprima dei post di un altro e poteva cancellarne la traccia. Qui
 * il subject entra nella `WHERE` di ogni statement, e la vista è già legata a
 * un QMate: non c'è un parametro identità da sbagliare.
 */

export interface PublishedPost {
  postUrn: string;
  textPreview: string;
  visibility: string;
  hasImage: boolean;
  hasArticle: boolean;
  articleUrl: string | null;
  publishedAt: number;
}

export class PublishedPostsStore {
  constructor(private readonly database: Database.Database) {}

  of(qmate: QMateSubject): PublishedPosts {
    return new PublishedPosts(qmate, this.database);
  }
}

export class PublishedPosts {
  constructor(
    private readonly qmate: QMateSubject,
    private readonly database: Database.Database,
  ) {}

  record(post: Omit<PublishedPost, 'publishedAt'>, now = Date.now()): void {
    this.database
      .prepare(
        `INSERT INTO published_post (post_urn, qmate_subject, text_preview, visibility,
           has_image, has_article, article_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (post_urn) DO NOTHING`,
      )
      .run(
        post.postUrn,
        this.qmate,
        post.textPreview,
        post.visibility,
        post.hasImage ? 1 : 0,
        post.hasArticle ? 1 : 0,
        post.articleUrl,
        now,
      );
  }

  mostRecent(limit: number): PublishedPost[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM published_post WHERE qmate_subject = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(this.qmate, limit) as PostRow[];
    return rows.map(asPublishedPost);
  }

  /** `false` se quel post non è suo: la riga di un altro QMate non si tocca. */
  forget(postUrn: string): boolean {
    return (
      this.database
        .prepare('DELETE FROM published_post WHERE post_urn = ? AND qmate_subject = ?')
        .run(postUrn, this.qmate).changes > 0
    );
  }

  howMany(): number {
    const counted = this.database
      .prepare('SELECT COUNT(*) AS howMany FROM published_post WHERE qmate_subject = ?')
      .get(this.qmate) as { howMany: number };
    return counted.howMany;
  }
}

interface PostRow {
  post_urn: string;
  text_preview: string;
  visibility: string;
  has_image: number;
  has_article: number;
  article_url: string | null;
  created_at: number;
}

function asPublishedPost(row: PostRow): PublishedPost {
  return {
    postUrn: row.post_urn,
    textPreview: row.text_preview,
    visibility: row.visibility,
    hasImage: row.has_image === 1,
    hasArticle: row.has_article === 1,
    articleUrl: row.article_url,
    publishedAt: row.created_at,
  };
}
