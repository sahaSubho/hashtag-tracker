import { LocalstackContainer, type StartedLocalStackContainer } from "@testcontainers/localstack";

let containerPromise: Promise<StartedLocalStackContainer> | undefined;
let uniqueCounter = 0;

/**
 * Starts (once per test process, lazily) a single LocalStack container
 * shared across every AWS adapter contract test. Unlike the Postgres
 * harness, there's no per-test database to clone here — LocalStack is one
 * multi-service emulator, so isolation between tests comes from each test
 * creating its own uniquely-named queue/bucket/secret/topic instead.
 *
 * Real requests against a real (if emulated) AWS API, exactly like
 * Postgres is never faked in this project's tests — the same principle
 * extended to AWS.
 */
// Pinned to a Community-edition tag, not "latest": LocalStack's "latest"
// tag now requires a paid Pro license (LOCALSTACK_AUTH_TOKEN) and exits
// with "License activation failed" otherwise — confirmed directly against
// this tag. 3.8 is Community edition (free, no token needed) and covers
// every service this project's AWS adapters use (sqs, s3, secretsmanager,
// sns, cloudwatch, events), confirmed via its /_localstack/health endpoint.
const LOCALSTACK_IMAGE = "localstack/localstack:3.8";

export function getLocalstack(): Promise<StartedLocalStackContainer> {
  containerPromise ??= new LocalstackContainer(LOCALSTACK_IMAGE).start();
  return containerPromise;
}

/** A short, unique-enough name suffix for a test's own queue/bucket/secret, so parallel tests never collide. */
export function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}-${Date.now()}-${uniqueCounter}`;
}

export interface LocalstackAwsConfig {
  endpoint: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
}

/** Standard AWS SDK client config pointed at the shared LocalStack container. LocalStack accepts any non-empty credentials. */
export async function localstackAwsConfig(): Promise<LocalstackAwsConfig> {
  const container = await getLocalstack();
  return {
    endpoint: container.getConnectionUri(),
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  };
}
