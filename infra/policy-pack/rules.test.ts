import { describe, it, expect, vi } from "vitest";
import {
  checkPolicyDocumentForWildcards,
  checkBucketPublicAccessBlock,
  checkRdsEncryptedAndTlsForced,
  checkSqsQueueEncrypted,
  checkNoOpenInboundSecurityGroupRules,
  checkNoSecretShapedPlaintextEnvVars,
} from "./rules.js";

describe("checkPolicyDocumentForWildcards", () => {
  it("reports a wildcard Action", () => {
    const report = vi.fn();
    checkPolicyDocumentForWildcards(
      JSON.stringify({ Statement: [{ Effect: "Allow", Action: "*", Resource: "arn:aws:s3:::x" }] }),
      report
    );
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/Action/));
  });

  it("reports a wildcard Resource", () => {
    const report = vi.fn();
    checkPolicyDocumentForWildcards(
      JSON.stringify({ Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }] }),
      report
    );
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/Resource/));
  });

  it("does not report a properly scoped statement", () => {
    const report = vi.fn();
    checkPolicyDocumentForWildcards(
      JSON.stringify({ Statement: [{ Effect: "Allow", Action: "s3:PutObject", Resource: "arn:aws:s3:::bucket/media/*" }] }),
      report
    );
    expect(report).not.toHaveBeenCalled();
  });

  it("accepts an already-parsed policy document object, not only a JSON string", () => {
    const report = vi.fn();
    checkPolicyDocumentForWildcards({ Statement: [{ Action: "*", Resource: "arn:aws:s3:::x" }] }, report);
    expect(report).toHaveBeenCalled();
  });

  it("handles multiple actions/resources in one statement (array form)", () => {
    const report = vi.fn();
    checkPolicyDocumentForWildcards(
      JSON.stringify({ Statement: [{ Action: ["s3:GetObject", "*"], Resource: ["arn:aws:s3:::x"] }] }),
      report
    );
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for an undefined policy", () => {
    const report = vi.fn();
    checkPolicyDocumentForWildcards(undefined, report);
    expect(report).not.toHaveBeenCalled();
  });
});

describe("checkBucketPublicAccessBlock", () => {
  it("reports when any of the four flags is false", () => {
    const report = vi.fn();
    checkBucketPublicAccessBlock(
      { blockPublicAcls: true, blockPublicPolicy: true, ignorePublicAcls: true, restrictPublicBuckets: false },
      report
    );
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("does not report when all four flags are true", () => {
    const report = vi.fn();
    checkBucketPublicAccessBlock(
      { blockPublicAcls: true, blockPublicPolicy: true, ignorePublicAcls: true, restrictPublicBuckets: true },
      report
    );
    expect(report).not.toHaveBeenCalled();
  });
});

describe("checkRdsEncryptedAndTlsForced", () => {
  it("reports when storageEncrypted is false", () => {
    const report = vi.fn();
    checkRdsEncryptedAndTlsForced({ storageEncrypted: false, parameterGroupName: "pg" }, report);
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/storageEncrypted/));
  });

  it("reports when no parameter group is set", () => {
    const report = vi.fn();
    checkRdsEncryptedAndTlsForced({ storageEncrypted: true, parameterGroupName: undefined }, report);
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/force_ssl/));
  });

  it("does not report when both are satisfied", () => {
    const report = vi.fn();
    checkRdsEncryptedAndTlsForced({ storageEncrypted: true, parameterGroupName: "pg" }, report);
    expect(report).not.toHaveBeenCalled();
  });
});

describe("checkSqsQueueEncrypted", () => {
  it("reports when neither SSE option is set", () => {
    const report = vi.fn();
    checkSqsQueueEncrypted({ sqsManagedSseEnabled: false, kmsMasterKeyId: undefined }, report);
    expect(report).toHaveBeenCalled();
  });

  it("accepts sqsManagedSseEnabled alone", () => {
    const report = vi.fn();
    checkSqsQueueEncrypted({ sqsManagedSseEnabled: true, kmsMasterKeyId: undefined }, report);
    expect(report).not.toHaveBeenCalled();
  });

  it("accepts a KMS key alone", () => {
    const report = vi.fn();
    checkSqsQueueEncrypted({ sqsManagedSseEnabled: false, kmsMasterKeyId: "arn:aws:kms:...:key/abc" }, report);
    expect(report).not.toHaveBeenCalled();
  });
});

describe("checkNoOpenInboundSecurityGroupRules", () => {
  it("reports an 0.0.0.0/0 rule on a port other than 443", () => {
    const report = vi.fn();
    checkNoOpenInboundSecurityGroupRules(
      { name: "rds-sg", ingress: [{ protocol: "tcp", fromPort: 5432, toPort: 5432, cidrBlocks: ["0.0.0.0/0"] }] as never },
      report
    );
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/rds-sg/));
  });

  it("allows an 0.0.0.0/0 rule on exactly port 443 (the ALB)", () => {
    const report = vi.fn();
    checkNoOpenInboundSecurityGroupRules(
      { name: "alb-sg", ingress: [{ protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] }] as never },
      report
    );
    expect(report).not.toHaveBeenCalled();
  });

  it("allows a security-group-scoped rule with no CIDR at all", () => {
    const report = vi.fn();
    checkNoOpenInboundSecurityGroupRules(
      { name: "api-sg", ingress: [{ protocol: "tcp", fromPort: 3000, toPort: 3000, securityGroups: ["sg-alb"] }] as never },
      report
    );
    expect(report).not.toHaveBeenCalled();
  });
});

describe("checkNoSecretShapedPlaintextEnvVars", () => {
  it("reports a plaintext env var whose name looks like a secret", () => {
    const report = vi.fn();
    checkNoSecretShapedPlaintextEnvVars(
      {
        family: "sync-worker",
        containerDefinitions: JSON.stringify([{ environment: [{ name: "META_ACCESS_TOKEN", value: "abc" }] }]),
      },
      report
    );
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/META_ACCESS_TOKEN/));
  });

  it("does not report SECRETS_SOURCE, a known-safe backend-selector flag", () => {
    const report = vi.fn();
    checkNoSecretShapedPlaintextEnvVars(
      { family: "api", containerDefinitions: JSON.stringify([{ environment: [{ name: "SECRETS_SOURCE", value: "aws" }] }]) },
      report
    );
    expect(report).not.toHaveBeenCalled();
  });

  it("does not report an ordinary env var", () => {
    const report = vi.fn();
    checkNoSecretShapedPlaintextEnvVars(
      { family: "api", containerDefinitions: JSON.stringify([{ environment: [{ name: "HASHTAG", value: "matcha" }] }]) },
      report
    );
    expect(report).not.toHaveBeenCalled();
  });

  it("is a no-op for malformed containerDefinitions JSON, rather than throwing", () => {
    const report = vi.fn();
    expect(() =>
      checkNoSecretShapedPlaintextEnvVars({ family: "broken", containerDefinitions: "not json" }, report)
    ).not.toThrow();
    expect(report).not.toHaveBeenCalled();
  });
});
