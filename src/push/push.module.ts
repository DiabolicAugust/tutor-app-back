import { Module } from '@nestjs/common';

import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { PushService } from './push.service';

/**
 * Push delivery, and the devices to deliver to.
 *
 * Exported so features that have something to announce can send without knowing
 * how — the same arrangement as `MailModule`.
 */
@Module({
  controllers: [DevicesController],
  providers: [DevicesService, PushService],
  exports: [DevicesService, PushService],
})
export class PushModule {}
