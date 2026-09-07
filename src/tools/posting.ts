import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { LinkedInAsMember } from '../client/api-client.js';
import type { LinkedInLink } from '../linkedin/link.js';
import type { PublishedPosts } from '../linkedin/published-posts.js';
import type {
  CreateCommentRequest,
  CreatePostRequest,
  InitializeUploadResponse,
  PostVisibility,
  ReactionType,
} from '../types/index.js';
import { answering, reported, said } from './answer.js';

/**
 * Pubblicare a nome del QMate che sta chiedendo, e di nessun altro.
 *
 * L'urn dell'autore e il bearer vengono dallo STESSO collegamento: nel fork
 * l'uno si componeva da uno stato di processo e l'altro si risolveva altrove,
 * quindi potevano divergere — ed è la coppia di righe con cui si pubblica sul
 * profilo di un altro.
 */

/**
 * Il tetto sui byte di un'immagine.
 *
 * L'immagine arriva in base64 dentro il corpo JSON-RPC, che il servizio limita
 * a 12 MB; il base64 gonfia di un terzo, quindi oltre questa soglia la
 * richiesta verrebbe troncata dal parser prima di arrivare qui, con un errore
 * che non spiegherebbe niente.
 */
const LARGEST_IMAGE_BYTES = 8 * 1024 * 1024;

