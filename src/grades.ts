/**
 * Lecturers' grade files: one spreadsheet per module, one row per student, one
 * column per assessment (midterm, final, ...). The academic office downloads the
 * folder, and every file goes to the Moodle course its name points at.
 *
 * Nothing here guesses. A file whose course is not certain, a column whose
 * assignment is not certain, a mark that is not clearly a number, a student who
 * is not enrolled in that course: each is reported and left out, never fixed.
 */

import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import ExcelJS from "exceljs";

// ------------------------------------------------------------------ the file name

/** "MBA03" and "MBA003" are the same module: compare letters + number without leading zeros. */
export const moduleKey = (code: string) => {
  const m = code.trim().match(/^([A-Z]+)0*(\d+)$/i);
  return m ? `${m[1].toUpperCase()}${m[2]}` : code.trim().toUpperCase();
};

export type FileName = {
  module: string | null; // e.g. UG4006, MBA03
  term: string | null; // Moodle shortname form: 252601 = AY 25-26, term 1
  assessment: string | null; // midterm, final, ... when the name says so
};

/**
 * What the file name says. The convention seen so far is
 * "marked_AY25-26_EVAL_UG4006_T1_minor": academic year, module code, term.
 * Moodle writes the same year and term as "252601" inside the course shortname.
 */
export function parseFileName(name: string): FileName {
  const stem = basename(name, extname(name)).replace(/^copy of /i, "");
  const year = stem.match(/AY\s*(\d{2})\s*[-_/]?\s*(\d{2})/i);
  const term = stem.match(/(?:^|[_\s-])T(\d)(?=$|[_\s-])/i);
  // A module code is letters followed by digits, standing alone between separators (not "AY25", not "T1").
  const codes = stem
    .split(/[_\s-]+/)
    .filter((t) => /^[A-Z]{2,4}\d{2,4}$/i.test(t) && !/^AY\d+$/i.test(t));
  return {
    module: codes[0] ?? null,
    term: year && term ? `${year[1]}${year[2]}0${term[1]}` : null,
    assessment: assessmentOf(stem),
  };
}

// ---------------------------------------------------------------- assessments

/** The kinds of assessment ESE uses, with the words lecturers write for them. */
const ASSESSMENTS: [string, RegExp][] = [
  ["midterm", /mid[\s-]*term|intermedi/i],
  ["resit", /resit|re-sit|recupero/i],
  // Not \b: in file names "_final" has no word boundary, since "_" is a word character.
  ["final", /(?<![a-z])final[e]?(?![a-z])(?!\s*(mark|grade|voto))|esame\s*finale/i],
  ["oral", /(?<![a-z])oral[e]?(?![a-z])|presentation|presentazione/i],
  ["project", /project|progetto|coursework|assignment|elaborato/i],
];

export function assessmentOf(text: string): string | null {
  for (const [kind, re] of ASSESSMENTS) if (re.test(text)) return kind;
  return null;
}

// ------------------------------------------------------------------- the marks

/**
 * A mark as the lecturer typed it, read the way a person would: "57,5", "57.5",
 * " 57 ", "57%", "57/100" are all 57.5 or 57. Anything else is not a mark.
 */
export function parseMark(raw: unknown): { mark: number | null; problem: string | null } {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return { mark: null, problem: "no mark" };
  }
  if (raw instanceof Date) {
    return { mark: null, problem: "the cell is a date: the mark was probably typed as 12.05 and read as a day" };
  }
  if (typeof raw === "number") {
    // Spreadsheet arithmetic leaves 57.49999999; that is 57.5, not a different mark.
    return range(Math.round(raw * 1e6) / 1e6);
  }
  // Spaces inside the number ("5 7") are not tidied away: 57 or 5.7 is the lecturer's call.
  const text = String(raw).trim().replace(/\s*%$/, "").replace(/\s*\/\s*100$/, "");
  if (!/^\d{1,3}([.,]\d+)?$/.test(text)) {
    return { mark: null, problem: `"${String(raw).trim()}" is not a mark` };
  }
  return range(Number(text.replace(",", ".")));
}

const range = (mark: number) =>
  mark < 0 || mark > 100
    ? { mark: null, problem: `${mark} is outside 0–100` }
    : { mark, problem: null };

// ------------------------------------------------------------------ the sheet

const MATRIC = /matric|matricola|student\s*(id|no|number)|^id\s*number$|^id$/i;
const MARK = /mark|grade|voto|score|punteggio|result|risultato|exam|esame|midterm|final|resit|oral|project/i;
const FEEDBACK = /feedback|comment|note/i;
const NOT_A_MARK = /name|nome|cognome|surname|email|weight|peso|date|data/i;

export type Column = { col: number; header: string; assessment: string | null };

export type GradeRow = {
  row: number;
  matriculation: string | null;
  marks: Record<string, { raw: string; mark: number | null; problem: string | null }>;
  feedback: Record<string, string>;
};

