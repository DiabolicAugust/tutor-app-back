import type { Readable } from 'node:stream';

/**
 * Where the bytes live.
 *
 * An abstract class rather than an interface, so it works as a Nest injection
 * token: `FilesService` asks for `StorageService` and gets whichever
 * implementation the configuration chose, with no knowledge of which.
 *
 * The seam exists because the answer genuinely differs by deployment. A single
 * server wants a directory. Anything with an ephemeral filesystem — most
 * platform-as-a-service free tiers, Render's included — needs object storage, or
 * uploads vanish on every redeploy while their database rows stay behind. That
 * failure is silent, which is exactly why the choice is configuration rather
 * than a rewrite.
 *
 * The `File` table remains the record of truth. Storage holds bytes and cannot
 * tell you who uploaded one, which school it belongs to, or whether anything
 * still references it.
 */
export abstract class StorageService {
  /**
   * A key that spreads files across prefixes and cannot collide.
   *
   * Sharded by school so one tenant's uploads are removable as a unit, and
   * suffixed with the row id because two people uploading `report.pdf` on the
   * same day must not overwrite each other. The original name is kept in the
   * database, not here — a name in the store is one more thing that can
   * disagree.
   *
   * Concrete on the base class because it is the one part that must **not**
   * differ between implementations: a key written by one has to be readable by
   * the other, or switching driver would orphan everything already stored.
   */
  keyFor(schoolId: string, fileId: string): string {
    return `${schoolId}/${fileId}`;
  }

  abstract save(key: string, contents: Buffer): Promise<void>;

  abstract read(key: string): Readable | Promise<Readable>;

  /**
   * Deletes the bytes, tolerating their absence.
   *
   * A row whose file is already gone should still be removable: refusing would
   * leave a database entry nobody can clear, which is a worse state than a
   * missing file.
   */
  abstract remove(key: string): Promise<void>;
}
