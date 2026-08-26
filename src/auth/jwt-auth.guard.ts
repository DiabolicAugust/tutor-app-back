import { Injectable } from '@nestjs/common';
import { SessionGuard } from '@diabolicaugust/session-kit/nest';

/**
 * Requires a valid session token, and puts the user on the request.
 *
 * The library's guard under this project's name. Applied per controller rather
 * than globally: an application with a public sign-in endpoint needs its
 * exceptions to be visible, and a global guard plus a `@Public()` escape hatch is
 * the same arrangement with the exceptions hidden somewhere else.
 */
@Injectable()
export class JwtAuthGuard extends SessionGuard {}
