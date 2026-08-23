import { Global, Module } from '@nestjs/common';

import { AddonsService } from './addons.service';

/**
 * Global because capability checks are cross-cutting: the guard that enforces
 * them can be applied by any controller.
 */
@Global()
@Module({
  providers: [AddonsService],
  exports: [AddonsService],
})
export class AddonsModule {}
