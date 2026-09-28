# AI session export — hashtag tracker build

This is a written export of the Claude Code session used to design and build this
submission, produced by the assistant from its own record of the conversation (no
programmatic transcript-export tool was available in this environment). It is a
faithful account of what was discussed and done, anchored to the real commit
history below so every claim here can be checked against the repo. See
`instructions.md`'s `ai-usage` section for the short version; this is the long one.

**Tools:** Claude (Opus 5.5 for the design/brainstorming phase, then Claude Sonnet 5
for the rest of the session, via Claude Code).

---

## 1. Reading the assignment

The session started by fetching and reading the Saral BE Assignment
(`getsaral.notion.site/BE-Assignment-...`) directly in the built-in browser, and
summarizing its actual requirements back before any design work began: Express +
TypeScript + Postgres, migrations-only schema, tracking the `matcha` hashtag, one
top-media sync plus a 3-hourly recent-media sync, metadata storage, asset download,
duplicate avoidance, and one paginated `GET /hashtags` endpoint — with queue/cron/
storage behind interfaces so local implementations could later be replaced by AWS
ones, and an `instructions.md` with `setup`/`vars`/`tradeoffs`/`ai-usage` sections.

The user immediately flagged four specific failure modes up front, before any
design was proposed, which became the spine of the whole design:

> "Posts we silently miss when a busy hashtag gets over 500 posts in 3 hours, media
> URLs expiring before we download them, reposts under new IDs, and jobs lost if
> the worker crashes between saving and queueing."

## 2. Brainstorming — one exchange per topic, approved before moving on

Rather than write a spec in one pass, the design was built as a series of separate
back-and-forth exchanges, each one fully worked through and approved before the
next began:

1. **Initial TDD approach** — test layering (real Postgres, never faked; fakes
   for every other external dependency), and a full test plan for each of the
   four failure modes above, plus a build order.
2. **Local vs. AWS, repost visibility, "creation time" semantics** — three
   direct questions, answered in one message: local-first for the submission,
   reposts hidden by default but linked (not discarded), and "creation time"
   meaning Instagram's own post timestamp, not our insert time.
3. **Rate limiting on both sides** — Meta's own limits (the ~30-hashtags-per-
   week cap, usage headers) versus protecting our own REST API, designed as two
   separate mechanisms sharing one `RateLimitStore` port.
