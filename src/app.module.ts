import { Module } from '@nestjs/common';

import { AddonsModule } from './addons/addons.module';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { HealthController } from './health.controller';
import { InvitationsModule } from './invitations/invitations.module';
import { LessonsModule } from './lessons/lessons.module';
import { MailModule } from './mail/mail.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { SchoolsModule } from './schools/schools.module';
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
    PrismaModule,
    MailModule,
    AddonsModule,
    AuthModule,
    SchoolsModule,
    InvitationsModule,
    UsersModule,
    StudentsModule,
    LessonsModule,
    NotificationsModule,
    SupportModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
