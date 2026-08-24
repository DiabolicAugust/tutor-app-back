import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env';
import { StudentsModule } from '../students/students.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { LocalStorageService } from './local-storage.service';
import { S3StorageService } from './s3-storage.service';
import { StorageService } from './storage.service';

/**
 * Chooses where bytes go, once, at startup.
 *
 * A factory rather than two modules or a runtime branch: every caller injects
 * `StorageService` and none of them can tell which implementation answered,
 * which is the whole point of the seam. Deciding here also means a
 * misconfiguration is a failed boot rather than a failed upload an hour later.
 */
@Module({
  imports: [StudentsModule],
  controllers: [FilesController],
  providers: [
    FilesService,
    {
      provide: StorageService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): StorageService =>
        config.get('STORAGE_DRIVER', { infer: true }) === 's3'
          ? new S3StorageService(config)
          : new LocalStorageService(config),
    },
  ],
  exports: [FilesService, StorageService],
})
export class FilesModule {}
