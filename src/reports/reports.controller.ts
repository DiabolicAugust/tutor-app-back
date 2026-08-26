import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DebtorsService } from './debtors.service';
import { DebtorQueryDto, ReportQueryDto } from './dto/report-query.dto';
import { ReportsService } from './reports.service';

/**
 * What the school did over a period.
 *
 * Open to every member rather than admins only, and deliberately: a tutor asking
 * how many hours they taught last month is asking about their own work, and the
 * service scopes them to exactly that. Only an admin sees the school.
 */
@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly owing: DebtorsService,
  ) {}

  @Get('summary')
  summary(@CurrentUser() user: User, @Query() query: ReportQueryDto) {
    return this.reports.summary(user, query);
  }

  /**
   * Who has run out of paid lessons.
   *
   * No window: this is a state rather than a period. A tutor sees their own
   * students and an admin the school, which is the same rule as the summary.
   */
  @Get('debtors')
  debtors(@CurrentUser() user: User, @Query() query: DebtorQueryDto) {
    return this.owing.list(user, query);
  }
}
