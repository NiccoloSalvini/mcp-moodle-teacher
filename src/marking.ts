/**
 * Reader for ESE marking forms: one workbook per module, one tab per student,
 * each tab the same evaluation form filled in by the lecturer.
 *
 * The forms differ between modules (written only, written + oral, different
 * criteria), so nothing here relies on fixed cell addresses. Every value is
 * found next to its printed label, the way a person reading the form finds it.
 *
 * Marks are read, never computed: the mark that goes to Moodle is the value the
 * spreadsheet itself calculated and saved in the "TOTAL ASSESSMENT MARK" cell.
 */

import ExcelJS from "exceljs";

export type MarkingForm = {
  sheet: string;
  matriculation: string | null;
  module: string | null;
  title: string | null;
  lecturer: string | null;
  final_mark: number | null;
  feedback: {
    special_abilities: string;
    action_points: string;
    areas_for_development: string;
  };
  problems: string[];
};

/** The text or number a cell shows, whatever exceljs wraps it in. */
function shown(cell: ExcelJS.Cell): string | number | null {
  const v: any = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("result" in v) return v.result ?? null; // formula: the saved result, not the formula
    if ("richText" in v) return v.richText.map((r: any) => r.text).join("");
    if ("text" in v) return v.text;
    if ("error" in v) return null;
  }
  return String(v);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The first cell whose text starts with the label. */
function findLabel(ws: ExcelJS.Worksheet, label: string): ExcelJS.Cell | null {
  const wanted = norm(label);
  let found: ExcelJS.Cell | null = null;
  ws.eachRow({ includeEmpty: false }, (row) => {
    if (found) return;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (found || cell.isMerged && cell.master !== cell) return;
      const v = shown(cell);
      if (typeof v === "string" && norm(v).startsWith(wanted)) found = cell;
    });
  });
  return found;
}

/** The first filled cell to the right of the label, skipping the label's own merge. */
function rightOf(ws: ExcelJS.Worksheet, label: ExcelJS.Cell | null): string | number | null {
  if (!label) return null;
  const row = ws.getRow(Number(label.row));
  for (let col = Number(label.col) + 1; col <= Math.min(ws.columnCount, Number(label.col) + 6); col++) {
    const cell = row.getCell(col);
    if (cell.isMerged && cell.master.address === label.master.address) continue;
    if (cell.isMerged && cell.master !== cell) continue;
    const v = shown(cell);
    if (v === null || String(v).trim() === "") continue;
    // Another printed label ("DATE:") means the field itself was left empty.
    if (typeof v === "string" && v.trim().endsWith(":")) return null;
    return v;
  }
  return null;
}

/** The cell directly below the label (TOTAL ASSESSMENT MARK sits above its value). */
function below(ws: ExcelJS.Worksheet, label: ExcelJS.Cell | null): string | number | null {
  if (!label) return null;
  const bottom = label.isMerged ? label.master : label;
  // A merged label spans rows; the value is under its last row.
  let r = Number(bottom.row) + 1;
  while (ws.getCell(r, Number(label.col)).isMerged &&
         ws.getCell(r, Number(label.col)).master.address === label.master.address) r++;
  return shown(ws.getCell(r, Number(label.col)));
}

/**
 * Text the lecturer wrote for one feedback heading. Usually it is in the merged
 * cell beside the heading; some lecturers type it inside the heading cell after
 * the colon, so that is read too.
 */
function feedbackAt(ws: ExcelJS.Worksheet, label: string): string {
  const cell = findLabel(ws, label);
  if (!cell) return "";
  const beside = rightOf(ws, cell);
  const inside = String(shown(cell) ?? "");
  const afterColon = inside.includes(":") ? inside.slice(inside.indexOf(":") + 1).trim() : "";
  return [afterColon, beside === null ? "" : String(beside).trim()].filter(Boolean).join("\n\n");
}

const asText = (v: string | number | null) => (v === null ? null : String(v).trim() || null);

/**
 * Two entries for the same student: neither may go to Moodle, since which mark
 * the lecturer meant is a question for the lecturer, not for a program.
 */
function flagDuplicates(rows: MarkingForm[]): MarkingForm[] {
  const groups = new Map<string, MarkingForm[]>();
  for (const f of rows) {
    if (f.matriculation) groups.set(f.matriculation, [...(groups.get(f.matriculation) ?? []), f]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const f of group) {
      const others = group.filter((g) => g !== f).map((g) => g.sheet).join(", ");
      f.problems.push(`same matriculation also in ${others}`);
    }
  }
  return rows;
}

export async function readMarkingForms(path: string): Promise<MarkingForm[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const forms: MarkingForm[] = [];

  for (const ws of wb.worksheets) {
    if (ws.state !== "visible") continue;
    const problems: string[] = [];

    const matric = asText(rightOf(ws, findLabel(ws, "Student Matriculation No")));
    const totalLabel = findLabel(ws, "TOTAL ASSESSMENT MARK");
    const rawMark = below(ws, totalLabel);

    let final: number | null = null;
    if (!totalLabel) problems.push('no "TOTAL ASSESSMENT MARK" on this form');
    else if (typeof rawMark === "number") final = rawMark;
    else if (typeof rawMark === "string" && rawMark.trim() && !Number.isNaN(Number(rawMark))) final = Number(rawMark);
    else problems.push("final mark cell is empty or has no saved value");

    const feedback = {
      special_abilities: feedbackAt(ws, "Special Abilities"),
      action_points: feedbackAt(ws, "Action Points"),
      areas_for_development: feedbackAt(ws, "Areas for Development"),
    };

    if (!matric) problems.push("matriculation number missing");
    if (final === 0) problems.push("final mark is 0: form probably not filled in");
    if (final !== null && (final < 0 || final > 100)) problems.push(`final mark ${final} is outside 0–100`);
    if (!Object.values(feedback).some(Boolean)) problems.push("no feedback for student");

    forms.push({
      sheet: ws.name,
      matriculation: matric,
      module: asText(rightOf(ws, findLabel(ws, "Module"))),
      title: asText(rightOf(ws, findLabel(ws, "Title of Project"))),
      lecturer: asText(rightOf(ws, findLabel(ws, "LECTURER"))),
      final_mark: final,
      feedback,
      problems,
    });
  }

  return flagDuplicates(forms);
}

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

/** The feedback as Moodle shows it: the three headings of the form, then the lecturer's words, untouched. */
export function feedbackHtml(f: MarkingForm["feedback"]): string {
  const parts: [string, string][] = [
    ["Special Abilities", f.special_abilities],
    ["Action Points", f.action_points],
    ["Areas for Development", f.areas_for_development],
  ];
  return parts
    .filter(([, text]) => text)
    .map(([head, text]) => `<p><strong>${head}</strong><br>${escape(text)}</p>`)
    .join("\n");
}
