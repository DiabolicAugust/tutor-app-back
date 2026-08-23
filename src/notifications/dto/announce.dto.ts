import { IsString, MaxLength, MinLength } from 'class-validator';

export class AnnounceDto {
  /**
   * Length-bounded on purpose: this lands in a notification card in the app, and
   * an unbounded field would let one message make the feed unusable.
   */
  @IsString()
  @MinLength(4)
  @MaxLength(500)
  text!: string;
}
