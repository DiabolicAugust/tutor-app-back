import {
  AttendanceStatus,
  GradeKind,
  LessonStatus,
} from '../../generated/prisma/enums';

/**
 * The numbers a gradebook is read for.
 *
 * Pure functions over plain rows, deliberately free of Prisma and Nest: the
 * arithmetic of an average is the part most likely to be quietly wrong, and it
 * should be testable without a database or a running app.
 */

/** The minimum of a grade this module needs. Anything wider is the caller's. */
export type GradeLike = {
  kind: GradeKind;
  value: number | null;
  weight: number;
};

/** The minimum of a lesson this module needs. */
export type LessonLike = {
  status: LessonStatus;
};

/**
 * The minimum of an attendance row this module needs.
 *
 * Separate from the lesson, because since groups exist attendance is per student
 * per lesson rather than a property of the lesson: one lesson can be a room
 * where two people were present, one was late and one never came.
 */
export type AttendanceLike = {
  status: AttendanceStatus;
};

export type GradeAverage = {
  /** Weighted mean, rounded to two places. */
  average: number;
  count: number;
};

/**
 * Averages per grading kind, never across them.
 *
 * A 5 on a twelve-point scale and 5% are both "5" and mean opposite things, so
 * one combined number would be actively misleading. Two nullable fields say
 * "this school grades in percentages" without anyone having to configure it.
 */
export type GradeSummary = {
  count: number;
  classic: GradeAverage | null;
  percentage: GradeAverage | null;
  /** Marks that are words. Counted, never averaged. */
  descriptiveCount: number;
};

export type AttendanceSummary = {
  present: number;
  late: number;
  absentExcused: number;
  absentUnexcused: number;
  /** Lessons somebody has actually marked. The denominator for `rate`. */
  marked: number;
  /**
   * Share of marked lessons the student turned up to, 0–1, or null when nothing
   * has been marked yet.
   *
   * Null rather than 0, because "no data" and "never came" are opposite facts
   * and a 0% attendance badge on a new student is a lie.
   */
  rate: number | null;
};

export type ProgressSummary = {
  lessons: {
    total: number;
    completed: number;
    cancelled: number;
    scheduled: number;
  };
  attendance: AttendanceSummary;
  grades: GradeSummary;
};

/** Two decimal places, without the float noise of `toFixed` round-tripping. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Weighted mean of the grades of one kind.
 *
 * Weight rather than a plain mean because a term test and a vocabulary quiz are
 * not the same evidence. A non-positive weight is treated as absent rather than
 * rejected here — validation belongs at the boundary, and arithmetic that throws
 * would take a whole progress screen down over one bad row.
 */
export function averageOf(grades: readonly GradeLike[]): GradeAverage | null {
  let weighted = 0;
  let weight = 0;
  let count = 0;

  for (const grade of grades) {
    if (grade.value === null || grade.weight <= 0) continue;
    weighted += grade.value * grade.weight;
    weight += grade.weight;
    count += 1;
  }

  if (weight === 0) return null;
  return { average: round2(weighted / weight), count };
}

export function summariseGrades(grades: readonly GradeLike[]): GradeSummary {
  return {
    count: grades.length,
    classic: averageOf(grades.filter((g) => g.kind === GradeKind.CLASSIC)),
    percentage: averageOf(
      grades.filter((g) => g.kind === GradeKind.PERCENTAGE),
    ),
    descriptiveCount: grades.filter((g) => g.kind === GradeKind.DESCRIPTIVE)
      .length,
  };
}

export function summariseAttendance(
  attendances: readonly AttendanceLike[],
): AttendanceSummary {
  const count = (status: AttendanceStatus) =>
    attendances.filter((entry) => entry.status === status).length;

  const present = count(AttendanceStatus.PRESENT);
  const late = count(AttendanceStatus.LATE);
  const absentExcused = count(AttendanceStatus.ABSENT_EXCUSED);
  const absentUnexcused = count(AttendanceStatus.ABSENT_UNEXCUSED);
  const marked = present + late + absentExcused + absentUnexcused;

  return {
    present,
    late,
    absentExcused,
    absentUnexcused,
    marked,
    // Late counts as attended: they were taught. The distinction is kept in its
    // own field for whoever cares, and does not distort the headline number.
    rate: marked === 0 ? null : round2((present + late) / marked),
  };
}

export function summariseProgress(
  lessons: readonly LessonLike[],
  grades: readonly GradeLike[],
  attendances: readonly AttendanceLike[],
): ProgressSummary {
  const withStatus = (status: LessonStatus) =>
    lessons.filter((lesson) => lesson.status === status).length;

  return {
    lessons: {
      total: lessons.length,
      completed: withStatus(LessonStatus.COMPLETED),
      cancelled: withStatus(LessonStatus.CANCELLED),
      scheduled: withStatus(LessonStatus.SCHEDULED),
    },
    attendance: summariseAttendance(attendances),
    grades: summariseGrades(grades),
  };
}
