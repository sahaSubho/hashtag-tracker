import { Readable } from "node:stream";
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { BlobStorage } from "../../ports/blob-storage.js";

const PRESIGNED_URL_TTL_SECONDS = 15 * 60; // spec §15.3: media served only through short-lived presigned links

export interface S3StorageOptions {
  client: S3Client | S3ClientConfig;
  bucket: string;
}

/**
 * S3-backed BlobStorage implementation (spec §4.1, §15.3). `Upload` from
 * @aws-sdk/lib-storage handles arbitrary-size async iterables without
 * buffering the whole file in memory the way a plain PutObjectCommand
 * with a fully-materialized body would; it also transparently switches to
 * a multipart upload for large files.
 */
export class S3Storage implements BlobStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: S3StorageOptions) {
    this.client = opts.client instanceof S3Client ? opts.client : new S3Client(opts.client);
    this.bucket = opts.bucket;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async put(key: string, body: AsyncIterable<Uint8Array>, contentType: string): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: Readable.from(body),
        ContentType: contentType,
      },
    });
    await upload.done();
  }

  async getReadUrl(key: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: PRESIGNED_URL_TTL_SECONDS });
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const statusCode = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === "NotFound" || name === "NoSuchKey" || statusCode === 404;
}
