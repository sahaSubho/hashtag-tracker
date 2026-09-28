import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";

interface CreatedResource {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}

const createdResources: CreatedResource[] = [];

// Pulumi's mock resource monitor must be installed BEFORE the stack module
// is imported (resources are created as a side effect of the import), so
// this runs at module load time, not inside beforeAll/beforeEach.
pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs): { id: string; state: Record<string, unknown> } {
      createdResources.push({ type: args.type, name: args.name, inputs: args.inputs });

      const state: Record<string, unknown> = { ...args.inputs };
      // Computed-looking outputs real resources would return, so
      // downstream .apply()/pulumi.all() calls in index.ts have something
      // concrete to resolve.
      if (args.type === "aws:s3/bucket:Bucket") {
        state.bucket = `${args.name}-bucket`;
        state.arn = `arn:aws:s3:::${args.name}-bucket`;
      }
      if (args.type === "aws:sqs/queue:Queue") {
        state.arn = `arn:aws:sqs:us-east-1:123456789012:${args.name}`;
        state.url = `https://sqs.us-east-1.amazonaws.com/123456789012/${args.name}`;
      }
      if (args.type === "aws:sns/topic:Topic") state.arn = `arn:aws:sns:us-east-1:123456789012:${args.name}`;
      if (args.type === "aws:secretsmanager/secret:Secret") {
        state.arn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${args.name}`;
      }
      if (args.type === "aws:iam/role:Role") state.arn = `arn:aws:iam::123456789012:role/${args.name}`;
      if (args.type === "aws:lb/loadBalancer:LoadBalancer") {
        state.dnsName = `${args.name}.elb.amazonaws.com`;
        state.arn = `arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/${args.name}`;
      }
      if (args.type === "aws:rds/instance:Instance") state.endpoint = `${args.name}.rds.amazonaws.com:5432`;
      if (args.type === "aws:ec2/securityGroup:SecurityGroup") state.id = `${args.name}-sg-id`;
      return { id: `${args.name}-id`, state };
    },
    call(args: pulumi.runtime.MockCallArgs): Record<string, unknown> {
      return args.inputs as Record<string, unknown>;
    },
  },
  "hashtag-tracker",
  "test",
  false
);

// pulumi.Config reads from an internal async-local store populated by
// setAllConfig, not from process.env directly (confirmed by reading
// @pulumi/pulumi's own runtime/config.js — parseConfig() calls
// getStore().config, not process.env).
pulumi.runtime.setAllConfig({
  "hashtag-tracker:albCertificateArn": "arn:aws:acm:us-east-1:123456789012:certificate/test",
  "hashtag-tracker:containerImage": "123456789012.dkr.ecr.us-east-1.amazonaws.com/hashtag-tracker:test",
});

/** Resolves a pulumi.Output's underlying value in test mode. */
function promiseOf<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => output.apply((v) => resolve(v)));
}

function policiesFor(role: { type: string; name: string }): CreatedResource[] {
  return createdResources.filter(
    (r) => r.type === "aws:iam/rolePolicy:RolePolicy" && String(r.inputs.role).includes(role.name)
  );
}

function statementsOf(resource: CreatedResource): Array<{ Effect: string; Action: string | string[]; Resource: string | string[] }> {
  const raw = resource.inputs.policy as string;
  return JSON.parse(raw).Statement;
}

function actionsMentioning(resources: CreatedResource[], actionSubstring: string): string[] {
  const actions: string[] = [];
  for (const r of resources) {
    for (const stmt of statementsOf(r)) {
      const list = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      actions.push(...list.filter((a) => a.includes(actionSubstring)));
    }
  }
  return actions;
}

describe("Pulumi stack policy assertions (spec §15.4, via setMocks — no real AWS calls)", () => {
  let stackExports: typeof import("./index.js");

  beforeAll(async () => {
    stackExports = await import("./index.js");
    // Let every pulumi.Output(...).apply(...)/pulumi.all(...) chain in
    // index.ts resolve before any test inspects createdResources.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  it("stack exports resolve to real-looking values", async () => {
    expect(await promiseOf(stackExports.albDnsName)).toContain("elb.amazonaws.com");
    expect(await promiseOf(stackExports.jobQueueUrl)).toContain("sqs");
    expect(await promiseOf(stackExports.mediaBucketName)).toBeTruthy();
  });

  it("only the sync-worker task role can read the Meta secrets", () => {
    const syncWorkerRole = createdResources.find(
      (r) => r.type === "aws:iam/role:Role" && r.name.includes("sync-worker-task-role")
    )!;
    const otherRoles = createdResources.filter(
      (r) => r.type === "aws:iam/role:Role" && r.name !== syncWorkerRole.name && !r.name.includes("task-execution-role")
    );

    const syncWorkerReadsMetaSecrets = actionsMentioning(policiesFor(syncWorkerRole), "secretsmanager:GetSecretValue");
    expect(syncWorkerReadsMetaSecrets.length).toBeGreaterThan(0);

    for (const other of otherRoles) {
      const otherActions = actionsMentioning(policiesFor(other), "secretsmanager:GetSecretValue");
      expect(otherActions, `${other.name} should not read secrets directly`).toEqual([]);
    }
  });

  it("the download-worker task role's S3 write is scoped to media/* only", () => {
    const downloadWorkerRole = createdResources.find(
      (r) => r.type === "aws:iam/role:Role" && r.name.includes("download-worker-task-role")
    )!;
    const policies = policiesFor(downloadWorkerRole);
    const s3Statements = policies.flatMap(statementsOf).filter((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.some((a) => a.startsWith("s3:"));
    });

    expect(s3Statements.length).toBeGreaterThan(0);
    for (const stmt of s3Statements) {
      const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
      for (const resource of resources) {
        expect(resource).toMatch(/\/media\/\*$/);
      }
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      expect(actions).toEqual(["s3:PutObject"]);
    }
  });

  it("no other task role can write to the media bucket", () => {
    const downloadWorkerRoleName = createdResources.find(
      (r) => r.type === "aws:iam/role:Role" && r.name.includes("download-worker-task-role")
    )!.name;
    const otherRoles = createdResources.filter(
      (r) => r.type === "aws:iam/role:Role" && r.name !== downloadWorkerRoleName
    );
    for (const role of otherRoles) {
      const putActions = actionsMentioning(policiesFor(role), "s3:PutObject");
      expect(putActions, `${role.name} should not have s3:PutObject`).toEqual([]);
    }
  });

  it("the RDS security group only allows inbound 5432 from this app's own service security groups", () => {
    const rdsSg = createdResources.find(
      (r) => r.type === "aws:ec2/securityGroup:SecurityGroup" && r.name.includes("rds-sg")
    )!;
    const ingress = rdsSg.inputs.ingress as Array<Record<string, unknown>>;
    expect(ingress.length).toBeGreaterThan(0);
    for (const rule of ingress) {
      expect(rule.fromPort).toBe(5432);
      expect(rule.toPort).toBe(5432);
      // No CIDR-based ingress at all — every rule must reference a
      // security group, never an open range.
      expect(rule.cidrBlocks ?? []).toEqual([]);
      expect((rule.securityGroups as string[]).length).toBeGreaterThan(0);
    }
  });

  it("no security group allows inbound from 0.0.0.0/0 except the ALB's own 443 rule", () => {
    const securityGroups = createdResources.filter((r) => r.type === "aws:ec2/securityGroup:SecurityGroup");
    for (const sg of securityGroups) {
      const ingress = (sg.inputs.ingress as Array<Record<string, unknown>>) ?? [];
      for (const rule of ingress) {
        const cidrs = (rule.cidrBlocks as string[]) ?? [];
        if (cidrs.includes("0.0.0.0/0")) {
          expect(sg.name, `only the ALB security group may allow 0.0.0.0/0 inbound`).toContain("alb-sg");
          expect(rule.fromPort).toBe(443);
          expect(rule.toPort).toBe(443);
        }
      }
    }
  });

  it("the Meta secrets, and every other app secret, are created with no value at all", () => {
    const secretResources = createdResources.filter((r) => r.type === "aws:secretsmanager/secret:Secret");
    expect(secretResources.length).toBeGreaterThanOrEqual(4);
    for (const secret of secretResources) {
      expect(secret.inputs).not.toHaveProperty("secretString");
      expect(secret.inputs).not.toHaveProperty("secretBinary");
    }
    // And confirm no separate SecretVersion resource sets one either.
    const versions = createdResources.filter((r) => r.type === "aws:secretsmanager/secretVersion:SecretVersion");
    expect(versions).toEqual([]);
  });

  it("no IAM policy anywhere uses a wildcard action or resource", () => {
    const policies = createdResources.filter((r) => r.type === "aws:iam/rolePolicy:RolePolicy");
    for (const p of policies) {
      for (const stmt of statementsOf(p)) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
        for (const action of actions) expect(action).not.toBe("*");
        for (const resource of resources) expect(resource).not.toBe("*");
      }
    }
  });

  it("the media S3 bucket blocks public access and denies non-TLS requests", () => {
    const pab = createdResources.find((r) => r.type === "aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock")!;
    expect(pab.inputs.blockPublicAcls).toBe(true);
    expect(pab.inputs.blockPublicPolicy).toBe(true);
    expect(pab.inputs.ignorePublicAcls).toBe(true);
    expect(pab.inputs.restrictPublicBuckets).toBe(true);

    const bucketPolicy = createdResources.find((r) => r.type === "aws:s3/bucketPolicy:BucketPolicy")!;
    const policyStatements = JSON.parse(bucketPolicy.inputs.policy as string).Statement;
    const denyInsecure = policyStatements.find((s: { Sid: string }) => s.Sid === "DenyInsecureTransport");
    expect(denyInsecure.Effect).toBe("Deny");
    expect(denyInsecure.Condition.Bool["aws:SecureTransport"]).toBe("false");
  });

  it("RDS is encrypted with TLS forced via the parameter group", () => {
    const dbInstance = createdResources.find((r) => r.type === "aws:rds/instance:Instance")!;
    expect(dbInstance.inputs.storageEncrypted).toBe(true);

    const paramGroup = createdResources.find((r) => r.type === "aws:rds/parameterGroup:ParameterGroup")!;
    const forceSsl = (paramGroup.inputs.parameters as Array<{ name: string; value: string }>).find(
      (p) => p.name === "rds.force_ssl"
    );
    expect(forceSsl?.value).toBe("1");
  });

  it("the SQS queue is server-side encrypted", () => {
    const queue = createdResources.find((r) => r.type === "aws:sqs/queue:Queue")!;
    expect(queue.inputs.sqsManagedSseEnabled).toBe(true);
  });

  it("no ECS task definition environment variable has a name that looks like a secret", () => {
    const suspiciousPattern = /token|secret|password|key/i;
    // SECRETS_SOURCE's own NAME matches /secret/ but its value is always
    // the literal string "env" or "aws" — a config flag naming which
    // backend to use, never a credential. Every other match is genuinely
    // suspicious and should fail this test (spec §15.4 policy).
    const knownSafeNames = new Set(["SECRETS_SOURCE"]);
    const taskDefs = createdResources.filter((r) => r.type === "aws:ecs/taskDefinition:TaskDefinition");
    expect(taskDefs.length).toBeGreaterThan(0);
    for (const taskDef of taskDefs) {
      const containerDefs = JSON.parse(taskDef.inputs.containerDefinitions as string) as Array<{
        environment?: Array<{ name: string }>;
      }>;
      for (const container of containerDefs) {
        for (const envVar of container.environment ?? []) {
          if (knownSafeNames.has(envVar.name)) continue;
          expect(envVar.name, `${taskDef.name} has a plaintext env var that looks like a secret`).not.toMatch(
            suspiciousPattern
          );
        }
      }
    }
  });
});
