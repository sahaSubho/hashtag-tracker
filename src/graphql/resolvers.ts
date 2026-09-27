import type { Kysely } from "kysely";
import type { DB } from "../db/schema.js";
import { mediaRepo } from "../db/repositories/media-repo.js";
import { repostGroupRepo } from "../db/repositories/repost-group-repo.js";
import { engagementRepo, type EngagementBucket } from "../db/repositories/engagement-repo.js";
import { encodeCursor, decodeCursor, type CursorSigningKey } from "../domain/cursor.js";
import type { GraphqlLoaders } from "./loaders.js";

export interface GraphqlContext {
  readDb: Kysely<DB>;
  loaders: GraphqlLoaders;
  cursorKeys: CursorSigningKey[];
}

type MediaRow = Awaited<ReturnType<typeof mediaRepo.findById>>;

function toPostDto(row: NonNullable<MediaRow>) {
  return {
    id: String(row.id),
    igMediaId: row.ig_media_id,
    caption: row.caption,
    mediaType: row.media_type,
    permalink: row.permalink,
    postedAt: row.ig_timestamp,
    likeCount: row.like_count,
    commentsCount: row.comments_count,
    // Carried through so field resolvers below can look up assets/repostGroup
    // by id without re-fetching the row they already have.
    __row: row,
  };
}

function connectionFrom(
  rows: Array<NonNullable<MediaRow>>,
  limit: number,
  cursorKeys: CursorSigningKey[]
) {
  const hasNextPage = rows.length > limit;
  const page = rows.slice(0, limit);
  const edges = page.map((row) => ({
    cursor: encodeCursor({ t: row.ig_timestamp, id: row.id }, cursorKeys),
    node: toPostDto(row),
  }));
  return {
    edges,
    pageInfo: {
      endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
      hasNextPage,
    },
  };
}

function parseAfter(after: string | null | undefined, cursorKeys: CursorSigningKey[]) {
  if (!after) return null;
  const decoded = decodeCursor(after, cursorKeys);
  return { t: decoded.t, id: decoded.id };
}

export const resolvers = {
  Query: {
    async post(_parent: unknown, args: { id: string }, ctx: GraphqlContext) {
      const row = await ctx.loaders.mediaById.load(Number(args.id));
      return row ? toPostDto(row) : null;
    },

    async posts(
      _parent: unknown,
      args: { first: number; after?: string | null },
      ctx: GraphqlContext
    ) {
      const after = parseAfter(args.after, ctx.cursorKeys);
      // hashtagId: null — reuses the SAME feedPage the REST /hashtags
      // route calls, just without REST's per-tag scoping. This is what
      // makes "a post's likeCount via GraphQL matches GET /hashtags" a
      // structural guarantee, not a coincidence between two queries.
      const rows = await mediaRepo.feedPage(ctx.readDb, null, args.first, after);
      return connectionFrom(rows, args.first, ctx.cursorKeys);
    },

    async repostGroup(_parent: unknown, args: { id: string }, ctx: GraphqlContext) {
      const group = await ctx.loaders.repostGroupById.load(Number(args.id));
      if (!group) return null;
      return toRepostGroupDto(group);
    },
  },

  Post: {
    async assets(parent: { __row: NonNullable<MediaRow> }, _args: unknown, ctx: GraphqlContext) {
      const rows = await ctx.loaders.assetsByMediaId.load(parent.__row.id);
      return Promise.all(
        rows.map(async (a) => ({
          position: a.position,
          kind: a.kind,
          status: a.status,
          contentType: a.content_type,
          url:
            a.status === "stored" && a.storage_key
              ? await ctx.loaders.storage.getReadUrl(a.storage_key)
              : null,
        }))
      );
    },

    async repostGroup(parent: { __row: NonNullable<MediaRow> }, _args: unknown, ctx: GraphqlContext) {
      if (!parent.__row.repost_group_id) return null;
      const group = await ctx.loaders.repostGroupById.load(parent.__row.repost_group_id);
      return group ? toRepostGroupDto(group) : null;
    },

    async engagementHistory(
      parent: { __row: NonNullable<MediaRow> },
      args: { from: string; to: string; bucket: EngagementBucket; first: number },
      ctx: GraphqlContext
    ) {
      return engagementRepo.bucketed(
        ctx.readDb,
        parent.__row.id,
        new Date(args.from),
        new Date(args.to),
        args.bucket,
        args.first
      );
    },
  },

  RepostGroup: {
    async canonical(
      parent: { canonicalMediaId: number },
      _args: unknown,
      ctx: GraphqlContext
    ) {
      const row = await ctx.loaders.mediaById.load(parent.canonicalMediaId);
      if (!row) throw new Error(`repost group canonical media ${parent.canonicalMediaId} not found`);
      return toPostDto(row);
    },

    async members(
      parent: { id: number },
      args: { first: number; after?: string | null },
      ctx: GraphqlContext
    ) {
      const after = parseAfter(args.after, ctx.cursorKeys);
      const rows = await repostGroupRepo.members(ctx.readDb, parent.id, args.first, after);
      return connectionFrom(rows, args.first, ctx.cursorKeys);
    },
  },
};

function toRepostGroupDto(group: {
  id: number;
  canonical_media_id: number;
  size: number;
  total_likes: number;
  total_comments: number;
}) {
  return {
    id: String(group.id),
    canonicalMediaId: group.canonical_media_id,
    size: group.size,
    totalLikes: group.total_likes,
    totalComments: group.total_comments,
  };
}
