import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000,
    // policy-pack/ is its own separate npm project (own node_modules,
    // own vitest config) — without this it gets picked up and run
    // against THIS project's node_modules instead of its own, which
    // happens to work today only because the two projects' dependency
    // versions line up, not because it's actually correct isolation.
    exclude: ["**/node_modules/**", "policy-pack/**"],
  },
});
