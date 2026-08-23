import {
  Catch,
  ConflictException,
  NotFoundException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

import { Prisma } from '../../../generated/prisma/client';

/**
 * Turns Prisma's error codes into HTTP responses.
 *
 * Without this, a duplicate email surfaces as a 500 with a stack trace. The
 * mapping lives in one place so no service has to catch database errors just to
 * pick a status code.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter
  extends BaseExceptionFilter
  implements ExceptionFilter
{
  catch(
    exception: Prisma.PrismaClientKnownRequestError,
    host: ArgumentsHost,
  ): void {
    switch (exception.code) {
      // Unique constraint violation.
      case 'P2002':
        return super.catch(
          new ConflictException('That value is already taken'),
          host,
        );
      // Record required by the operation was not found.
      case 'P2025':
        return super.catch(new NotFoundException('Not found'), host);
      default:
        return super.catch(exception, host);
    }
  }
}