export type GradeFile = {
  file: string;
  sheet: string;
  name: FileName;
  markColumns: Column[];
  feedbackColumns: Column[];
  rows: GradeRow[];
  problems: string[];
};

const cellText = (v: any): unknown => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !(v instanceof Date)) {
    if ("result" in v) return v.result ?? null;
    if ("richText" in v) return v.richText.map((r: any) => r.text).join("");
    if ("text" in v) return v.text;
    if ("error" in v) return null;
  }
  return v;
};

async function load(path: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  if (extname(path).toLowerCase() === ".csv") await wb.csv.readFile(path);
  else await wb.xlsx.readFile(path);
  return wb;
}

export async function readGradeFile(path: string): Promise<GradeFile> {
  const wb = await load(path);
  const name = parseFileName(path);
  const problems: string[] = [];

  // The sheet and header row: the first row, within the first 15 of any visible
  // sheet, that has a matriculation column and at least one mark column.
  for (const ws of wb.worksheets.filter((w) => w.state === "visible")) {
    for (let r = 1; r <= Math.min(15, ws.rowCount); r++) {
      let matricCol = 0;
      const marks: Column[] = [];
      const feedback: Column[] = [];
      ws.getRow(r).eachCell((cell, c) => {
        const header = String(cellText(cell.value) ?? "").replace(/\s+/g, " ").trim();
        if (!header) return;
        if (!matricCol && MATRIC.test(header)) matricCol = c;
        else if (FEEDBACK.test(header)) feedback.push({ col: c, header, assessment: assessmentOf(header) });
        else if (MARK.test(header) && !NOT_A_MARK.test(header)) marks.push({ col: c, header, assessment: assessmentOf(header) });
      });
      if (!matricCol || marks.length === 0) continue;

      // A generic "Voto" column: the file name says which assessment, or it is the only one.
      const generic = marks.filter((m) => !m.assessment);
      if (generic.length === 1 && name.assessment && !marks.some((m) => m.assessment === name.assessment)) {
        generic[0].assessment = name.assessment;
      } else if (generic.length === 1 && marks.length === 1) {
        generic[0].assessment = "only";
      }
      for (const m of marks.filter((m) => !m.assessment)) {
        problems.push(`column "${m.header}": cannot tell which assessment it is (midterm, final, ...)`);
      }
      const seenKinds = new Map<string, string>();
      for (const m of marks.filter((m) => m.assessment)) {
        const other = seenKinds.get(m.assessment!);
        if (other) problems.push(`columns "${other}" and "${m.header}" are both ${m.assessment}`);
        seenKinds.set(m.assessment!, m.header);
      }
      // A single generic feedback column belongs to the single mark column.
      for (const f of feedback) {
        if (!f.assessment && marks.length === 1) f.assessment = marks[0].assessment;
      }

      const rows: GradeRow[] = [];
      const empty = (v: unknown) => v === null || String(v).trim() === "";
      for (let i = r + 1; i <= ws.rowCount; i++) {
        const row = ws.getRow(i);
        const matric = cellText(row.getCell(matricCol).value);
        const rawMarks = marks.map((m) => cellText(row.getCell(m.col).value));
        if (empty(matric) && rawMarks.every(empty)) continue; // blank line
        const entry: GradeRow = {
          row: i,
          matriculation: empty(matric) ? null : String(matric).trim(),
          marks: {},
          feedback: {},
        };
        marks.forEach((m, k) => {
          if (!m.assessment) return;
          const raw = rawMarks[k];
          entry.marks[m.assessment] = {
            raw: raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw ?? "").trim(),
            ...parseMark(raw),
          };
        });
        for (const f of feedback) {
          const text = String(cellText(row.getCell(f.col).value) ?? "").trim();
          if (f.assessment && text) entry.feedback[f.assessment] = text;
        }
        rows.push(entry);
      }

      // Italian 0–30 marks would go into Moodle as a fail out of 100.
      for (const m of marks.filter((m) => m.assessment)) {
        const values = rows
          .map((x) => x.marks[m.assessment!]?.mark)
          .filter((v): v is number => typeof v === "number");
        if (values.length >= 3 && Math.max(...values) <= 30) {
          problems.push(`column "${m.header}": every mark is 30 or less — is this scale out of 30, not 100?`);
        }
      }

      return { file: path, sheet: ws.name, name, markColumns: marks, feedbackColumns: feedback, rows, problems };
    }
  }
  return {
    file: path,
    sheet: "",
    name,
    markColumns: [],
    feedbackColumns: [],
    rows: [],
    problems: ["no header row with a matriculation column and a mark column in the first 15 rows"],
  };
}

/** A single file, or every spreadsheet directly inside a folder (Drive's download unzipped). */
export async function gradeFiles(path: string): Promise<string[]> {
  if (!(await stat(path)).isDirectory()) return [path];
  const names = await readdir(path);
  return names
    .filter((n) => /\.(xlsx|csv)$/i.test(n) && !n.startsWith("~$") && !n.startsWith("."))
    .sort()
    .map((n) => join(path, n));
}
