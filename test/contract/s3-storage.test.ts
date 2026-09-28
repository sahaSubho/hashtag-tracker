import { describe, it, expect, beforeAll } from "vitest";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { localstackAwsConfig, uniqueName } from "../helpers/localstack.js";
import { S3Storage } from "../../src/adapters/aws/s3-storage.js";
import { blobStorageContract } from "./blob-storage.contract.js";

let bucket: string;
let client: S3Client;

beforeAll(async () => {
  const config = await localstackAwsConfig();
  // forcePathStyle: LocalStack (and most non-AWS S3-compatible endpoints)
  // don't support virtual-hosted-style addressing (bucket.host/key) the
  // way real S3 does — without this the SDK can't even route a request.
  client = new S3Client({ ...config, forcePathStyle: true });
  bucket = uniqueName("bucket");
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
});

blobStorageContract(() => new S3Storage({ client, bucket }));

describe("S3Storage", () => {
  it("getReadUrl returns a real presigned https URL that actually serves the object", async () => {
    const storage = new S3Storage({ client, bucket });
    async function* data() {
      yield new Uint8Array([9, 9, 9]);
    }
    await storage.put("presign-test.bin", data(), "application/octet-stream");

    const url = await storage.getReadUrl("presign-test.bin");
    expect(url.startsWith("https://") || url.startsWith("http://")).toBe(true);

    const res = await fetch(url);
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes]).toEqual([9, 9, 9]);
  });
});
