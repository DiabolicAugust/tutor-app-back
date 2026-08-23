import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { User } from '../../../generated/prisma/client';
import type { AddonKey } from '../../../generated/prisma/enums';
import { AddonsService } from '../../addons/addons.service';
import { ADDON_KEY } from '../decorators/requires-addon.decorator';

/** Enforces `@RequiresAddon`. Runs after the JWT guard, which supplies the user. */
@Injectable()
export class AddonGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly addons: AddonsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<AddonKey | undefined>(
      ADDON_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required) return true;

    const { user } = context.switchToHttp().getRequest<{ user?: User }>();
    if (!user || !(await this.addons.has(user, required))) {
      throw new ForbiddenException(
        'This capability is not enabled for your account',
      );
    }

    return true;
  }
}
