import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

import { validateEnv } from './env';

/**
 * Global configuration. Imported once; every other module injects
 * `ConfigService<Env, true>` and gets typed, already-validated values.
 */
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: ['.env.local', '.env'],
    }),
  ],
})
export class AppConfigModule {}
