import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';

import { AddonsModule } from './addons/addons.module';
import { AuthModule } from './auth/auth.module';
import { ThrottlerByCallerGuard } from './common/guards/throttler-by-caller.guard';
import { GLOBAL_THROTTLERS } from './common/throttling';
import { AppConfigModule } from './config/config.module';
import type { Env } from './config/env';
import { FilesModule } from './files/files.module';
import { GradebookModule } from './gradebook/gradebook.module';
import { GroupsModule } from './groups/groups.module';
import { HealthController } from './health.controller';
import { InvitationsModule } from './invitations/invitations.module';
import { LessonsModule } from './lessons/lessons.module';
import { MailModule } from './mail/mail.module';
import { NotesModule } from './notes/notes.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { PushModule } from './push/push.module';
import { SchoolsModule } from './schools/schools.module';
import { SubjectsModule } from './subjects/subjects.module';
import { StudentsModule } from './students/students.module';
import { SupportModule } from './support/support.module';
import { UsersModule } from './users/users.module';

/**
 * Composition root.
 *
 * Feature modules own their own controllers and services and share nothing but
 * `PrismaService` and config, both global. Cross-feature needs go through the
 * owning module's service — `LessonsModule` imports `StudentsModule` to prove a
 * student belongs to the caller — rather than through a shared repository layer.
 */
@Module({
  imports: [
    AppConfigModule,
    /**
     * Rate limiting, in front of everything.
     *
     * Registered here rather than per controller so a route added later is
     * limited by default and has to opt *out* — the opposite way round from the
     * authentication guard, and deliberately: forgetting a guard on a new route
     * is caught by anybody who tries it without a token, while forgetting a rate
     * limit is invisible until somebody exploits it.
     *
     * The store is in-process. On a single instance that is exactly right; if
     * this is ever run on several, each one keeps its own count and the effective
     * limit multiplies by the instance count, at which point the store belongs in
     * Redis. Written down because the failure is silent.
     */
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        throttlers: [...GLOBAL_THROTTLERS],
        // Off in the test suite, which signs in hundreds of times in half a
        // minute and would otherwise spend the allowance on its own fixtures.
        // The guard's own behaviour is covered by `throttling.e2e-spec.ts`,
        // which turns it back on.
        skipIf: () => config.get('NODE_ENV', { infer: true }) === 'test',
      }),
    }),
    PrismaModule,
    MailModule,
    AddonsModule,
    AuthModule,
    SchoolsModule,
    InvitationsModule,
    UsersModule,
    SubjectsModule,
    StudentsModule,
    GroupsModule,
    LessonsModule,
    NotificationsModule,
    NotesModule,
    GradebookModule,
    FilesModule,
    PushModule,
    SupportModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerByCallerGuard }],
})
export class AppModule {}
