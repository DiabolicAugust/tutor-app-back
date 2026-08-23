import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';

import { DevicePlatform } from '../../../generated/prisma/enums';

export class RegisterDeviceDto {
  /**
   * The push token this device was issued.
   *
   * Not validated beyond a length: token formats belong to the push services and
   * change without asking us, and a client-side pattern that rejects a valid new
   * shape would be worse than a token the service itself refuses.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(255)
  token!: string;

  @IsEnum(DevicePlatform)
  platform!: DevicePlatform;
}
