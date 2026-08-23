import {
  AttendanceStatus,
  GradeKind,
  LessonStatus,
} from '../../generated/prisma/enums';
import {
  averageOf,
  summariseAttendance,
  summariseGrades,
  summariseProgress,
  type AttendanceLike,
  type GradeLike,
  type LessonLike,
} from './progress';

const classic = (value: number, weight = 1): GradeLike => ({
  kind: GradeKind.CLASSIC,
  value,
  weight,
});

const percentage = (value: number, weight = 1): GradeLike => ({
  kind: GradeKind.PERCENTAGE,
  value,
  weight,
});

const descriptive = (): GradeLike => ({
  kind: GradeKind.DESCRIPTIVE,
  value: null,
  weight: 1,
});

const lesson = (status: LessonStatus): LessonLike => ({ status });

/** One student's line in a register. Independent of any lesson, since groups. */
const marked = (status: AttendanceStatus): AttendanceLike => ({ status });

describe('averageOf', () => {
  it('is null with nothing to average', () => {
    expect(averageOf([])).toBeNull();
  });

  it('weights each mark by its weight', () => {
    // 10 counted three times against a single 6: (30 + 6) / 4 = 9.
    expect(averageOf([classic(10, 3), classic(6, 1)])).toEqual({
      average: 9,
      count: 2,
    });
  });

  it('rounds to two places rather than emitting float noise', () => {
    // 1/3 of the way between marks: 10/3 = 3.333…
    expect(averageOf([classic(4), classic(3), classic(3)])?.average).toBe(3.33);
  });

  it('skips marks with no value, and is null when none has one', () => {
    expect(averageOf([descriptive(), descriptive()])).toBeNull();
  });

  it('ignores a non-positive weight instead of dividing by zero', () => {
    // A weight of 0 would otherwise make the denominator 0 on its own.
    expect(averageOf([classic(8, 0)])).toBeNull();
    expect(averageOf([classic(8, 0), classic(4, 1)])).toEqual({
      average: 4,
      count: 1,
    });
  });
});

describe('summariseGrades', () => {
  it('averages each kind separately and never across them', () => {
    // 5-on-a-scale and 5% must not meet: one combined mean would be nonsense.
    const summary = summariseGrades([
      classic(5),
      classic(11),
      percentage(90),
      descriptive(),
    ]);

    expect(summary).toEqual({
      count: 4,
      classic: { average: 8, count: 2 },
      percentage: { average: 90, count: 1 },
      descriptiveCount: 1,
    });
  });

  it('leaves a kind null when the school does not use it', () => {
    const summary = summariseGrades([percentage(70), percentage(80)]);

    expect(summary.classic).toBeNull();
    expect(summary.percentage).toEqual({ average: 75, count: 2 });
  });

  it('counts descriptive marks without averaging them', () => {
    const summary = summariseGrades([descriptive(), descriptive()]);

    expect(summary).toEqual({
      count: 2,
      classic: null,
      percentage: null,
      descriptiveCount: 2,
    });
  });
});

describe('summariseAttendance', () => {
  it('is null-rate until something is marked, not zero', () => {
    // A brand-new student has not missed anything; a 0% badge would be a lie.
    const summary = summariseAttendance([]);

    expect(summary.marked).toBe(0);
    expect(summary.rate).toBeNull();
  });

  it('counts late as attended, and keeps it visible separately', () => {
    const summary = summariseAttendance([
      marked(AttendanceStatus.PRESENT),
      marked(AttendanceStatus.LATE),
    ]);

    expect(summary.rate).toBe(1);
    expect(summary).toMatchObject({ present: 1, late: 1, marked: 2 });
  });

  it('counts both kinds of absence against the rate', () => {
    const summary = summariseAttendance([
      marked(AttendanceStatus.PRESENT),
      marked(AttendanceStatus.ABSENT_EXCUSED),
      marked(AttendanceStatus.ABSENT_UNEXCUSED),
      marked(AttendanceStatus.PRESENT),
    ]);

    expect(summary).toEqual({
      present: 2,
      late: 0,
      absentExcused: 1,
      absentUnexcused: 1,
      marked: 4,
      rate: 0.5,
    });
  });

  it('only counts what it was given, so unmarked lessons cannot dilute it', () => {
    // The register holds rows for marked students only; an unmarked lesson
    // contributes nothing rather than counting as an absence.
    const summary = summariseAttendance([
      marked(AttendanceStatus.PRESENT),
      marked(AttendanceStatus.ABSENT_UNEXCUSED),
    ]);

    expect(summary.marked).toBe(2);
    expect(summary.rate).toBe(0.5);
  });
});

describe('summariseProgress', () => {
  it('counts lessons by status alongside the rest', () => {
    const summary = summariseProgress(
      [
        lesson(LessonStatus.COMPLETED),
        lesson(LessonStatus.COMPLETED),
        lesson(LessonStatus.CANCELLED),
        lesson(LessonStatus.SCHEDULED),
      ],
      [classic(9), classic(11)],
      [
        marked(AttendanceStatus.PRESENT),
        marked(AttendanceStatus.PRESENT),
        marked(AttendanceStatus.ABSENT_EXCUSED),
      ],
    );

    expect(summary.lessons).toEqual({
      total: 4,
      completed: 2,
      cancelled: 1,
      scheduled: 1,
    });
    expect(summary.grades.classic).toEqual({ average: 10, count: 2 });
    expect(summary.attendance.rate).toBe(0.67);
  });

  it('holds up with nothing recorded at all', () => {
    const summary = summariseProgress([], [], []);

    expect(summary.lessons.total).toBe(0);
    expect(summary.attendance.rate).toBeNull();
    expect(summary.grades).toEqual({
      count: 0,
      classic: null,
      percentage: null,
      descriptiveCount: 0,
    });
  });
});
