import { Controller, Get } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness plus a real database round-trip: a process that is up but cannot
   * reach Postgres is not healthy, and returning 200 for it defeats the point.
   */
  @Get()
  async check() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', at: new Date().toISOString() };
  }
}
