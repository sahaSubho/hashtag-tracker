import { GraphQLError, Kind, type FieldNode, type OperationDefinitionNode } from "graphql";
import type { Plugin } from "graphql-yoga";

const INTROSPECTION_FIELDS = new Set(["__schema", "__type"]);

/**
 * Rejects any operation whose top-level selection set includes __schema or
 * __type, in production only (spec §10: "introspection off in production").
 * yoga has no single built-in flag for this — its own introspection
 * disabling helpers live in a separate plugin package this project doesn't
 * otherwise need, so this is a small, direct AST check instead of pulling
 * in another dependency for one rule.
 */
export function disableIntrospectionPlugin(nodeEnv: string): Plugin {
  if (nodeEnv !== "production") {
    return {};
  }

  return {
    onValidate({ params, setResult }) {
      for (const def of params.documentAST.definitions) {
        if (def.kind !== Kind.OPERATION_DEFINITION) continue;
        const operation = def as OperationDefinitionNode;
        for (const selection of operation.selectionSet.selections) {
          if (selection.kind === Kind.FIELD) {
            const field = selection as FieldNode;
            if (INTROSPECTION_FIELDS.has(field.name.value)) {
              setResult([
                new GraphQLError("introspection is disabled", {
                  extensions: { code: "INTROSPECTION_DISABLED" },
                }),
              ]);
              return;
            }
          }
        }
      }
    },
  };
}
