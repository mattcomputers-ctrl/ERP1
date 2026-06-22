import { ArgumentsHost, Catch, type ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import type { Response } from 'express';

// Maps Prisma known-request errors to clean HTTP responses instead of a raw 500.
// Most service paths pre-check and throw their own NestJS HttpExceptions; this is
// the safety net for the races those pre-checks can't fully close — e.g. a unique
// constraint (P2002) lost between a TOCTOU pre-check and the insert. Registered
// globally in configureApp so the real server AND the HTTP test harness share it.
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'A database error occurred.';
    switch (exception.code) {
      case 'P2002': // unique constraint violation
        status = HttpStatus.CONFLICT;
        message = 'A record with that value already exists.';
        break;
      case 'P2025': // operation depends on a record that does not exist
        status = HttpStatus.NOT_FOUND;
        message = 'The requested record was not found.';
        break;
      // Any other known code falls through to 500 (same as Nest's default), logged below.
    }

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`Unmapped Prisma error ${exception.code}: ${exception.message}`);
    }

    res.status(status).json({ statusCode: status, message, error: HttpStatus[status] });
  }
}
