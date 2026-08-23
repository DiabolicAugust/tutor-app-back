import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

/**
 * An email address, normalised before it is validated.
 *
 * Validation and normalisation in that order matters. `@IsEmail()` on its own
 * rejects `" Ann@Example.com "`, which is exactly what a phone keyboard's
 * autocomplete hands over — so the request fails on something the server could
 * simply have fixed. Trimming and lowercasing first means the check runs against
 * the address the person meant.
 *
 * One decorator rather than a `@Transform` copied onto every email field: an
 * address that is normalised on sign-in but not on registration creates an
 * account nobody can sign into, and that asymmetry is invisible in review.
 */
export function NormalizedEmail(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim().toLowerCase() : value,
    ),
    IsEmail(),
  );
}
