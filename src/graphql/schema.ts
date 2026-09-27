/**
 * GraphQL SDL for the dashboard API (spec §10). Kept as a plain string
 * (rather than a separate .graphql asset file) so it needs no special
 * bundler/loader configuration — this is a small schema and inlining it
 * keeps the whole type surface in one diffable place next to the
 * resolvers that implement it.
 */
export const typeDefs = /* GraphQL */ `
  scalar DateTime

  enum MediaType {
    IMAGE
    VIDEO
    CAROUSEL_ALBUM
  }

  enum Bucket {
    HOUR
    DAY
  }

  type Query {
    post(id: ID!): Post
    posts(first: Int!, after: String): PostConnection!
    repostGroup(id: ID!): RepostGroup
  }

  type Post {
    id: ID!
    igMediaId: String!
    caption: String
    mediaType: MediaType!
    permalink: String!
    postedAt: DateTime!
    likeCount: Int
    commentsCount: Int
    assets: [Asset!]!
    engagementHistory(from: DateTime!, to: DateTime!, bucket: Bucket!, first: Int!): [EngagementPoint!]!
    repostGroup: RepostGroup
  }

  type Asset {
    position: Int!
    kind: String!
    status: String!
    contentType: String
    url: String
  }

  type EngagementPoint {
    at: DateTime!
    likeCount: Int
    commentsCount: Int
  }

  type RepostGroup {
    id: ID!
    canonical: Post!
    size: Int!
    totalLikes: Int!
    totalComments: Int!
    members(first: Int!, after: String): PostConnection!
  }

  type PostConnection {
    edges: [PostEdge!]!
    pageInfo: PageInfo!
  }

  type PostEdge {
    cursor: String!
    node: Post!
  }

  type PageInfo {
    endCursor: String
    hasNextPage: Boolean!
  }
`;
