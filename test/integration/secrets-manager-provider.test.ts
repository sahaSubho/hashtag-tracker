import { describe, it, expect, beforeAll } from "vitest";
import {
  SecretsManagerClient,
  CreateSecretCommand,
  GetSecretValueCommand,
  UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { localstackAwsConfig, uniqueName } from "../helpers/localstack.js";
import { SecretsManagerProvider } from "../../src/adapters/aws/secrets-manager-provider.js";
import { FakeClock } from "../helpers/fakes.js";

let client: SecretsManagerClient;

beforeAll(async () => {
  const config = await localstackAwsConfig();
  client = new SecretsManagerClient(config);
});

/** Wraps a client so tests can assert exactly how many GetSecretValue calls actually reached the (LocalStack) service. */
function countingClient(inner: SecretsManagerClient): { client: SecretsManagerClient; count(): number } {
  let count = 0;
  const originalSend = inner.send.bind(inner);
  inner.send = ((command: unknown, ...rest: unknown[]) => {
    if (command instanceof GetSecretValueCommand) count++;
    return (originalSend as (...a: unknown[]) => unknown)(command, ...rest);
  }) as typeof inner.send;
  return { client: inner, count: () => count };
}

describe("SecretsManagerProvider against real LocalStack Secrets Manager", () => {
  it("fetches and returns the secret's current value", async () => {
    const name = uniqueName("secret");
    await client.send(new CreateSecretCommand({ Name: name, SecretString: "v1" }));
    const clock = new FakeClock(new Date("2026-09-28T00:00:00Z"));
    const provider = new SecretsManagerProvider({ client, clock });

    expect(await provider.get(name)).toBe("v1");
  });

  it("returns undefined for a secret that doesn't exist, rather than throwing", async () => {
    const clock = new FakeClock(new Date("2026-09-28T00:00:00Z"));
    const provider = new SecretsManagerProvider({ client, clock });
    expect(await provider.get(uniqueName("never-created"))).toBeUndefined();
  });

  it("caches for 5 minutes: a second get() within the TTL makes no new AWS call", async () => {
    const name = uniqueName("secret");
    await client.send(new CreateSecretCommand({ Name: name, SecretString: "v1" }));
    const clock = new FakeClock(new Date("2026-09-28T00:00:00Z"));
    const { client: counted, count } = countingClient(new SecretsManagerClient(await localstackAwsConfig()));
    const provider = new SecretsManagerProvider({ client: counted, clock });

    await provider.get(name);
    expect(count()).toBe(1);
    await provider.get(name);
    expect(count()).toBe(1); // served from cache
  });

  it("re-fetches once the 5-minute cache TTL elapses, picking up a rotated value", async () => {
    const name = uniqueName("secret");
    await client.send(new CreateSecretCommand({ Name: name, SecretString: "v1" }));
    const clock = new FakeClock(new Date("2026-09-28T00:00:00Z"));
    const provider = new SecretsManagerProvider({ client, clock });

    expect(await provider.get(name)).toBe("v1");
    await client.send(new UpdateSecretCommand({ SecretId: name, SecretString: "v2" }));

    clock.advance(4 * 60 * 1000);
    expect(await provider.get(name)).toBe("v1"); // still cached, hasn't hit 5 min yet

    clock.advance(2 * 60 * 1000);
    expect(await provider.get(name)).toBe("v2"); // cache expired, re-fetched
  });

  it("refresh() bypasses the cache immediately, for the 190-error fallback (spec §8)", async () => {
    const name = uniqueName("secret");
    await client.send(new CreateSecretCommand({ Name: name, SecretString: "v1" }));
    const clock = new FakeClock(new Date("2026-09-28T00:00:00Z"));
    const provider = new SecretsManagerProvider({ client, clock });

    expect(await provider.get(name)).toBe("v1");
    await client.send(new UpdateSecretCommand({ SecretId: name, SecretString: "v2" }));
    expect(await provider.refresh(name)).toBe("v2");
  });
});
