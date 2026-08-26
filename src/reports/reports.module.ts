import { Module } from '@nestjs/common';

import { DebtorsService } from './debtors.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, DebtorsService],
})
export class ReportsModule {}
