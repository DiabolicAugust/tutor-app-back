import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Completing an invitation. The email is not accepted from the client — it comes
 * from the invitation row, or the link would be a way to create an account for
 * any address.
 */
export class AcceptInvitationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;
}