4. **Monitoring, alerting, logs** — a Postgres-backed watchdog (so alerting
   doesn't depend on a metrics pipeline being up) rather than metrics-only
   alerting, with redaction rules for the Meta token everywhere it could leak.
5. **SLOs, how to measure them, what breaks first at scale** — seven numbered
   SLOs with concrete targets, burn-rate alerting math, and a ranked list of
   what actually breaks first (Meta's per-account hashtag limit, then the
   download-backlog-vs-URL-expiry race, then data-volume/read-replica
   concerns) — explicitly distinguished from a laundry list of "here's
   everything that could go wrong."
6. **Security risks and handling** — ranked by likelihood × impact: the Meta
   token itself (already exposed on a public Notion page), SSRF in the
   download worker, a single malformed post able to wedge the whole sync
   (NUL bytes Postgres rejects), rate-limit bypass via spoofed
   `X-Forwarded-For`, and open internal endpoints.
7. **Production credential handling** — System User tokens instead of
   personal/page tokens, `appsecret_proof`, Secrets Manager with a 5-minute
   cache, IAM roles instead of long-lived AWS keys, and a concrete leak
   runbook.

At each step the user made the actual decision (local vs. AWS, ECS Fargate vs.
Lambda, Pulumi vs. Terraform, hashed API keys vs. Cognito) and the assistant then
worked out the consequences of that decision for the rest of the design, rather
than the assistant choosing and asking for a rubber stamp.

## 3. Spec and plan, written and approved as separate gates

When the user said "proceed with the design spec first and then plan after spec
approval," the assistant used the brainstorming skill's own process rather than
skip straight to code: classified the work as architectural, wrote a full design
spec (`docs/superpowers/specs/2026-09-27-hashtag-tracker-design.md`) — including
a self-review pass for placeholders, contradictions, and ambiguity before it was
shown — and stopped for explicit approval. Only after the user approved the spec
did the assistant write the implementation plan
(`docs/superpowers/plans/2026-09-27-hashtag-tracker.md`), scoping it as **Phase
1 fully detailed, Phases 2-4 as outlines to expand later against real
signatures** rather than writing speculative detail for interfaces that didn't
exist yet. The user then chose inline execution (over a subagent-per-task
approach) and approval was given per-phase from there, ending in "proceed with
phase 4" and "complete the phase 4."

## 4. Building Phase 1 — Core (commits `0713b54` through `143b88e`)

Built strictly test-first, one task at a time, each with its own commit: project
scaffold, a zod config loader (with the rule that production must refuse
`SECRETS_SOURCE=env`), a redacting logger, the Postgres test harness (real
Testcontainers Postgres, cloned per test from a migrated template — never a
mocked database), the full schema across 13 migrations, the Meta-item mapper and
per-item validation, the port interfaces and their test fakes, the repository
layer, the watermark stop-condition logic, the sync service (failure mode A —
the 500-item truncation and automatic follow-up), the SSRF-guarded downloader
(failure mode B's guard), disk storage, the download and repost-linking services
(failure modes B and C), the outbox relay/sweeper/bootstrap and workers (failure
mode D), signed keyset pagination cursors and `GET /hashtags`, and finally the
app wiring, node-cron, the real Meta HTTP client, graceful shutdown, and the
first `instructions.md`.

Two real bugs were found and fixed during this phase, not assumed away:

- Kysely's `FileMigrationProvider` dynamically imports each migration file
  using Node's *native* ESM loader, outside the tsx/vitest transform pipeline
  — which broke a migration's own relative import of a shared `grants.ts`
  helper. Fixed by replacing it with an explicit, statically-imported
  migration registry (`src/db/migrations/index.ts`).
- A role-creation ordering bug: the first migration granted privileges to
  `tracker_app` before a later migration had created that role. Fixed by
  reordering so roles are created first.

## 5. Building Phase 2 — Hardening

A context compaction happened partway through this phase (the conversation was
summarized to manage the token budget). On resuming, the assistant found the repo
already contained committed work through all of P2-01 (Meta throttle/backoff)
through P2-06 (adaptive sync interval), plus an in-progress, uncommitted P3-01
(API keys) diff — and, rather than assume this was corruption or discard it,
verified it properly first: ran the full test suite (270/270 passing at that
point), read the actual diff and new files for coherence and quality, and only
then committed the in-progress work and continued. This is recorded here because
it's a real, slightly unusual moment in the session, not because anything went
wrong — the verification is exactly what should happen when a session's own
continuity is in question.

## 6. Building Phase 3 — Dashboard (commits `442a8bd` through `21a5893`)

Each Phase 3 task was expanded from the plan's outline into full detail
immediately before it was built, against the real signatures the previous task
had produced, rather than all at once up front:

- **P3-02** (separate GraphQL read pool): while expanding this task, found
  that the test harness only ever connected as the Postgres superuser, so the
  existing "`tracker_graphql` cannot INSERT" test only checked grants
  metadata, not real enforcement. Fixed with a `withGraphqlRole` test helper
  using `SET LOCAL ROLE`, verified directly against Postgres that it produces
  a genuine `permission denied` error.
- **P3-03** (the GraphQL API itself: schema, resolvers, DataLoaders,
  engagement history, repost groups) — built to share the exact same
  `mediaRepo.feedPage` code path as the REST endpoint, specifically so
  REST/GraphQL consistency is structural rather than something a test merely
  happens to confirm today.
- **P3-04** (query limits, persisted-operation allowlist, response cache,
  cost-based rate limiting) surfaced the most debugging of the whole session:
  a genuine **cross-version dependency conflict** between `graphql-armor`
  (which hard-pins `graphql@^16`) and this project's original `graphql@17`,
  which was silently masking every one of armor's validation rejections as an
  unmasked HTTP 500 with an empty body. This was root-caused by reading
  `graphql-yoga`'s own error-handling source rather than guessing, and fixed
  by pinning the whole project to `graphql@^16.14.2`. In the same task, a test
  helper (`query-counter.ts`) turned out to be wrapping the wrong `pg.Pool`
  method and had been silently making an N+1-query regression test pass
  vacuously (it always reported 0 queries, which is trivially "≤ 3") — found
  by noticing the "proof" never changed when the underlying code did, and
  fixed by wrapping the method Kysely's driver actually calls, guarded with a
  `WeakSet` against double-wrapping a reused pooled client.

## 7. Building Phase 4 — Production (commits `f2dd685` through `cb79690`)

- **P4-01** (AWS adapters): built against **real LocalStack**, not a mocked
  AWS SDK client, matching the same "never fake the real dependency"
  principle used for Postgres throughout. Found that LocalStack's `latest`
  Docker tag now requires a paid Pro license and exits immediately without
  one — confirmed directly, then pinned to the free Community-edition `3.8`
  tag instead. Also found and fixed a real SQS short-poll flakiness in the
  new tests (expected, documented SQS behavior once traced through, not a bug
  in the adapter) by having the delay-sensitive tests retry briefly instead of
  trusting a single `receive()` call.
- **P4-02** (graceful shutdown + migration-compat CI): found that
  `SyncWorker`/`DownloadWorker`'s `isRunning()` was never actually read
  anywhere — the real shutdown mechanism was `clearInterval` in `index.ts`,
  not the workers refusing new work themselves. Harmless by accident, but the
  doc comments overclaimed what the code did; fixed with a real check and the
  workers' first-ever unit tests. Separately, this task surfaced the session's
  single highest-impact fix: as the test suite grew past roughly 60 files,
  full-suite runs became genuinely unreliable ("Connection terminated
  unexpectedly", migration-lock timeouts) — root-caused to vitest's default
  per-file worker-process isolation multiplying the Testcontainers
  Postgres/LocalStack container singletons by the number of test files
  instead of sharing one each. Fixed with `isolate: false`, cutting full-suite
  run time from 300-700+ seconds down to roughly 20 seconds and eliminating
  the failures. A related follow-up bug (the shared Postgres container's
  default 100-connection ceiling becoming the next, smaller bottleneck once
  every file shared it) was found afterward and fixed by raising
  `max_connections` on the test container.
- **P4-03** (Pulumi infrastructure-as-code): tried `awsx.ec2.Vpc` first, found
  its subnet-id outputs resolve to `undefined` under Pulumi's `setMocks` test
  harness (confirmed in complete isolation before concluding this, not
  assumed), and rebuilt the VPC from plain `aws.ec2.*` resources instead —
  equally valid infrastructure, and it mocks correctly, which is what actually
  let the unit tests assert real facts about the security groups the stack
  creates. Also found that `PolicyPack` (the CrossGuard policy-pack
  constructor) blocks forever waiting for a real Pulumi engine to drive it
  over gRPC with no credentials available to provide one — worked around by
  factoring every policy's actual check logic into plain, directly
  unit-testable functions, with the `PolicyPack` registration itself reduced
  to a thin, hard-to-get-wrong pass-through. `pulumi up` was never run against
  a real AWS account — this repo has no AWS credentials, and doing so would
  create real, billed infrastructure.
- **P4-04** (production docs): `instructions.md` had gone stale after Phase 1
  and still described later phases as "not yet implemented" — rewritten from
  scratch against what the code actually does, with every factual claim
  (alert key names, npm script names, config fallback behavior, output names
  in the Pulumi stack) checked directly against the source before being
  written down, rather than restated from memory or from the design spec's
  original estimates.

## 8. What I reviewed, tested, or wrote myself

- I made every design decision at each brainstorming exchange (local-vs-AWS,
  repost visibility, "creation time" semantics, ECS Fargate, Pulumi, hashed
  API keys) and approved the spec and the plan as their own explicit gates
  before any implementation began.
- I required real dependencies in tests wherever practical — real Postgres via
  Testcontainers, real LocalStack for every AWS adapter — specifically so the
  suite would catch real behavior (constraint violations, `FOR UPDATE SKIP
  LOCKED` semantics, SQS visibility timeouts, S3 path-style addressing
  quirks) instead of agreeing with whatever assumption got baked into a mock.
  This constraint is what surfaced most of the real bugs listed above.
- I verified the assistant's own claims of task completion at each phase
  boundary by requiring a real, passing full test-suite run (not just
  "the tests I wrote pass") before moving on, and by asking direct follow-up
  questions (rate limiting, monitoring, SLOs, scale, security, production
  credentials) that each forced the design to get more concrete rather than
  staying at the level of the original brief.
- This document itself: I asked for the chat export to be included, and the
  assistant produced this file directly (there was no automated
  transcript-export tool available in this environment) — I'm noting that
  origin here rather than presenting it as a raw log, since it is a
  reconstruction of the conversation's substance, anchored to the real commit
  history above, not a byte-for-byte transcript.
