import { GraphQLError, Kind, visit, type ArgumentNode } from "graphql";
import type { Plugin } from "graphql-yoga";

const MAX_FIRST = 50;

function resolvedFirstValue(
  argNode: ArgumentNode,
  variableValues: Record<string, unknown>
): number | null {
  const valueNode = argNode.value;
  if (valueNode.kind === Kind.INT) {
    return parseInt(valueNode.value, 10);
  }
  if (valueNode.kind === Kind.VARIABLE) {
    const value = variableValues[valueNode.name.value];
    return typeof value === "number" ? value : null;
  }
  return null;
}

/**
 * Rejects (does not silently clamp) any `first` argument over 50, anywhere
 * in the operation — whether passed as an inline literal (`first: 60`) or
 * through a variable (spec §10: "every `first` is capped at 50" — capped
 * as a hard limit the client must respect, not a limit the server quietly
 * substitutes, which would let a client believe it got what it asked for).
 *
 * An earlier version of this plugin checked only `variableValues`, on the
 * assumption that graphql-armor's cost limit would independently catch any
 * inline literal over the cap. That assumption was wrong for small
 * selection sets: `first: 60` with only a couple of cheap nested fields
 * can stay under armor's cost ceiling (which scales with both `first` and
 * the size of the nested selection) while still exceeding this app's own
 * 50-item cap, so this check has to inspect the AST directly rather than
 * only variables.
 */
export function rejectOversizedFirstPlugin(): Plugin {
  return {
    onExecute({ args, setResultAndStopExecution }) {
      const variableValues = (args.variableValues ?? {}) as Record<string, unknown>;
      let offendingValue: number | null = null;

      visit(args.document, {
        Argument(node) {
          if (node.name.value !== "first") return;
          const resolved = resolvedFirstValue(node, variableValues);
          if (resolved !== null && resolved > MAX_FIRST) {
            offendingValue = resolved;
          }
        },
      });

      if (offendingValue !== null) {
        setResultAndStopExecution({
          errors: [
            new GraphQLError(`"first" must be at most ${MAX_FIRST}, got ${offendingValue}`, {
              extensions: { code: "FIRST_TOO_LARGE" },
            }),
          ],
        });
      }
    },
  };
}
