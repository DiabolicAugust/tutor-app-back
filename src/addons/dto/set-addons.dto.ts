import { IsArray, IsEnum } from 'class-validator';

import { AddonKey } from '../../../generated/prisma/enums';

/** The full set the member should end up with — see `AddonsService.setFor`. */
export class SetAddonsDto {
  @IsArray()
  @IsEnum(AddonKey, { each: true })
  addons!: AddonKey[];
}