/** Quali immagini LinkedIn accetta, riconosciute dai byte e non da un nome. */
const IMAGE_SIGNATURES: Array<{ contentType: string; matches: (bytes: Buffer) => boolean }> = [
  { contentType: 'image/jpeg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    contentType: 'image/png',
    matches: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  { contentType: 'image/gif', matches: (b) => b.toString('ascii', 0, 3) === 'GIF' },
  {
    contentType: 'image/webp',
    matches: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
];

const IMAGE_URN = /^urn:li:image:[A-Za-z0-9_-]+$/;

export function registerPostingTools(
  server: McpServer,
  linkedIn: LinkedInAsMember,
  link: LinkedInLink,
  posts: PublishedPosts,
): void {
  server.tool(
    'linkedin_create_post',
    'Pubblica un post sul tuo profilo LinkedIn. Per allegare un immagine usa prima linkedin_upload_image.',
    {
      text: z.string().min(1).max(3000).describe('Il testo del post, massimo 3000 caratteri'),
      visibility: z
        .enum(['PUBLIC', 'CONNECTIONS', 'LOGGED_IN'])
        .default('PUBLIC')
        .describe('PUBLIC (chiunque), CONNECTIONS (collegamenti di primo grado), LOGGED_IN (chi ha un account)'),
      articleUrl: z.string().url().optional().describe('Un indirizzo da allegare come articolo'),
      articleTitle: z.string().optional().describe('Titolo dell articolo allegato'),
      articleDescription: z.string().optional().describe('Descrizione dell articolo allegato'),
      imageUrn: z.string().optional().describe('L urn reso da linkedin_upload_image'),
      imageAltText: z.string().optional().describe('Testo alternativo dell immagine'),
    },
    ({ text, visibility, articleUrl, articleTitle, articleDescription, imageUrn, imageAltText }) =>
      answering(async () => {
        // Nel fork i due rami assegnavano entrambi `content`, quindi passando
        // sia un articolo sia un immagine l articolo spariva in silenzio.
        if (articleUrl && imageUrn) {
          return {
            ...said('Un post porta o un articolo o un immagine, non entrambi: scegline uno.'),
            isError: true,
          };
        }
        if (imageUrn && !IMAGE_URN.test(imageUrn)) {
          return { ...said(`Questo non è un urn di immagine LinkedIn: ${imageUrn}`), isError: true };
        }

        const post: CreatePostRequest = {
          author: link.personUrn() as `urn:li:person:${string}`,
          commentary: text,
          visibility: visibility as PostVisibility,
          distribution: {
            feedDistribution: 'MAIN_FEED',
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          lifecycleState: 'PUBLISHED',
        };
        if (articleUrl) {
          post.content = { article: { source: articleUrl, title: articleTitle, description: articleDescription } };
        }
        if (imageUrn) {
          post.content = { media: { id: imageUrn as `urn:li:image:${string}`, altText: imageAltText } };
        }

        const published = await linkedIn.post<{ id: string }>('/v2/posts', post);
        const postUrn = published?.id;
        if (postUrn === undefined) {
          return { ...said('LinkedIn non ha reso l urn del post: controlla il tuo profilo.'), isError: true };
        }

        posts.record({
          postUrn,
          textPreview: text.slice(0, 200),
          visibility,
          hasImage: imageUrn !== undefined,
          hasArticle: articleUrl !== undefined,
          articleUrl: articleUrl ?? null,
        });
        return reported({ pubblicato: true, postUrn });
      }),
  );

  server.tool(
    'linkedin_delete_post',
    'Cancella un tuo post. LinkedIn rifiuta la cancellazione di post di altri.',
    { postUrn: z.string().describe('L urn del post da cancellare') },
    ({ postUrn }) =>
      answering(async () => {
        await linkedIn.delete(`/v2/posts/${encodeURIComponent(postUrn)}`);
        // La traccia locale si cancella solo se è sua: nel fork la DELETE era
        // per chiave primaria su una tabella senza proprietario, quindi un QMate
        // poteva cancellare la riga di un altro conoscendone l urn.
        const forgotten = posts.forget(postUrn);
        return reported({ cancellato: true, tracciaLocaleRimossa: forgotten });
      }),
  );

  server.tool(
    'linkedin_create_comment',
    'Commenta un post di LinkedIn a tuo nome.',
    {
      postUrn: z.string().describe('L urn del post da commentare'),
      text: z.string().min(1).max(1250).describe('Il commento, massimo 1250 caratteri'),
      parentCommentUrn: z.string().optional().describe('L urn del commento a cui rispondere'),
    },
    ({ postUrn, text, parentCommentUrn }) =>
      answering(async () => {
        const comment: CreateCommentRequest = {
          actor: link.personUrn() as `urn:li:person:${string}`,
          message: text,
          parentComment: parentCommentUrn as `urn:li:${string}:${string}` | undefined,
        };
        const posted = await linkedIn.post<{ id: string }>(
          `/v2/socialActions/${encodeURIComponent(postUrn)}/comments`,
          comment,
        );
        return reported({ commentato: true, commentUrn: posted?.id });
      }),
  );

  server.tool(
    'linkedin_react_to_post',
    'Reagisci a un post di LinkedIn a tuo nome.',
    {
      postUrn: z.string().describe('L urn del post'),
      reactionType: z
        .enum(['LIKE', 'PRAISE', 'APPRECIATION', 'EMPATHY', 'INTEREST', 'ENTERTAINMENT'])
        .describe('LIKE, PRAISE (congratulazioni), APPRECIATION (sostegno), EMPATHY (mi piace molto), INTEREST (interessante), ENTERTAINMENT (divertente)'),
    },
    ({ postUrn, reactionType }) =>
      answering(async () => {
        await linkedIn.post(`/v2/socialActions/${encodeURIComponent(postUrn)}/likes`, {
          actor: link.personUrn(),
          reactionType: reactionType as ReactionType,
        });
        return reported({ reazione: reactionType, postUrn });
      }),
  );

  server.tool(
    'linkedin_upload_image',
    'Carica un immagine da allegare a un post, passandone i byte in base64. Rende un urn da usare con linkedin_create_post.',
    {
      // `imagePath` è stato rimosso, non riparato: questo server gira su una
      // macchina che non è quella del QMate, quindi un percorso locale nella
      // sua interfaccia significa leggere il disco DEL SERVIZIO (standard §4).
      imageBase64: z.string().min(1).describe('I byte dell immagine, in base64'),
    },
    ({ imageBase64 }) =>
      answering(async () => {
        const bytes = Buffer.from(imageBase64, 'base64');
        if (bytes.length === 0) {
          return { ...said('Il base64 non contiene byte leggibili.'), isError: true };
        }
        if (bytes.length > LARGEST_IMAGE_BYTES) {
          return {
            ...said(`Immagine troppo grande: ${bytes.length} byte, il massimo è ${LARGEST_IMAGE_BYTES}.`),
            isError: true,
          };
        }
        // Il tipo si riconosce dai byte, non da un nome di file e non da un
        // parametro: senza un filename non c'è un estensione da credere, e un
        // tipo dichiarato dal chiamante sarebbe un tipo di cui fidarsi.
        const contentType = imageTypeOf(bytes);
        if (contentType === null) {
          return {
            ...said('Questi byte non sono un JPEG, un PNG, una GIF o un WebP.'),
            isError: true,
          };
        }

        const upload = await linkedIn.post<InitializeUploadResponse>('/v2/images?action=initializeUpload', {
          initializeUploadRequest: { owner: link.personUrn() },
        });
        await linkedIn.sendImageBytes(upload.value.uploadUrl, bytes, contentType);
        return reported({ caricata: true, imageUrn: upload.value.image, tipo: contentType });
      }),
  );

  server.tool(
    'linkedin_list_my_posts',
    'I post che hai pubblicato attraverso questo servizio.',
    { limit: z.number().int().min(1).max(50).default(10).describe('Quanti mostrarne') },
    ({ limit }) =>
      answering(() => {
        // Solo i suoi: nel fork la tabella non aveva un proprietario e questo
        // tool elencava i post di tutti i QMate.
        const mine = posts.mostRecent(limit);
        if (mine.length === 0) return said('Nessun post pubblicato da qui, per ora.');
        return reported({
          totale: posts.howMany(),
          post: mine.map((post) => ({
            postUrn: post.postUrn,
            quando: new Date(post.publishedAt).toISOString(),
            anteprima: post.textPreview,
            visibilità: post.visibility,
            conImmagine: post.hasImage,
            conArticolo: post.hasArticle,
            articolo: post.articleUrl ?? undefined,
          })),
        });
      }),
  );
}

function imageTypeOf(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  return IMAGE_SIGNATURES.find((signature) => signature.matches(bytes))?.contentType ?? null;
}
