import type { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env';
import { StorageService } from './storage.service';

/**
 * Files in an S3-compatible bucket.
 *
 * The implementation a platform with an ephemeral filesystem needs. Written
 * against the S3 API rather than one vendor's SDK because the API is what every
 * candidate speaks: AWS S3, Cloudflare R2, Backblaze B2, MinIO. `S3_ENDPOINT` is
 * what selects between them, and R2 is the reason `forcePathStyle` is on —
 * virtual-host addressing would put the bucket in the hostname, which R2's
 * endpoint does not serve.
 *
 * Keys are the same strings the local driver uses, so switching driver does not
 * orphan anything already stored under the other one.
 */
@Injectable()
export class S3StorageService extends StorageService {
  private readonly logger = new Logger(S3StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService<Env, true>) {
    super();

    // Non-null assertions rather than fallbacks: the env schema refuses to boot
    // with `STORAGE_DRIVER=s3` and any of these missing, so a nullable read here
    // would only hide that guarantee.
    this.bucket = config.get('S3_BUCKET', { infer: true })!;

    const endpoint = config.get('S3_ENDPOINT', { infer: true });

    this.client = new S3Client({
      // AWS needs the real region. R2 and most compatible stores ignore it but
      // still require *a* value, which is why the default is `auto`.
      region: config.get('S3_REGION', { infer: true }),
      // Omitted for AWS, where the SDK derives it from the region.
      ...(endpoint ? { endpoint } : {}),
      // Only for a custom endpoint. Path style puts the bucket in the URL path,
      // which is what R2 and MinIO serve — and what AWS no longer supports for
      // buckets created since its virtual-host cutover. Forcing it everywhere
      // would break exactly the case most people are on.
      ...(endpoint ? { forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY_ID', { infer: true }),
        secretAccessKey: config.get('S3_SECRET_ACCESS_KEY', { infer: true }),
      },
    });
  }

  async save(key: string, contents: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: contents,
        // Deliberately no ContentType: the `File` row already records the type
        // the client declared, and it is what the download handler sends. A
        // second copy in object metadata is a second thing that can disagree.
        ContentLength: contents.byteLength,
      }),
    );
  }

  /**
   * Opens the object as a stream.
   *
   * Async, unlike the local driver's synchronous `createReadStream` — which is
   * why the seam declares `Readable | Promise<Readable>`. Streamed rather than
   * buffered so a large file does not have to fit in memory twice on the way out.
   */
  async read(key: string): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    // Typed as a union covering browsers too; in Node it is always a Readable.
    const body = response.Body as Readable | undefined;
    if (!body) throw new Error(`Storage returned no body for ${key}`);

    return body;
  }

  async remove(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (cause) {
      // Same tolerance as the local driver, for the same reason: a row whose
      // object is already gone must still be removable.
      this.logger.warn(
        `Could not delete ${key}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
}
