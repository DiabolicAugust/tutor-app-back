import { IsString, MaxLength, MinLength } from 'class-validator';

export class WriteNoteDto {
  /**
   * The note itself.
   *
   * A minimum of one character rather than a longer floor: "paid" is a complete
   * note, and a length rule that rejects it would be the app arguing with
   * somebody about their own shorthand.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;
}
