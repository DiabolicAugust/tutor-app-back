import { IsString, MinLength } from 'class-validator';
import { NormalizedEmail } from '../../common/decorators/normalized-email.decorator';

export class SignInDto {
  @NormalizedEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
