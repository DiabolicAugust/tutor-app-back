import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import type { User } from '../../generated/prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FilesService } from './files.service';
import { ThrottleUpload } from '../common/throttling';

/**
 * Documents kept against a student.
 *
 * Upload is multipart under the field name `file`. Held in memory rather than
 * streamed to a temporary path: the size limit is small enough that a buffer is
 * cheap, and it means no temporary file to clean up when a request is rejected.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /**
   * The caller's own library — material they keep for themselves rather than
   * against a student. LangLion calls this a media library; the idea is the same.
   */
  @Get('files')
  listLibrary(@CurrentUser() user: User) {
    return this.files.listOwnLibrary(user);
  }

  @Post('files')
  @ThrottleUpload()
  @UseInterceptors(FileInterceptor('file'))
  uploadToLibrary(
    @CurrentUser() user: User,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('No file was sent');

    return this.files.uploadToLibrary(user, {
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      buffer: file.buffer,
    });
  }

  @Get('students/:studentId/files')
  list(@CurrentUser() user: User, @Param('studentId') studentId: string) {
    return this.files.listForStudent(user, studentId);
  }

  @Post('students/:studentId/files')
  @ThrottleUpload()
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentUser() user: User,
    @Param('studentId') studentId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('No file was sent');

    return this.files.uploadForStudent(user, studentId, {
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      buffer: file.buffer,
    });
  }

  /**
   * Material for one lesson: the worksheet handed out, the slides, a recording.
   *
   * Nested under the lesson, like notes and grades are, because that is what
   * decides who may see it — the lesson's own reachability rule and no second one.
   */
  @Get('lessons/:lessonId/files')
  listForLesson(@CurrentUser() user: User, @Param('lessonId') lessonId: string) {
    return this.files.listForLesson(user, lessonId);
  }

  @Post('lessons/:lessonId/files')
  @ThrottleUpload()
  @UseInterceptors(FileInterceptor('file'))
  uploadForLesson(
    @CurrentUser() user: User,
    @Param('lessonId') lessonId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('No file was sent');

    return this.files.uploadForLesson(user, lessonId, {
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      buffer: file.buffer,
    });
  }

  /**
   * Streams the file back.
   *
   * `attachment` rather than `inline`: these are uploads from people outside the
   * team, and rendering one in the browser's own origin is how a stored file
   * becomes a script that runs.
   */
  @Get('files/:id')
  async download(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { file, stream } = await this.files.open(user, id);

    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', String(file.sizeBytes));
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.originalName)}"`,
    );

    // Wrapped rather than returned bare: Nest serialises a handler's return
    // value, and a stream handed over as-is comes out the other end as `{}`.
    return new StreamableFile(stream);
  }

  @Delete('files/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: User, @Param('id') id: string) {
    return this.files.remove(user, id);
  }
}
