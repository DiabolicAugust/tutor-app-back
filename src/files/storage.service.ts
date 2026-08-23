import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env';

/**
 * Where the bytes live.
 *
 * A seam, like `MailService`: the local disk is what a single server needs, and
 * S3 or similar is a different implementation of these four methods rather than
 * a change anywhere else. Nothing above this class knows what a storage key
 * refers to.
 *
 * The `File` table remains the record of truth. Storage holds bytes and cannot
 * tell you who uploaded one, which school it belongs to, or whether anything
 * still references it.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly root: string;

  constructor(config: ConfigService<Env, true>) {
    this.root = resolve(config.get('UPLOADS_DIR', { infer: true }));
  }

  /**
   * A key that spreads files across directories and cannot collide.
   *
   * Sharded by school so one tenant's uploads are removable as a unit, and
   * suffixed with the row id because two people uploading `report.pdf` on the
   * same day must not overwrite each other. The original name is kept in the
   * database, not here — a name on disk is one more thing that can disagree.
   */
  keyFor(schoolId: string, fileId: string): string {
    return `${schoolId}/${fileId}`;
  }

  async save(key: string, contents: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }

  read(key: string): ReadStream {
    return createReadStream(this.pathFor(key));
  }

  /**
   * Deletes the bytes, tolerating their absence.
   *
   * A row whose file is already gone should still be removable: refusing would
   * leave a database entry nobody can clear, which is a worse state than a
   * missing file.
   */
  async remove(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (cause) {
      this.logger.warn(
        `Could not delete ${key}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  /**
   * Resolves a key inside the storage root, and refuses anything that escapes
   * it — a key is generated here, but this is the one place where a value that
   * came from outside could turn into a path.
   */
  private pathFor(key: string): string {
    const path = resolve(join(this.root, key));

    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(`Refusing a storage key that escapes the root: ${key}`);
    }

    return path;
  }
}
