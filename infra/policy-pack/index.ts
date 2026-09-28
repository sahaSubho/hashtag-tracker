import { PolicyPack, validateResourceOfType } from "@pulumi/policy";
import * as aws from "@pulumi/aws";
import {
  checkPolicyDocumentForWildcards,
  checkBucketPublicAccessBlock,
  checkRdsEncryptedAndTlsForced,
  checkSqsQueueEncrypted,
  checkNoOpenInboundSecurityGroupRules,
  checkNoSecretShapedPlaintextEnvVars,
} from "./rules";

/**
 * CrossGuard policy pack enforcing exactly the spec §15.4 rules, run on
 * every `pulumi preview`/`pulumi up` — a violation blocks the deploy. Each
 * rule here corresponds 1:1 to a fact `infra/index.test.ts`'s setMocks
 * suite already checks for the current stack; the policy pack is what
 * keeps that fact true for every FUTURE change too, not just today's.
 * The actual check logic lives in rules.ts, unit tested in rules.test.ts —
 * PolicyPack itself can't be exercised without a real Pulumi engine
 * driving it over gRPC (confirmed: instantiating it standalone hangs
 * waiting for that connection), which this repo has no AWS credentials
 * to provide.
 */
new PolicyPack("hashtag-tracker-policies", {
  policies: [
    {
      name: "no-wildcard-iam-role-policy",
      description: "IAM role-policy statements must not use '*' for Action or Resource (spec §15.4).",
      enforcementLevel: "mandatory",
      validateResource: validateResourceOfType(aws.iam.RolePolicy, (rolePolicy, _args, reportViolation) =>
        checkPolicyDocumentForWildcards(rolePolicy.policy, reportViolation)
      ),
    },
    {
      name: "no-wildcard-iam-policy",
      description: "Standalone IAM policies (aws.iam.Policy) must not use '*' for Action or Resource (spec §15.4).",
      enforcementLevel: "mandatory",
      validateResource: validateResourceOfType(aws.iam.Policy, (iamPolicy, _args, reportViolation) =>
        checkPolicyDocumentForWildcards(iamPolicy.policy, reportViolation)
      ),
    },
    {
      name: "s3-bucket-public-access-blocked",
      description: "Every S3 bucket must have a BucketPublicAccessBlock with all four flags true (spec §15.4).",
      enforcementLevel: "mandatory",
      validateResource: validateResourceOfType(aws.s3.BucketPublicAccessBlock, (block, _args, reportViolation) =>
        checkBucketPublicAccessBlock(block, reportViolation)
      ),
    },
    {
      name: "rds-encrypted-and-tls-forced",
      description:
        "RDS instances must have storageEncrypted set, and must use a parameter group forcing rds.force_ssl=1 (spec §15.4).",
      enforcementLevel: "mandatory",
      validateResource: validateResourceOfType(aws.rds.Instance, (instance, _args, reportViolation) =>
        checkRdsEncryptedAndTlsForced(instance, reportViolation)
      ),
    },
    {
      name: "sqs-queue-encrypted",
      description: "SQS queues must have server-side encryption enabled (spec §15.4).",
      enforcementLevel: "mandatory",
      validateResource: validateResourceOfType(aws.sqs.Queue, (queue, _args, reportViolation) =>
        checkSqsQueueEncrypted(queue, reportViolation)
      ),
    },
    {
      name: "no-open-inbound-security-group-rules",
      description: "No security group may allow inbound from 0.0.0.0/0 except port 443 (the ALB, spec §15.4).",
      enforcementLevel: "mandatory",
      validateResource: validateResourceOfType(aws.ec2.SecurityGroup, (sg, _args, reportViolation) =>
        checkNoOpenInboundSecurityGroupRules(sg, reportViolation)
      ),
    },
    {
      name: "no-secret-shaped-plaintext-env-vars",
      description:
        "ECS task definition environment variables must not have a name that looks like a secret (token/secret/password/key) — those must go through the `secrets` field instead (spec §15.4).",
      enforcementLevel: "mandatory",
      validateResource: validateResourceOfType(aws.ecs.TaskDefinition, (taskDef, _args, reportViolation) =>
        checkNoSecretShapedPlaintextEnvVars(taskDef, reportViolation)
      ),
    },
  ],
});
