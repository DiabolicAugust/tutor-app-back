import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env';

/**
 * What a shared invitation link actually points at.
 *
 * The app's own `foxacademy://invite/<token>` opens it directly, and that is what
 * the email carries. It is a poor thing to *send*, though: a custom scheme is not
 * a web address, so a messenger has no reason to turn it into something tappable,
 * and on a device without the app it fails with nothing to explain itself. Since
 * the admin now sends the link through whatever they already talk to people
 * through — which for this market is usually Telegram — the link has to survive
 * being pasted into a chat.
 *
 * So the shared link is `https://<api host>/invite/<token>`, and this serves one
 * page at it whose only job is to hand off to the app. Two taps instead of one,
 * and worth it: an https link is tappable everywhere and can say something useful
 * when there is no app to open.
 *
 * **No lookup.** The page never touches the database, so it discloses nothing —
 * not the school's name, not the invited address — and behaves identically for a
 * token that is live, spent or invented. Whether the invitation is still good is
 * the app's question to ask, and it already asks it.
 *
 * The single-tap version is Android App Links and iOS Universal Links, which
 * would open the app straight from the chat. Both need things this repository
 * cannot supply on its own — the release key's SHA-256 and an Apple team id — so
 * this is the version that works today with nothing to arrange.
 */
@Controller()
export class InvitePageController {
  constructor(private readonly config: ConfigService<Env, true>) {}

  @Get('invite/:token')
  @Header('Content-Type', 'text/html; charset=utf-8')
  /**
   * A policy for the one document this process serves.
   *
   * Set here rather than through helmet, which stays off globally because the
   * rest of the process is an API. Everything is denied except the inline style
   * this page carries: no script, no images, no frames, nothing to fetch — which
   * also means the reflected token below has nowhere to go even if the guard on
   * its shape ever slipped.
   */
  @Header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'",
  )
  @Header('Referrer-Policy', 'no-referrer')
  page(@Param('token') token: string): string {
    // The token is reflected into the page, so its shape is checked rather than
    // escaped: `randomBytes(...).toString('base64url')` produces exactly this
    // alphabet, and anything else is not a token this server ever issued. A 404
    // rather than a sanitised page, because there is nothing to offer.
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
      throw new NotFoundException();
    }

    const deepLink = `${this.config.get('APP_SCHEME_URL_BASE', {
      infer: true,
    })}/${token}`;

    return [
      '<!doctype html>',
      '<html lang="en"><head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>Join on Fox Academy</title>',
      '<style>',
      'body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;',
      'align-items:center;justify-content:center;background:#faf7f4;color:#2b2118}',
      'main{max-width:22rem;padding:2rem;text-align:center}',
      'h1{font-size:1.35rem;margin:0 0 .5rem}',
      'p{margin:0 0 1.5rem;line-height:1.5;color:#6b5c4e}',
      'a.open{display:block;padding:.9rem 1rem;border-radius:.75rem;',
      'background:#c2410c;color:#fff;text-decoration:none;font-weight:600}',
      'small{display:block;margin-top:1.25rem;color:#8a7a6b}',
      '@media(prefers-color-scheme:dark){body{background:#1b1614;color:#f2ece7}',
      'p{color:#b8a99b}}',
      '</style>',
      '</head><body><main>',
      '<h1>You have been invited</h1>',
      // Deliberately vague about which school and who by: this page is reachable
      // by anyone holding the link, and the app tells them once it has checked
      // the invitation is real.
      '<p>Open this on the phone with Fox Academy installed to finish signing up.</p>',
      `<a class="open" href="${deepLink}">Open Fox Academy</a>`,
      '<small>Nothing happens? Install Fox Academy first, then tap again.</small>',
      '</main></body></html>',
    ].join('');
  }
}
