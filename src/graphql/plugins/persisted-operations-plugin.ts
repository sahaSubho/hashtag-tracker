import { GraphQLError } from "graphql";
import type { Plugin } from "graphql-yoga";
import { hashParsedOperation, PERSISTED_OPERATION_HASHES } from "../persisted-operations.js";

/**
 * In production, only executes operations whose printed body matches one
 * registered in PERSISTED_OPERATION_HASHES (spec §10). In any other
 * NODE_ENV, every operation is allowed — so the test suite (and local
 * development) can send ad-hoc queries freely, and only a real production
 * deployment is locked down to the dashboard's own known queries.
 */
export function persistedOperationsPlugin(nodeEnv: string): Plugin {
  if (nodeEnv !== "production") {
    return {};
  }

  return {
    onExecute({ args, setResultAndStopExecution }) {
      const hash = hashParsedOperation(args.document);
      if (!PERSISTED_OPERATION_HASHES.has(hash)) {
        setResultAndStopExecution({
          errors: [
            new GraphQLError("operation is not in the persisted-operations allowlist", {
              extensions: { code: "OPERATION_NOT_ALLOWED" },
            }),
          ],
        });
      }
    },
  };
}
