import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateSupportRequestDto {
  /**
   * Bounded at both ends: a two-character message is not a request anyone can
   * act on, and an unbounded one is a way to fill the table.
   */
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  message!: string;
}
