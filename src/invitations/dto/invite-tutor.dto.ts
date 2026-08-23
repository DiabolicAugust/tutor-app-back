import { NormalizedEmail } from '../../common/decorators/normalized-email.decorator';

/** All an admin needs to type: the rest of the account is filled in by whoever accepts. */
export class InviteTutorDto {
  @NormalizedEmail()
  email!: string;
}
