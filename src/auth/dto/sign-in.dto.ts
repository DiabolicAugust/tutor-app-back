import { IsString, MaxLength, MinLength } from 'class-validator';
import { NormalizedEmail } from '../../common/decorators/normalized-email.decorator';

export class SignInDto {
  @NormalizedEmail()
  email!: string;

  /**
   * Bounded at both ends. The minimum matches what registration requires, so a
   * password that could not have been set is rejected before it costs a bcrypt
   * comparison. The maximum is there because nothing else limits it: bcrypt
   * ignores everything past 72 bytes, so a megabyte-long field is pure work.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;
}
