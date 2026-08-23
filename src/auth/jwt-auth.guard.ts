import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Applied per controller rather than globally: an app with a public sign-in
 * endpoint needs the exception to be explicit, and a global guard plus an
 * `@Public()` escape hatch is the same thing with more indirection.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
