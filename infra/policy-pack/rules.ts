import type { ReportViolation } from "@pulumi/policy";
import type { UnwrappedObject } from "@pulumi/pulumi";
import type * as aws from "@pulumi/aws";

/**
 * The actual validation logic for each policy rule, factored out of
 * index.ts's `validateResourceOfType(...)` wrapping so it can be unit
 * tested directly (calling the raw functions with a synthetic "unwrapped
 * resource" object) without needing a real Pulumi engine driving the
 * policy pack over gRPC — which is how `pulumi preview --policy-pack`
 * actually exercises this code, and which this repo has no AWS
 * credentials to run. index.ts wires each of these into a PolicyPack
 * policy; rules.test.ts proves the logic itself.
 */

interface PolicyDocumentLike {
  Statement?: Array<{ Action?: string | string[]; Resource?: string | string[] }>;
}

export function checkPolicyDocumentForWildcards(
  policy: string | PolicyDocumentLike | undefined,
  reportViolation: ReportViolation
): void {
  if (!policy) return;
  let doc: PolicyDocumentLike;
  if (typeof policy === "string") {
    try {
      doc = JSON.parse(policy);
    } catch {
      return;
    }
  } else {
    doc = policy;
  }
  for (const statement of doc.Statement ?? []) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    if (actions.includes("*")) reportViolation("IAM policy statement uses '*' as an Action.");
    if (resources.includes("*")) reportViolation("IAM policy statement uses '*' as a Resource.");
  }
}

export function checkBucketPublicAccessBlock(
  block: UnwrappedObject<Pick<aws.s3.BucketPublicAccessBlockArgs, "blockPublicAcls" | "blockPublicPolicy" | "ignorePublicAcls" | "restrictPublicBuckets">>,
  reportViolation: ReportViolation
): void {
  if (!block.blockPublicAcls || !block.blockPublicPolicy || !block.ignorePublicAcls || !block.restrictPublicBuckets) {
    reportViolation(
      "BucketPublicAccessBlock must set blockPublicAcls, blockPublicPolicy, ignorePublicAcls, and restrictPublicBuckets all to true."
    );
  }
}

export function checkRdsEncryptedAndTlsForced(
  instance: UnwrappedObject<Pick<aws.rds.InstanceArgs, "storageEncrypted" | "parameterGroupName">>,
  reportViolation: ReportViolation
): void {
  if (!instance.storageEncrypted) {
    reportViolation("RDS instance must have storageEncrypted: true.");
  }
  if (!instance.parameterGroupName) {
    reportViolation("RDS instance must reference a parameter group that sets rds.force_ssl=1 (none was set).");
  }
}

export function checkSqsQueueEncrypted(
  queue: UnwrappedObject<Pick<aws.sqs.QueueArgs, "sqsManagedSseEnabled" | "kmsMasterKeyId">>,
  reportViolation: ReportViolation
): void {
  if (!queue.sqsManagedSseEnabled && !queue.kmsMasterKeyId) {
    reportViolation("SQS queue must set sqsManagedSseEnabled: true (or a kmsMasterKeyId).");
  }
}

export function checkNoOpenInboundSecurityGroupRules(
  sg: UnwrappedObject<Pick<aws.ec2.SecurityGroupArgs, "name" | "ingress">>,
  reportViolation: ReportViolation
): void {
  for (const rule of sg.ingress ?? []) {
    const cidrs = rule.cidrBlocks ?? [];
    if (cidrs.includes("0.0.0.0/0") && (rule.fromPort !== 443 || rule.toPort !== 443)) {
      reportViolation(
        `Security group "${sg.name ?? "(unnamed)"}" allows inbound 0.0.0.0/0 on a port other than 443 (fromPort=${rule.fromPort}, toPort=${rule.toPort}).`
      );
    }
  }
}

const SUSPICIOUS_ENV_NAME_PATTERN = /token|secret|password|key/i;
const KNOWN_SAFE_ENV_NAMES = new Set(["SECRETS_SOURCE"]); // a backend-selector flag, never a credential value

export function checkNoSecretShapedPlaintextEnvVars(
  taskDef: UnwrappedObject<Pick<aws.ecs.TaskDefinitionArgs, "family" | "containerDefinitions">>,
  reportViolation: ReportViolation
): void {
  let containerDefs: Array<{ environment?: Array<{ name: string }> }>;
  try {
    containerDefs = JSON.parse(taskDef.containerDefinitions ?? "[]");
  } catch {
    return;
  }
  for (const container of containerDefs) {
    for (const envVar of container.environment ?? []) {
      if (KNOWN_SAFE_ENV_NAMES.has(envVar.name)) continue;
      if (SUSPICIOUS_ENV_NAME_PATTERN.test(envVar.name)) {
        reportViolation(
          `Task definition "${taskDef.family}" has a plaintext environment variable "${envVar.name}" that looks like a secret — use the "secrets" field (Secrets Manager) instead.`
        );
      }
    }
  }
}
