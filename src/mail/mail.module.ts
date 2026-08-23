import { Global, Module } from '@nestjs/common';

import { MailService } from './mail.service';

/** Global: several features will send mail, none of them owns it. */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
