/**
 * The academic office's cross-course view: what no single lecturer can see
 * from inside their own course.
 *
 * Kept free of Moodle calls so the rules can be read, and tested, on their own.
 */

// ------------------------------------------------------------ late registers
//
// ESE's syllabus: attendance is "entered into the Student Portal within 24 hours
// of each class". A register counts from the end of the lesson.

export type SessionState = "overdue" | "pending" | "taken_late" | "on_time" | "future";

export type SessionLike = { sessdate: number; duration: number; lasttaken: number };

export function registerState(s: SessionLike, now: number, hours = 24): SessionState {
  const end = s.sessdate + (s.duration || 0);
  const deadline = end + hours * 3600;
  if (s.sessdate > now) return "future";
  if (!s.lasttaken) return now > deadline ? "overdue" : "pending";
  return s.lasttaken > deadline ? "taken_late" : "on_time";
}

/** Hours between the deadline and now (overdue) or the moment it was taken (late). */
export function hoursLate(s: SessionLike, now: number, hours = 24): number {
  const deadline = s.sessdate + (s.duration || 0) + hours * 3600;
  return Math.max(0, Math.round(((s.lasttaken || now) - deadline) / 3600));
}

// ----------------------------------------------------------- students at risk

export type Signal =
  | { kind: "absences"; course: string; total: number; unexcused: number; excused: number }
  | { kind: "missing"; course: string; assignments: string[] }
  | { kind: "fail"; course: string; item: string; mark: number };

export type StudentRisk = {
  userid: number;
  name: string;
  matriculation: string;
  email: string;
  signals: Signal[];
  courses_with_signals: string[];
  level: "alto" | "medio" | "basso";
};

/**
 * One row per student across every course. The level is about the pattern, not
 * any single number: trouble in more than one course, or of more than one kind,
 * is what a lecturer cannot see and the office should.
 */
export function aggregateRisk(
  signals: { userid: number; name: string; matriculation: string; email: string; signal: Signal }[],
): StudentRisk[] {
  const by = new Map<number, StudentRisk>();
  for (const s of signals) {
    const row = by.get(s.userid) ?? {
      userid: s.userid, name: s.name, matriculation: s.matriculation, email: s.email,
      signals: [], courses_with_signals: [], level: "basso" as const,
    };
    row.signals.push(s.signal);
    if (!row.courses_with_signals.includes(s.signal.course)) row.courses_with_signals.push(s.signal.course);
    by.set(s.userid, row);
  }
  for (const row of by.values()) {
    const kinds = new Set(row.signals.map((s) => s.kind)).size;
    const courses = row.courses_with_signals.length;
    row.level = courses >= 2 && kinds >= 2 ? "alto" : courses >= 2 || kinds >= 2 ? "medio" : "basso";
  }
  const rank = { alto: 0, medio: 1, basso: 2 };
  return [...by.values()].sort(
    (a, b) => rank[a.level] - rank[b.level] || b.signals.length - a.signals.length || a.name.localeCompare(b.name),
  );
}
