/**
 * The week's lessons for one campus, read from Moodle.
 *
 * At ESE every lesson already exists in Moodle as an attendance session, and
 * Moodle shows each session as a calendar event with its date, time and
 * duration. Moodle has no notion of a room, so the room is written in the
 * session description ("Aula: DREAM"); a session with "online" in it and no
 * room is an online lesson. Everything else — who teaches, how many students
 * — comes from the course's enrolments.
 */

export type Lesson = {
  day: number; // 0 = Monday
  date: string; // YYYY-MM-DD, Rome time
  start: string; // HH:MM, Rome time
  end: string;
  courseid: number;
  course: string;
  shortname: string;
  lecturers: string[];
  students: number;
  room: string | null;
  note: string;
};

export type Clash = { a: Lesson; b: Lesson; why: string };

const TZ = "Europe/Rome";

/** Rome's offset from UTC on a given day, in minutes (+60 in winter, +120 in summer). */
function romeOffset(at: Date): number {
  const name = new Intl.DateTimeFormat("en", { timeZone: TZ, timeZoneName: "shortOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")!.value; // "GMT+2"
  const m = name.match(/GMT([+-]\d+)(?::(\d+))?/);
  return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] ?? 0) : 0;
}

/** Midnight in Rome of a YYYY-MM-DD, as a Unix timestamp. */
export function romeMidnight(date: string): number {
  const guess = new Date(`${date}T00:00:00Z`);
  return Math.floor((guess.getTime() - romeOffset(guess) * 60_000) / 1000);
}

const romeParts = (unix: number) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
    }).formatToParts(new Date(unix * 1000)).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`,
    weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday),
  };
};

/** The Monday of the week containing a date (default: today, in Rome). */
export function mondayOf(date?: string): string {
  const today = date ?? romeParts(Math.floor(Date.now() / 1000)).date;
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** "Aula: DREAM", "Room - Victory", "aula dream (piano terra)" -> DREAM. */
export function roomFrom(description: string): { room: string | null; online: boolean } {
  const m = description.match(/(?:aula|room)\s*[:\-–]?\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 ]{0,30}?)\s*(?:$|[\n,;.(])/im);
  const online = /\bonline\b|meet\.google|zoom\.us|teams\.microsoft/i.test(description);
  return { room: m ? m[1].trim().toUpperCase() : null, online };
}

const mins = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export function findClashes(lessons: Lesson[]): Clash[] {
  const out: Clash[] = [];
  for (let i = 0; i < lessons.length; i++) {
    for (let j = i + 1; j < lessons.length; j++) {
      const a = lessons[i], b = lessons[j];
      if (a.date !== b.date || !(mins(a.start) < mins(b.end) && mins(b.start) < mins(a.end))) continue;
      if (a.room && a.room === b.room && a.room !== "ONLINE") out.push({ a, b, why: `same room ${a.room}` });
      const shared = a.lecturers.find((l) => b.lecturers.includes(l));
      if (shared) out.push({ a, b, why: `${shared} teaches both` });
    }
  }
  return out;
}

const DAY_NAMES = ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"];

export function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const months = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
  return `${DAY_NAMES[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

/** The week as a WhatsApp message: *bold* days, one line per lesson. */
export function whatsapp(lessons: Lesson[], title: string, subtitle: string, withLecturer = true): string {
  const lines = [`*${title}*`, `_${subtitle}_`, ""];
  const byDate = new Map<string, Lesson[]>();
  for (const l of lessons) byDate.set(l.date, [...(byDate.get(l.date) ?? []), l]);
  for (const [date, list] of [...byDate].sort()) {
    lines.push(`*${dayLabel(date)}*`);
    for (const l of list.sort((x, y) => mins(x.start) - mins(y.start) || x.course.localeCompare(y.course))) {
      const where = l.room === "ONLINE" ? "online" : l.room ? `aula ${l.room}` : "aula da definire";
      const extra = [withLecturer && l.lecturers.join(", "), l.students && `${l.students} stud`].filter(Boolean).join(", ");
      lines.push(`• ${l.start}–${l.end} ${l.course} — ${where}${extra ? ` (${extra})` : ""}`);
    }
    lines.push("");
  }
  if (lines.length === 3) lines.push("Nessuna lezione in questa settimana.");
  return lines.join("\n").trim();
}

export { romeParts, mins };
