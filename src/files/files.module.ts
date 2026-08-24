import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';

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
const MB = 1024 * 1024;

@Module({
  imports: [
    StudentsModule,
    /**
     * The upload ceiling, enforced where it has to be.
     *
     * `FilesService` also checks the size, and that check is not redundant — it
     * produces the message a person reads. But it runs *after* the request body
     * has been read into memory, so on its own it stops a large file from being
     * stored and does nothing to stop it from being received. A handful of
     * concurrent multi-gigabyte requests exhausted the process before any of them
     * reached a line of application code.
     *
     * Multer applies this while reading, and aborts the stream the moment the
     * count is exceeded. Nest turns that into a 413.
     *
     * `files: 1` and `fields` are part of the same idea: this endpoint accepts
     * one file under one name, and an unbounded number of parts is its own way of
     * spending memory.
     */
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        limits: {
          fileSize: config.get('MAX_UPLOAD_MB', { infer: true }) * MB,
          files: 1,
          fields: 8,
          parts: 16,
        },
      }),
    }),
  ],
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
