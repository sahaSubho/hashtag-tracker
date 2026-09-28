import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Generous: several scenario tests push hundreds of rows through real
    // Postgres transactions (e.g. the 500-item-cap sync test), and running
    // many Postgres-backed test files in parallel under CPU/connection
    // contention can push a normally-fast test well past a tight timeout.
    testTimeout: 60000,
    hookTimeout: 60000,
    // Cap how many test files run at once so they don't all open
    // Testcontainers/Postgres connections simultaneously and starve each
    // other — this is what caused the intermittent 30s timeout above.
    // Lowered from 4 after observing full-suite runs stall for minutes at
    // a time on a resource-constrained dev machine with 4 concurrent
    // Postgres containers; 2 trades some wall-clock time for reliability.
    maxWorkers: 2,
    // Vitest's default (isolate: true) spawns a fresh worker PROCESS per
    // test file. test/helpers/pg.ts and test/helpers/localstack.ts each
    // hold a lazy, once-started container behind a module-level variable
    // specifically so every test file in a run shares ONE Postgres
    // container (databases are cloned per test) and ONE LocalStack
    // container — but that sharing only actually happens within a single
    // process's module registry. With isolate: true and ~60+ test files,
    // each file's own fresh process re-triggers container startup,
    // producing dozens of concurrent Postgres/LocalStack containers by
    // the time a full run finishes, which is what caused the "Connection
    // terminated unexpectedly" / migration-lock-timeout failures under
    // full-suite load (each container fine alone; the pile-up isn't).
    // isolate: false runs all files in one shared process, so the
    // singletons in both helpers are genuinely singletons — one Postgres
    // container, one LocalStack container, for the whole run — which is
    // also faster (per vitest's own end-of-run hint about per-file
    // worker startup cost). Safe here because neither helper holds
    // mutable state that different files write to (each test creates its
    // own uniquely-named database/queue/bucket/secret).
    isolate: false,
  },
});
