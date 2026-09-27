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
  },
});
