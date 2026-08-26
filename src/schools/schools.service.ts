import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { UserRole } from '../../generated/prisma/enums';
import { AddonsService } from '../addons/addons.service';
import {
  CredentialsService,
  SessionsService,
} from '@diabolicaugust/session-kit/nest';

import type { AuthUserPayload } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateTutorDto } from './dto/create-tutor.dto';
import type { RegisterSchoolDto } from './dto/register-school.dto';
import type { UpdateSchoolDto } from './dto/update-school.dto';

/** Fields safe to return for a colleague — never the password hash. */
const TUTOR_FIELDS = {
  id: true,
  name: true,
  email: true,
  role: true,
  createdAt: true,
} as const;

@Injectable()
export class SchoolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService<User, AuthUserPayload>,
    private readonly credentials: CredentialsService,
    private readonly addons: AddonsService,
  ) {}

  /**
   * Creates a school and its first admin, then signs them in.
   *
   * A transaction, because a school whose admin failed to insert is a tenant
   * nobody can enter — and it would hold the slug forever.
   */
  async register(dto: RegisterSchoolDto) {
    const email = dto.adminEmail.trim().toLowerCase();
    const slug = dto.slug ?? slugify(dto.schoolName);

    const [existingUser, existingSlug] = await Promise.all([
      this.prisma.user.findUnique({ where: { email } }),
      this.prisma.school.findUnique({ where: { slug } }),
    ]);

    if (existingUser)
      throw new ConflictException('That email is already registered');
    if (existingSlug)
      throw new ConflictException('That school address is taken');

    const passwordHash = await this.credentials.hash(dto.adminPassword);

    const admin = await this.prisma.$transaction(async (tx) => {
      const school = await tx.school.create({
        data: {
          name: dto.schoolName.trim(),
          slug,
          timezone: dto.timezone ?? 'UTC',
        },
      });

      return tx.user.create({
        data: {
          email,
          name: dto.adminName.trim(),
          role: UserRole.ADMIN,
          passwordHash,
          schoolId: school.id,
        },
      });
    });

    // Signed in immediately: onboarding that ends on a login form is a worse
    // first minute for no gain.
    return await this.sessions.issue(admin);
  }

  async findCurrent(user: User) {
    const school = await this.prisma.school.findUnique({
      where: { id: user.schoolId },
    });
    if (!school) throw new NotFoundException('School not found');
    return school;
  }

  update(user: User, dto: UpdateSchoolDto) {
    return this.prisma.school.update({
      where: { id: user.schoolId },
      data: { name: dto.name?.trim(), timezone: dto.timezone },
    });
  }

  /**
   * Everyone who can own a calendar in this school.
   *
   * This is what the app's calendar filters list: the caller first, then
   * colleagues, so "my calendar" is always the first row.
   */
  async listTutors(user: User) {
    const [tutors, addons] = await Promise.all([
      this.prisma.user.findMany({
        where: { schoolId: user.schoolId, role: UserRole.TUTOR },
        select: TUTOR_FIELDS,
        orderBy: { name: 'asc' },
      }),
      // Included rather than left to a second request, because the screen that
      // lists members is the screen that edits their capabilities — and it
      // submits the whole set it wants to be true. Without these, every toggle
      // would compute that set from an empty one and quietly remove whatever the
      // member already had.
      this.addons.mapForSchool(user.schoolId),
    ]);

    const withAddons = tutors.map((tutor) => ({
      ...tutor,
      addons: addons[tutor.id] ?? [],
    }));

    return withAddons.sort(
      (a, b) => Number(b.id === user.id) - Number(a.id === user.id),
    );
  }

  /** Admin-only; enforced by `@Roles` on the controller. */
  async createTutor(user: User, dto: CreateTutorDto) {
    const email = dto.email.trim().toLowerCase();

    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('That email is already registered');
    }

    return this.prisma.user.create({
      data: {
        email,
        name: dto.name.trim(),
        role: UserRole.TUTOR,
        passwordHash: await this.credentials.hash(dto.password),
        schoolId: user.schoolId,
      },
      select: TUTOR_FIELDS,
    });
  }
}

/** `"Fox Academy Demo"` → `"fox-academy-demo"`. */
function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  // Non-Latin names can reduce to nothing; a random suffix beats a 500.
  return base || `school-${Math.random().toString(36).slice(2, 8)}`;
}
