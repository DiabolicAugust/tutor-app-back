import { IsString, MaxLength, MinLength } from 'class-validator';

import { NormalizedEmail } from '../../common/decorators/normalized-email.decorator';

/** An admin adding a colleague to the school. */
export class CreateTutorDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @NormalizedEmail()
  email!: string;

  /**
   * Set by the admin for now. Invite links with a first-login password reset are
   * the better answer and are not built yet.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;
}
