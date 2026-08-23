import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { NormalizedEmail } from '../../common/decorators/normalized-email.decorator';

/**
 * Onboarding: creates a school and its first admin in one call.
 *
 * One call rather than two because a school with no admin is unusable and an
 * admin with no school is meaningless — they are created together or not at all.
 */
export class RegisterSchoolDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  schoolName!: string;

  /**
   * Optional: derived from the name when omitted. Constrained because it ends up
   * in URLs.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase letters, digits and single hyphens',
  })
  @MaxLength(60)
  slug?: string;

  /** IANA zone, e.g. `Europe/Kyiv`. Defaults to UTC. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  adminName!: string;

  @NormalizedEmail()
  adminEmail!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  adminPassword!: string;
}
