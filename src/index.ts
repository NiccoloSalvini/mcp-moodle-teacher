#!/usr/bin/env node
/**
 * Staff-side MCP server for Moodle: lecturers and the academic office.
 *
 * The Moodle MCP servers published so far are written from the student's seat:
 * my courses, my grades, my deadlines. A tutor needs the other half of the API —
 * who submitted, what did they submit, put a mark and written feedback on it,
 * tell the class something.
 *
 * Reads come first. The writing tools say so in their description, and the
 * server's instructions tell the assistant to confirm before calling them.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join as joinPath } from "node:path";

import PAGE from "./timetable-page.html";
import { aggregateRisk, hoursLate, registerState, type Signal } from "./oversight.js";
import { dayLabel, findClashes, mins, mondayOf, romeMidnight, romeParts, roomFrom, whatsapp, type Lesson } from "./timetable.js";
import { assessmentOf, gradeFiles, moduleKey, readGradeFile, type FileName } from "./grades.js";
import { Moodle, MoodleError, plain, when } from "./moodle.js";

const server = new McpServer(
  { name: "moodle-staff", version: "0.4.0" },
  {
    instructions:
      "Staff-side Moodle, for lecturers and the academic office. The read tools answer: who is enrolled, who submitted, " +
      "what did they hand in, what is still missing, who has been absent. grade_submission, " +
      "announce and mark_attendance " +
      "write to Moodle and are immediately visible to students, so confirm the content " +
      "with the user before calling them. Call whoami first when something fails: the " +
      "token's permissions, not a bug, decide what is possible. These tools return real " +
      "names, email addresses and submitted work — prefer the aggregate (how many are " +
      "missing) over the full list unless the user asks for names.",
  },
);

let client: Moodle | null = null;
const moodle = () => (client ??= new Moodle());

// The academic office's tools work across every course of a campus. A lecturer
// who installs the extension for their own courses can hide them.
const STAFF_ONLY = new Set([
  "grades_check", "grades_csv", "grades_verify", "late_registers", "students_at_risk",
]);
const staffTools = !/^(false|0|no)$/i.test(process.env.MOODLE_STAFF_TOOLS ?? "true");

/** Every tool returns JSON as text; errors come back readable, not as a stack. */
function tool(
  name: string,
  description: string,
  schema: z.ZodRawShape,
  handler: (args: any) => Promise<unknown>,
) {
  if (STAFF_ONLY.has(name) && !staffTools) return;
  server.registerTool(name, { description, inputSchema: schema }, async (args: any) => {
    try {
      const result = await handler(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message =
        error instanceof MoodleError
          ? `${error.message}\n\nIf this is a permission problem, whoami reports what this token may do.`
          : String(error);
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
  });
}

// --------------------------------------------------------------------- people

async function siteInfo() {
  return moodle().call<any>("core_webservice_get_site_info");
}

tool(
  "whoami",
  "Who the token belongs to, which Moodle it points at, and how many web-service " +
    "functions that token is allowed to call. Run this first when something fails.",
  {},
  async () => {
    const info = await siteInfo();
    const functions: string[] = (info.functions ?? []).map((f: any) => f.name);
    return {
      user: info.fullname,
      username: info.username,
      userid: info.userid,
      site: info.sitename,
      url: info.siteurl,
      moodle_version: info.release,
      functions_available: functions.length,
      can_read_submissions: functions.includes("mod_assign_get_submissions"),
      can_grade: functions.includes("mod_assign_save_grade"),
      can_post_announcement: functions.includes("mod_forum_add_discussion"),
      can_list_students: functions.includes("core_enrol_get_enrolled_users"),
      can_read_attendance: functions.includes("mod_attendance_get_sessions"),
      can_mark_attendance: functions.includes("mod_attendance_update_user_status"),
    };
  },
);

tool(
  "list_functions",
  "Every web-service function this token may call, optionally filtered by a substring " +
    '(e.g. "assign", "forum", "grade"). Use it to find out what this Moodle actually ' +
    "allows before assuming a tool is missing.",
  { contains: z.string().default("").describe("Substring filter, empty for all") },
  async ({ contains }) => {
    const info = await siteInfo();
    const names: string[] = (info.functions ?? []).map((f: any) => f.name).sort();
    return contains ? names.filter((n) => n.toLowerCase().includes(contains.toLowerCase())) : names;
  },
);

tool(
  "my_courses",
  "The courses this account is enrolled in, with the id every other tool needs.",
  {},
  async () => {
    const info = await siteInfo();
    const courses = await moodle().call<any[]>("core_enrol_get_users_courses", {
      userid: info.userid,
    });
    return courses.map((c) => ({
      id: c.id,
      shortname: c.shortname,
      fullname: plain(c.fullname),
      start: when(c.startdate),
      end: when(c.enddate),
      visible: Boolean(c.visible ?? 1),
    }));
  },
);

const enrolled = async (courseid: number) => {
  const users = await moodle().call<any[]>("core_enrol_get_enrolled_users", { courseid });
  return users
    .map((u) => ({
      userid: u.id,
      name: u.fullname,
      email: u.email,
      idnumber: u.idnumber ?? "",
      roles: (u.roles ?? []).map((r: any) => r.shortname),
      last_access: when(u.lastaccess),
      city: u.city,
    }))
    .sort((a, b) =>
      Number(!a.roles.includes("student")) - Number(!b.roles.includes("student")) ||
      String(a.name).localeCompare(String(b.name)),
    );
};

tool(
  "students",
  "Everyone enrolled in a course, with their role, email and last access. The userid " +
    "returned here is what grade_submission expects.",
  { courseid: z.number().int().describe("Course id from my_courses") },
  async ({ courseid }) => enrolled(courseid),
);

// ----------------------------------------------------------------- the course

tool(
  "course_contents",
  "Sections of a course and the modules in each one: what the students see, in the " +
    "order they see it. The 'cmid' identifies an activity.",
  { courseid: z.number().int().describe("Course id from my_courses") },
  async ({ courseid }) => {
    const sections = await moodle().call<any[]>("core_course_get_contents", { courseid });
    return sections.map((s) => ({
      section: s.section,
      name: plain(s.name),
      visible: Boolean(s.visible ?? 1),
      summary: plain(s.summary).slice(0, 400),
      modules: (s.modules ?? []).map((m: any) => ({
        cmid: m.id,
        type: m.modname,
        name: plain(m.name),
        url: m.url,
        visible: Boolean(m.visible ?? 1),
        files: (m.contents ?? []).map((c: any) => c.filename).filter(Boolean),
      })),
    }));
  },
);

tool(
  "assignments",
  "Assignments in a course: the assignid the submission tools need, the due date, the " +
    "maximum grade and the brief as plain text.",
  { courseid: z.number().int().describe("Course id from my_courses") },
  async ({ courseid }) => {
    const data = await moodle().call<any>("mod_assign_get_assignments", {
      courseids: [courseid],
    });
    return (data.courses ?? []).flatMap((course: any) =>
      (course.assignments ?? []).map((a: any) => ({
        assignid: a.id,
        cmid: a.cmid,
        name: plain(a.name),
        due: when(a.duedate),
        cutoff: when(a.cutoffdate),
        opens: when(a.allowsubmissionsfromdate),
        max_grade: a.grade,
        team_submission: Boolean(a.teamsubmission),
        brief: plain(a.intro).slice(0, 1500),
      })),
    );
  },
);

// ------------------------------------------------------------- what came in

const submissionRows = async (assignid: number) => {
  const data = await moodle().call<any>("mod_assign_get_submissions", {
    assignmentids: [assignid],
  });
  return (data.assignments ?? []).flatMap((assignment: any) =>
    (assignment.submissions ?? []).map((s: any) => {
      const files: any[] = [];
      let onlineText = "";
      for (const plugin of s.plugins ?? []) {
        for (const area of plugin.fileareas ?? []) {
          for (const f of area.files ?? []) {
            files.push({
              filename: f.filename,
              size: f.filesize,
              url: f.fileurl,
              modified: when(f.timemodified),
            });
          }
        }
        for (const editor of plugin.editorfields ?? []) {
          if (editor.text) onlineText = plain(editor.text);
        }
      }
      return {
        userid: s.userid,
        status: s.status,
        attempt: s.attemptnumber,
        submitted: when(s.timemodified),
        files,
        online_text: onlineText.slice(0, 2000),
        gradingstatus: s.gradingstatus,
      };
    }),
  );
};

tool(
  "submissions",
  "Who handed in what for one assignment: the userid, the status ('submitted', 'new', " +
    "'draft'), when it arrived, the file names with download URLs and any online text.",
  {
    assignid: z.number().int().describe("Assignment id from assignments"),
    only_submitted: z.boolean().default(false).describe("Skip students who have not handed in"),
  },
  async ({ assignid, only_submitted }) => {
    const rows = await submissionRows(assignid);
    return only_submitted ? rows.filter((r: any) => r.status === "submitted") : rows;
  },
);

tool(
  "submission_status",
  "The full picture for one student on one assignment: submission state, whether it is " +
    "locked, the current grade, any feedback already given and any extension.",
  {
    assignid: z.number().int().describe("Assignment id from assignments"),
    userid: z.number().int().describe("Student id from students"),
  },
  async ({ assignid, userid }) => {
    const data = await moodle().call<any>("mod_assign_get_submission_status", {
      assignid,
      userid,
    });
    const last = data.lastattempt ?? {};
    const submission = last.submission ?? {};
    const feedback = data.feedback ?? {};
    const grade = feedback.grade ?? {};
    let comments = "";
    for (const plugin of feedback.plugins ?? []) {
      for (const editor of plugin.editorfields ?? []) {
        if (editor.text) comments = plain(editor.text);
      }
    }
    return {
      status: submission.status,
      submitted: when(submission.timemodified),
      gradingstatus: last.gradingstatus,
      can_edit: last.canedit,
      graded: Object.keys(grade).length > 0,
      grade: grade.grade,
      graded_at: when(grade.timemodified),
      feedback: comments,
      extension_until: when(last.extensionduedate),
    };
  },
);

tool(
  "missing",
  "Students enrolled in the course who have not submitted this assignment. The list to " +
    "look at on the morning after a deadline.",
  {
    assignid: z.number().int().describe("Assignment id from assignments"),
    courseid: z.number().int().describe("Course id from my_courses"),
  },
  async ({ assignid, courseid }) => {
    const rows = await submissionRows(assignid);
    const handedIn = new Set(
      rows.filter((r: any) => r.status === "submitted").map((r: any) => r.userid),
    );
    const people = await enrolled(courseid);
    return people
      .filter((p) => p.roles.includes("student") && !handedIn.has(p.userid))
      .map((p) => ({ userid: p.userid, name: p.name, email: p.email }));
  },
);

tool(
  "gradebook",
  "Grade items for a course, for one student or for everyone the token can see. Shows " +
    "what has a mark and what is still empty.",
  {
    courseid: z.number().int().describe("Course id from my_courses"),
    userid: z.number().int().default(0).describe("One student, or 0 for everyone visible"),
  },
  async ({ courseid, userid }) => {
    const params: Record<string, unknown> = { courseid };
    if (userid) params.userid = userid;
    const data = await moodle().call<any>("gradereport_user_get_grade_items", params);
    return (data.usergrades ?? []).flatMap((report: any) =>
      (report.gradeitems ?? []).map((item: any) => ({
        student: report.userfullname,
        userid: report.userid,
        item: plain(item.itemname),
        grade: item.graderaw,
        formatted: plain(item.gradeformatted),
        max: item.grademax,
        feedback: plain(item.feedback).slice(0, 800),
      })),
    );
  },
);

// ------------------------------------------------------------------- writes

tool(
  "grade_submission",
  "WRITES TO MOODLE, visible to the student. Put a mark and written feedback on one " +
    "submission. The grade is on the assignment's own scale (see assignments); pass -1 " +
    "to leave the mark unchanged and only update the feedback. This overwrites whatever " +
    "mark and comment were there before, so confirm the numbers with the user first.",
  {
    assignid: z.number().int().describe("Assignment id from assignments"),
    userid: z.number().int().describe("Student id from students"),
    grade: z.number().describe("Mark on the assignment's scale, or -1 to leave it unchanged"),
    feedback: z.string().default("").describe("Feedback comment, plain text or simple HTML"),
    attempt: z.number().int().default(-1).describe("Attempt number, -1 for the latest"),
    allow_new_attempt: z.boolean().default(false).describe("Let the student submit again"),
  },
  async ({ assignid, userid, grade, feedback, attempt, allow_new_attempt }) => {
    const payload: Record<string, unknown> = {
      assignmentid: assignid,
      userid,
      grade,
      attemptnumber: attempt,
      addattempt: allow_new_attempt,
      workflowstate: "",
      applytoall: false,
    };
    if (feedback) {
      payload.plugindata = {
        assignfeedbackcomments_editor: { text: feedback, format: 1 },
      };
    }
    await moodle().call("mod_assign_save_grade", payload);
    return { ok: true, assignid, userid, grade, feedback_chars: feedback.length };
  },
);

const newsForum = async (courseid: number) => {
  const forums = await moodle().call<any[]>("mod_forum_get_forums_by_courses", {
    courseids: [courseid],
  });
  const news = forums.find((f) => f.type === "news") ?? forums[0];
  if (!news) throw new MoodleError("noforum", `No forum in course ${courseid}`, "forum");
  return news;
};

tool(
  "announce",
  "WRITES TO MOODLE and emails everyone enrolled. Post an announcement in the course's " +
    "news forum. Check the wording with the user before calling this.",
  {
    courseid: z.number().int().describe("Course id from my_courses"),
    subject: z.string().describe("Subject line"),
    message: z.string().describe("Body, plain text or simple HTML"),
    pinned: z.boolean().default(false).describe("Pin it to the top of the forum"),
  },
  async ({ courseid, subject, message, pinned }) => {
    const forum = await newsForum(courseid);
    const result = await moodle().call<any>("mod_forum_add_discussion", {
      forumid: forum.id,
      subject,
      message,
      ...(pinned ? { options: [{ name: "discussionpinned", value: true }] } : {}),
    });
    return { ok: true, forum: plain(forum.name), discussionid: result.discussionid };
  },
);

tool(
  "announcements",
  "Recent announcements in the course's news forum, newest first.",
  {
    courseid: z.number().int().describe("Course id from my_courses"),
    limit: z.number().int().default(10).describe("How many to return"),
  },
  async ({ courseid, limit }) => {
    const forum = await newsForum(courseid);
    const data = await moodle().call<any>("mod_forum_get_forum_discussions", {
      forumid: forum.id,
      perpage: limit,
    });
    return (data.discussions ?? []).map((d: any) => ({
      subject: plain(d.subject),
      by: d.userfullname,
      posted: when(d.created),
      message: plain(d.message).slice(0, 1500),
      pinned: Boolean(d.pinned),
    }));
  },
);

// --------------------------------------------------------------- attendance
//
// Attendance is a plugin (mod_attendance), not Moodle core. Its web-service
// functions only reach a token if the administrator has added them to the
// token's service: on a site where they are missing every call below fails
// with an access exception, and whoami says so up front.

/** Attendance activities in a course. The WS functions want the instance id, not the cmid. */
const attendanceActivities = async (courseid: number) => {
  const sections = await moodle().call<any[]>("core_course_get_contents", { courseid });
  return sections.flatMap((s) =>
    (s.modules ?? [])
      .filter((m: any) => m.modname === "attendance")
      .map((m: any) => ({ attendanceid: m.instance as number, cmid: m.id, name: plain(m.name) })),
  );
};

const attendanceSessions = async (attendanceid: number) =>
  moodle().call<any[]>("mod_attendance_get_sessions", { attendanceid });

tool(
  "attendance_sessions",
  "The sessions of every attendance register in a course: date, duration, whether the " +
    "register has been taken, and how many students were marked. The sessionid is what " +
    "mark_attendance expects.",
  { courseid: z.number().int().describe("Course id from my_courses") },
  async ({ courseid }) => {
    const activities = await attendanceActivities(courseid);
    return Promise.all(
      activities.map(async (a) => ({
        ...a,
        sessions: (await attendanceSessions(a.attendanceid))
          .sort((x, y) => x.sessdate - y.sessdate)
          .map((s) => ({
            sessionid: s.id,
            date: when(s.sessdate),
            minutes: Math.round((s.duration ?? 0) / 60),
            description: plain(s.description).slice(0, 200),
            taken: Boolean(s.lasttaken),
            marked: (s.attendance_log ?? []).length,
            statuses: (s.statuses ?? [])
              .filter((st: any) => !st.deleted)
              .map((st: any) => ({ statusid: st.id, acronym: st.acronym, description: st.description })),
          })),
      })),
    );
  },
);

/** Absences per student in one course, across every register session already taken. */
async function attendanceByStudent(
  courseid: number,
  absent: string[] = ["A"],
  excused: string[] = ["E"],
  lates_per_absence = 0,
) {
    const people = (await enrolled(courseid)).filter((p) => p.roles.includes("student"));
    const activities = await attendanceActivities(courseid);
    const upper = (xs: string[]) => new Set(xs.map((x) => x.toUpperCase()));
    const absentSet = upper(absent);
    const excusedSet = upper(excused);

    type Row = {
      userid: number;
      name: string;
      email: string;
      counts: Record<string, number>;
      unexcused_dates: string[];
      excused_dates: string[];
      not_marked: string[];
      lates: number;
    };
    const rows = new Map<number, Row>(
      people.map((p) => [
        p.userid,
        {
          userid: p.userid,
          name: p.name,
          email: p.email,
          counts: {},
          unexcused_dates: [],
          excused_dates: [],
          not_marked: [],
          lates: 0,
        },
      ]),
    );

    let taken = 0;
    for (const activity of activities) {
      for (const session of await attendanceSessions(activity.attendanceid)) {
        if (!session.lasttaken) continue;
        taken += 1;
        const date = when(session.sessdate) ?? "?";
        const acronym = new Map<number, string>(
          (session.statuses ?? []).map((st: any) => [st.id, String(st.acronym).toUpperCase()]),
        );
        const marks = new Map<number, number>(
          (session.attendance_log ?? []).map((l: any) => [l.studentid, l.statusid]),
        );
        for (const row of rows.values()) {
          const statusid = marks.get(row.userid);
          if (statusid === undefined) {
            row.not_marked.push(date);
            continue;
          }
          const code = acronym.get(statusid) ?? `status ${statusid}`;
          row.counts[code] = (row.counts[code] ?? 0) + 1;
          if (absentSet.has(code)) row.unexcused_dates.push(date);
          else if (excusedSet.has(code)) row.excused_dates.push(date);
          else if (code === "L") row.lates += 1;
        }
      }
    }

    const students = [...rows.values()].map((row) => {
      const fromLates = lates_per_absence > 0 ? Math.floor(row.lates / lates_per_absence) : 0;
      const total = row.unexcused_dates.length + row.excused_dates.length + fromLates;
      const { lates, ...rest } = row;
      return {
        ...rest,
        absences: {
          unexcused: row.unexcused_dates.length,
          excused: row.excused_dates.length,
          from_late_arrivals: fromLates,
          total,
        },
      };
    });

    return {
      registers: activities.map((a) => a.name),
      taken,
      students: students.sort((a, b) => b.absences.total - a.absences.total || a.name.localeCompare(b.name)),
    };
}

tool(
  "attendance_report",
  "Presences and absences per student across every session already taken: a count for " +
    "each status (present, late, excused, absent, as the register names them), the list " +
    "of dates missed, and a flag for whoever has reached the absence limit. Sessions not " +
    "yet taken are ignored. Excused absences are counted apart from unexcused ones.",
  {
    courseid: z.number().int().describe("Course id from my_courses"),
    max_absences: z
      .number()
      .int()
      .default(0)
      .describe("Flag students with at least this many absences (excused + unexcused); 0 = no flag"),
    absent: z.array(z.string()).default(["A"]).describe("Status acronyms that mean an unexcused absence"),
    excused: z.array(z.string()).default(["E"]).describe("Status acronyms that mean an excused absence"),
    lates_per_absence: z
      .number()
      .int()
      .default(0)
      .describe("If > 0, every N late arrivals count as one extra absence (ESE: 3)"),
  },
  async ({ courseid, max_absences, absent, excused, lates_per_absence }) => {
    const r = await attendanceByStudent(courseid, absent, excused, lates_per_absence);
    return {
      registers: r.registers,
      sessions_taken: r.taken,
      max_absences: max_absences || null,
      students: r.students.map((st) => ({ ...st, at_limit: max_absences > 0 && st.absences.total >= max_absences })),
    };
  },
);

tool(
  "mark_attendance",
  "WRITES TO MOODLE, visible to the student in their attendance record. Set one " +
    "student's status in one session (e.g. turn an absence into excused after a medical " +
    "certificate). statusid comes from attendance_sessions. Confirm with the user first.",
  {
    sessionid: z.number().int().describe("Session id from attendance_sessions"),
    userid: z.number().int().describe("Student id from students"),
    statusid: z.number().int().describe("Status id from the same session's statuses"),
  },
  async ({ sessionid, userid, statusid }) => {
    const [info, session] = await Promise.all([
      siteInfo(),
      moodle().call<any>("mod_attendance_get_session", { sessionid }),
    ]);
    const status = (session.statuses ?? []).find((st: any) => st.id === statusid);
    if (!status) {
      throw new MoodleError("badstatus", `Status ${statusid} does not belong to session ${sessionid}`, "mark_attendance");
    }
    // update_user_status wants the status set as a comma-separated list of the session's status ids.
    const statusset = (session.statuses ?? [])
      .filter((st: any) => st.setnumber === status.setnumber && !st.deleted)
      .map((st: any) => st.id)
      .join(",");
    await moodle().call("mod_attendance_update_user_status", {
      sessionid,
      studentid: userid,
      takenbyid: info.userid,
      statusid,
      statusset,
    });
    return { ok: true, sessionid, userid, status: status.acronym, date: when(session.sessdate) };
  },
);

// -------------------------------------------------------------------- grades
//
// The flow at ESE: each lecturer sends a spreadsheet with a matriculation
// number and a mark per student for each assessment (midterm, final, ...); the
// academic office enters those marks in Moodle, course by course; from Moodle
// each student's marking form is then filled in, exported to PDF, printed and
// stamped. These tools do the Moodle step and its double check.
//
// They never compute or change a mark. Everything uncertain — which course,
// which assignment, whether "57,5" is a mark, whether the student is enrolled —
// is reported and left out rather than guessed.

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

/** The one Moodle course a file name points at, or the reason there is not exactly one. */
async function courseFor(name: FileName): Promise<{ course?: any; problem?: string }> {
  if (!name.module) return { problem: "no module code in the file name" };
  // Moodle searches by substring, and "MBA03" is not inside "MBA003": search every zero padding.
  const [, letters, digits] = name.module.match(/^([A-Z]+)0*(\d+)$/i) ?? [, name.module, ""];
  const spellings = new Set([name.module, ...[2, 3, 4].map((n) => `${letters}${digits.padStart(n, "0")}`)]);
  const byId = new Map<number, any>();
  for (const spelling of spellings) {
    const found = await moodle().call<any>("core_course_search_courses", {
      criterianame: "search",
      criteriavalue: spelling,
      perpage: 100,
    });
    for (const c of found.courses ?? []) byId.set(c.id, c);
  }
  let candidates = [...byId.values()].filter(
    (c: any) => moduleKey(String(c.shortname).split("_")[0]) === moduleKey(name.module!),
  );
  if (name.term) candidates = candidates.filter((c: any) => String(c.shortname).includes(`_${name.term}`));
  if (candidates.length === 1) return { course: candidates[0] };
  const which = `module ${name.module}${name.term ? `, term ${name.term}` : ""}`;
  if (candidates.length === 0) return { problem: `no Moodle course matches ${which}` };
  return {
    problem: `${candidates.length} courses match ${which}: ${candidates.map((c: any) => `${c.id} ${c.shortname}`).join(", ")} — pass courseid`,
  };
}

type Plan = Awaited<ReturnType<typeof planFile>>;

async function planFile(path: string, courseid?: number, itemOverride: Record<string, string> = {}) {
  const file = await readGradeFile(path);
  const problems = [...file.problems];
  const base = { file: basename(path), sheet: file.sheet, name: file.name };

  let course: any;
  if (courseid) {
    const got = await moodle().call<any>("core_course_get_courses_by_field", { field: "id", value: courseid });
    course = got.courses?.[0];
    if (!course) problems.push(`course ${courseid} not found`);
  } else {
    const r = await courseFor(file.name);
    course = r.course;
    if (r.problem) problems.push(r.problem);
  }
  if (!course) return { ...base, course: null, items: {}, entries: [], not_in_file: [], problems };

  // Assessment in the file -> grade item in the course's gradebook. ESE courses
  // carry manual items named "Final", "resit" and "Evaluation / Feedback Final"...
  const items: { id: number; name: string }[] = (
    (await moodle().call<any>("core_grades_get_gradeitems", { courseid: course.id })).gradeItems ?? []
  ).map((g: any) => ({ id: Number(g.id), name: plain(g.itemname) }));
  const isFeedback = (n: string) => /feedback|evaluation/i.test(n);
  const mapping: Record<string, { item: string; feedback_item: string | null }> = {};
  for (const column of file.markColumns.filter((c) => c.assessment)) {
    const kind = column.assessment!;
    const forced = itemOverride[kind] ?? itemOverride[column.header];
    const gradeItems = items.filter((i) => !isFeedback(i.name));
    const matches = forced
      ? items.filter((i) => i.name.toLowerCase() === forced.toLowerCase())
      : gradeItems.filter((i) => assessmentOf(i.name) === kind);
    if (matches.length !== 1) {
      problems.push(
        `column "${column.header}" (${kind}): ${matches.length === 0 ? "no" : matches.length} matching grade item in ${course.shortname}` +
          ` — items: ${items.map((i) => `"${i.name}"`).join(", ")}; pass items {"${kind}": "<item name>"}`,
      );
      continue;
    }
    const fb = items.filter((i) => isFeedback(i.name) && assessmentOf(i.name.replace(/evaluation|feedback|\//gi, " ")) === kind);
    mapping[kind] = { item: matches[0].name, feedback_item: fb.length === 1 ? fb[0].name : null };
  }

  const people = (await enrolled(course.id)).filter((p) => p.roles.includes("student"));
  const byMatric = new Map(people.filter((p) => p.idnumber).map((p) => [String(p.idnumber).trim(), p]));

  const count = new Map<string, number>();
  for (const r of file.rows) if (r.matriculation) count.set(r.matriculation, (count.get(r.matriculation) ?? 0) + 1);

  const entries = [];
  for (const r of file.rows) {
    const person = r.matriculation ? byMatric.get(r.matriculation) : undefined;
    for (const [kind, m] of Object.entries(r.marks)) {
      const target = mapping[kind];
      const feedback = r.feedback[kind] ?? "";
      const reasons: string[] = [];
      if (!r.matriculation) reasons.push("no matriculation number");
      else if (!person) reasons.push(`matriculation ${r.matriculation} is not a student enrolled in ${course.shortname}`);
      if ((count.get(r.matriculation ?? "") ?? 0) > 1) reasons.push("matriculation appears on more than one row");
      if (m.problem) reasons.push(m.problem);
      if (!target) reasons.push(`no grade item for ${kind}`);
      if (feedback && target && !target.feedback_item) reasons.push(`feedback given but no feedback item for ${kind}`);
      entries.push({
        row: r.row,
        matriculation: r.matriculation,
        name: person?.name ?? null,
        userid: person?.userid ?? null,
        assessment: kind,
        item: target?.item ?? null,
        feedback_item: target?.feedback_item ?? null,
        raw: m.raw,
        mark: m.mark,
        feedback,
        status: reasons.length ? "blocked" : "ready",
        reasons,
      });
    }
  }

  const inFile = new Set(file.rows.map((r) => r.matriculation));
  const not_in_file = people
    .filter((p) => !inFile.has(String(p.idnumber ?? "").trim()))
    .map((p) => ({ matriculation: p.idnumber || null, name: p.name }));

  return {
    ...base,
    course: { id: course.id, shortname: course.shortname, fullname: plain(course.fullname) },
    items: mapping,
    entries,
    not_in_file,
    problems,
  };
}

async function plans(path: string, courseid?: number, items?: Record<string, string>) {
  const files = await gradeFiles(path);
  if (files.length === 0) throw new Error(`no .xlsx or .csv files in ${path}`);
  if (courseid && files.length > 1) throw new Error("courseid applies to one file only; pass the file, not the folder");
  const out: Plan[] = [];
  for (const f of files) out.push(await planFile(f, courseid, items ?? {}));

  // Two files giving the same student a mark on the same item: the second import
  // would silently replace the first. Neither goes in until someone decides.
  const seen = new Map<string, string[]>();
  for (const p of out) {
    for (const e of p.entries) {
      if (!p.course || !e.item || !e.matriculation) continue;
      const key = `${p.course.id}|${e.item}|${e.matriculation}`;
      seen.set(key, [...(seen.get(key) ?? []), p.file]);
    }
  }
  for (const p of out) {
    for (const e of p.entries) {
      const files = p.course && e.item && e.matriculation ? seen.get(`${p.course.id}|${e.item}|${e.matriculation}`) ?? [] : [];
      const others = [...new Set(files.filter((f) => f !== p.file))];
      if (others.length) {
        e.reasons.push(`"${e.item}" for this student is also in ${others.join(", ")}`);
        e.status = "blocked";
      }
    }
  }
  return out;
}

const summary = (p: Plan) => ({
  file: p.file,
  course: p.course ? `${p.course.id} ${p.course.shortname}` : null,
  items: p.items,
  rows: p.entries.length,
  ready: p.entries.filter((e) => e.status === "ready").length,
  blocked: p.entries.filter((e) => e.status === "blocked").length,
  problems: p.problems,
});

const pathArgs = {
  path: z.string().describe("A lecturer's .xlsx/.csv, or a folder of them (the Drive folder, downloaded and unzipped)"),
  courseid: z.number().int().optional().describe("Only for a single file whose name does not identify one course"),
  items: z
    .record(z.string(), z.string())
    .optional()
    .describe('Only when a column cannot be matched to a grade item: {"midterm": "Midterm"}'),
};

tool(
  "grades_check",
  "Reads only. For each lecturer's grade file (or every file in a folder): which Moodle " +
    "course its name points at, which gradebook item each mark column goes to (Final, " +
    "resit, ...) and where the feedback goes (Evaluation / Feedback ...), and for every " +
    "student whether the row is ready or blocked, with the reason (not a number, student " +
    "not enrolled in that course, duplicate row...). Also lists enrolled students missing " +
    "from the file. Marks written 57,5 or 57.5 are both read as 57.5.",
  pathArgs,
  async ({ path, courseid, items }) => {
    const all = await plans(path, courseid, items);
    return all.map((p) => ({
      ...summary(p),
      not_in_file: p.not_in_file,
      entries: p.entries.map(({ feedback, ...e }) => ({ ...e, feedback_chars: feedback.length })),
    }));
  },
);

/** RFC 4180: quote every field, double the quotes inside. */
const csvLine = (fields: (string | number)[]) =>
  fields.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(",");

tool(
  "grades_csv",
  "Writes files, not Moodle. For each lecturer's file, a CSV ready for Moodle's " +
    "gradebook import (Grades > Import > CSV file) into the right course: one row per " +
    "ready student, identified by ID number, with the mark and — always next to it, since " +
    "Moodle wipes a grade imported without it — the feedback. Blocked rows go to " +
    "_to_check.csv with the reason, for the academic office to raise with the lecturer. " +
    "Marks are written with a decimal point, exactly as the lecturer gave them.",
  { ...pathArgs, out_dir: z.string().describe("Folder to write into (created if missing)") },
  async ({ path, courseid, items, out_dir }) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(out_dir, { recursive: true });
    const all = await plans(path, courseid, items);
    const written = [];
    const toCheck: string[] = [csvLine(["file", "row", "matriculation", "assessment", "value in file", "reason"])];

    for (const p of all) {
      for (const problem of p.problems) toCheck.push(csvLine([p.file, "", "", "", "", problem]));
      for (const e of p.entries.filter((e) => e.status === "blocked")) {
        toCheck.push(csvLine([p.file, e.row, e.matriculation ?? "", e.assessment, e.raw, e.reasons.join("; ")]));
      }
      if (!p.course) continue;

      // One column per grade item, plus its feedback item when there is one.
      const kinds = Object.keys(p.items);
      // A feedback column only where the lecturer wrote feedback: an empty one would
      // wipe feedback already in Moodle.
      const withFeedback = new Set(p.entries.filter((e) => e.status === "ready" && e.feedback).map((e) => e.assessment));
      const fbCol = (k: string) => (withFeedback.has(k) ? p.items[k].feedback_item : null);
      const header = ["ID number"];
      for (const k of kinds) {
        header.push(p.items[k].item);
        if (fbCol(k)) header.push(fbCol(k)!);
      }
      const byStudent = new Map<string, Record<string, (typeof p.entries)[number]>>();
      for (const e of p.entries.filter((e) => e.status === "ready")) {
        byStudent.set(e.matriculation!, { ...(byStudent.get(e.matriculation!) ?? {}), [e.assessment]: e });
      }
      if (byStudent.size === 0) continue;

      const lines = [csvLine(header)];
      for (const [matric, marks] of byStudent) {
        const row: (string | number)[] = [matric];
        for (const k of kinds) {
          row.push(marks[k]?.mark ?? "");
          if (fbCol(k)) row.push(marks[k]?.feedback ?? "");
        }
        lines.push(csvLine(row));
      }
      const name = `${p.course.shortname}__${p.file.replace(/\.(xlsx|csv)$/i, "")}.csv`;
      await writeFile(join(out_dir, name), lines.join("\n") + "\n", "utf8");
      written.push({ csv: name, course: `${p.course.id} ${p.course.shortname}`, students: byStudent.size, columns: header });
    }
    await writeFile(join(out_dir, "_to_check.csv"), toCheck.join("\n") + "\n", "utf8");
    return {
      out_dir,
      csv_files: written,
      to_check: toCheck.length - 1,
      import_steps:
        "Moodle > course > Grades > Import > CSV file; encoding UTF-8, separator comma; " +
        "Map from 'ID number' to 'useridnumber'; map each column to the grade item of the " +
        "same name (the feedback column to 'Feedback for' its item if it is not a text item).",
    };
  },
);

tool(
  "grades_verify",
  "The double check after the import, reads only: for every ready row in the lecturer's " +
    "file(s), read what Moodle's gradebook now holds for that student on that item and " +
    "compare, mark and feedback. Needs a token allowed to read the user grade report " +
    "(the academic office; a lecturer's token usually is not).",
  pathArgs,
  async ({ path, courseid, items }) => {
    const all = await plans(path, courseid, items);
    const out = [];
    for (const p of all) {
      if (!p.course) {
        out.push({ file: p.file, course: null, problems: p.problems });
        continue;
      }
      const report = await moodle().call<any>("gradereport_user_get_grade_items", { courseid: p.course.id });
      const held = new Map<string, { grade: number | null; feedback: string }>();
      for (const u of report.usergrades ?? []) {
        for (const g of u.gradeitems ?? []) {
          held.set(`${u.userid}:${plain(g.itemname)}`, {
            grade: g.graderaw === null || g.graderaw === undefined ? null : Number(g.graderaw),
            feedback: plain(g.feedback ?? ""),
          });
        }
      }
      const rows = p.entries
        .filter((e) => e.status === "ready")
        .map((e) => {
          const g = held.get(`${e.userid}:${e.item}`);
          const fbItem = e.feedback_item ? held.get(`${e.userid}:${e.feedback_item}`) : undefined;
          const fbHeld = (fbItem?.feedback || g?.feedback || "").replace(/\s+/g, " ").trim();
          const differences: string[] = [];
          if (!g || g.grade === null) differences.push("no mark in Moodle");
          else if (Math.abs(g.grade - (e.mark as number)) > 0.005) differences.push(`mark: file ${e.mark}, Moodle ${g.grade}`);
          if (e.feedback && fbHeld !== e.feedback.replace(/\s+/g, " ").trim()) differences.push("feedback differs");
          return { matriculation: e.matriculation, name: e.name, item: e.item, file: e.mark, moodle: g?.grade ?? null, result: differences.length ? "MISMATCH" : "ok", differences };
        });
      out.push({
        file: p.file,
        course: p.course.shortname,
        checked: rows.length,
        ok: rows.filter((r) => r.result === "ok").length,
        mismatches: rows.filter((r) => r.result !== "ok"),
      });
    }
    return out;
  },
);

// ----------------------------------------------------------------- timetable
//
// The week's lessons across a campus, straight from Moodle: every lesson is an
// attendance session, shown by Moodle as a calendar event. The room lives in the
// session description ("Aula: DREAM"). Replaces the room grid kept in Excel.

const categoryOf = (shortname: string) =>
  /^MBA/i.test(shortname) ? "mba" : /^MS|^MA\d/i.test(shortname) ? "msc" : /^SH/i.test(shortname) ? "sc"
    : /^(IT|SP|EN|LAN)/i.test(shortname) ? "lang" : "ug";

async function weekLessons(search: string, week?: string) {
  const monday = mondayOf(week);
  const from = romeMidnight(monday);
  const to = from + 7 * 86400;

  const found = await moodle().call<any>("core_course_search_courses", {
    criterianame: "search", criteriavalue: search, perpage: 500,
  });
  const courses = new Map<number, any>((found.courses ?? []).map((c: any) => [Number(c.id), c]));
  const ids = [...courses.keys()];

  const events: any[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await moodle().call<any>("core_calendar_get_calendar_events", {
      events: { courseids: ids.slice(i, i + 50) },
      options: { userevents: false, siteevents: false, timestart: from, timeend: to },
    });
    events.push(...(data.events ?? []));
  }
  // A lesson is an attendance session, or a course event someone added by hand.
  const sessions = events.filter((e) => e.modulename === "attendance" || e.eventtype === "course");

  const people = new Map<number, { lecturers: string[]; students: number }>();
  for (const id of new Set(sessions.map((e) => Number(e.courseid)))) {
    const users = await moodle().call<any[]>("core_enrol_get_enrolled_users", { courseid: id });
    const role = (u: any) => (u.roles ?? []).map((r: any) => String(r.shortname));
    people.set(id, {
      lecturers: users.filter((u) => role(u).some((r: string) => /teacher|lecturer|docente|tutor/i.test(r))).map((u) => u.fullname),
      students: users.filter((u) => role(u).includes("student")).length,
    });
  }

  const lessons: Lesson[] = sessions.map((e) => {
    const start = romeParts(Number(e.timestart));
    const end = romeParts(Number(e.timestart) + Number(e.timeduration || 0));
    const c = courses.get(Number(e.courseid));
    const text = plain(e.description ?? "");
    const { room, online } = roomFrom(text);
    const who = people.get(Number(e.courseid)) ?? { lecturers: [], students: 0 };
    return {
      day: start.weekday, date: start.date, start: start.time, end: end.time,
      courseid: Number(e.courseid),
      // "SHC015 AI for Business T1" -> "AI for Business": the code is in shortname already.
      course: plain(c?.fullname ?? e.name).replace(/^[A-Z]{2,4}\d{2,4}\s+/, "").replace(/\s+T\d\s*$/, "").trim(),
      shortname: c?.shortname ?? "",
      lecturers: who.lecturers, students: who.students,
      room: room ?? (online ? "ONLINE" : null),
      note: text.replace(/(?:aula|room)\s*[:\-–]?\s*[^\n,;.(]*/i, "").trim().slice(0, 120),
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || mins(a.start) - mins(b.start));

  return { monday, courses: courses.size, lessons };
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const homePath = (p: string) => (p.startsWith("~/") ? joinPath(homedir(), p.slice(2)) : isAbsolute(p) ? p : joinPath(homedir(), p));

function timetablePage(monday: string, campus: string, search: string, lessons: Lesson[]) {
  const friday = new Date(`${monday}T12:00:00Z`); friday.setUTCDate(friday.getUTCDate() + 4);
  const lastDay = Math.max(4, ...lessons.map((l) => l.day));
  const days = Array.from({ length: lastDay + 1 }, (_, i) => {
    const d = new Date(`${monday}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    const label = dayLabel(d.toISOString().slice(0, 10));
    return { short: label.slice(0, 3), long: label };
  });
  // The rooms of the campus, so free rooms show even before every session has one.
  const known = campus === "ESE Firenze" ? ["DREAM", "VICTORY", "REFLECTION", "CONTEMPLATION", "LIBRARY"] : [];
  const named = [...new Set([...known, ...lessons.map((l) => l.room).filter((r): r is string => !!r && r !== "ONLINE")])];
  const rooms = [...named, "ONLINE", ...(lessons.some((l) => !l.room) ? ["DA DEFINIRE"] : [])];
  const data = {
    title: `Aule · ${campus}`,
    campus,
    week: `Settimana dal ${lower(dayLabel(monday))} al ${lower(dayLabel(friday.toISOString().slice(0, 10)))}`,
    source: `Da Moodle (corsi "${search}"), generato il ${new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" })}.`,
    rooms, days,
    lessons: lessons.map((l) => ({
      day: l.day, room: l.room ?? "DA DEFINIRE", start: l.start, end: l.end, course: l.course,
      prof: l.lecturers.join(", "), group: l.shortname, students: l.students ? String(l.students) : "",
      remote: l.note, cat: categoryOf(l.shortname),
    })),
  };
  // JSON inside a <script>: "</" must not close the tag.
  return PAGE.replace("/*__DATA__*/null", JSON.stringify(data).replace(/<\//g, "<\\/"));
}

tool(
  "timetable",
  "The lessons of one week across a campus, from Moodle: day, time, room, course, " +
    "lecturers and number of students, plus room clashes, a lecturer in two places, " +
    "lessons with no room yet, and the week as a WhatsApp message. The room is read from " +
    "the attendance session description ('Aula: DREAM'). With page_path it also writes " +
    "the week as a web page (per room, per lecturer, free rooms) to open in a browser.",
  {
    search: z.string().default("_FL").describe('Which courses: text in their short name, e.g. "262701_FL" = Florence, AY 26/27, term 1'),
    week: z.string().optional().describe("Any date in the week, YYYY-MM-DD; default this week"),
    lecturer: z.string().optional().describe("Only this lecturer's lessons (part of the name)"),
    page_path: z.string().optional().describe('Where to save the web page, e.g. "Desktop/orario.html"'),
  },
  async ({ search, week, lecturer, page_path }) => {
    const { monday, courses, lessons: all } = await weekLessons(search, week);
    const lessons = lecturer
      ? all.filter((l) => l.lecturers.some((n) => n.toLowerCase().includes(lecturer.toLowerCase())))
      : all;
    const clashes = findClashes(all);
    const campus = /_FL\b|_FL$/i.test(search) ? "ESE Firenze" : "ESE";
    let page: string | null = null;
    if (page_path) {
      page = homePath(page_path);
      await writeFile(page, timetablePage(monday, campus, search, all), "utf8");
    }
    const title = lecturer ? `Prof. ${lecturer}, le sue lezioni · ${campus}` : `Lezioni · ${campus}`;
    return {
      week_of: monday,
      courses_searched: courses,
      lessons: lessons.length,
      clashes: clashes.map((c) => ({ why: c.why, date: c.a.date, a: `${c.a.start}–${c.a.end} ${c.a.course}`, b: `${c.b.start}–${c.b.end} ${c.b.course}` })),
      without_room: all.filter((l) => !l.room).map((l) => `${l.date} ${l.start} ${l.course}`),
      whatsapp: whatsapp(lessons, title, `Settimana dal ${lower(dayLabel(monday))}`, !lecturer),
      page,
      list: lessons.map((l) => ({ date: l.date, start: l.start, end: l.end, room: l.room, course: l.course, lecturers: l.lecturers, students: l.students })),
    };
  },
);

// --------------------------------------------------------------- oversight
//
// What no lecturer sees from inside one course: registers left untaken past the
// 24 hours the syllabus allows, and students in trouble in several courses.

const coursesMatching = async (search: string) => {
  const found = await moodle().call<any>("core_course_search_courses", {
    criterianame: "search", criteriavalue: search, perpage: 500,
  });
  return (found.courses ?? []).map((c: any) => ({
    id: Number(c.id), shortname: String(c.shortname), name: plain(c.fullname).replace(/^[A-Z]{2,4}\d{2,4}\s+/, ""),
  }));
};

const lecturersOf = async (courseid: number) =>
  (await enrolled(courseid))
    .filter((p) => p.roles.some((r: string) => /teacher|lecturer|docente|tutor/i.test(r)))
    .map((p) => ({ name: p.name, email: p.email }));

tool(
  "late_registers",
  "Attendance registers not taken within the hours the rules allow (ESE: 24 hours from " +
    "the end of the lesson), across every course that matches, grouped by lecturer: " +
    "overdue (still not taken), taken late, and pending (lesson over, still in time). " +
    "Needs the mod_attendance_* functions in the token's service.",
  {
    search: z.string().default("_FL").describe('Which courses: text in their short name, e.g. "262701_FL"'),
    days: z.number().int().default(14).describe("How many days back to look"),
    hours: z.number().int().default(24).describe("Hours allowed after the lesson ends"),
  },
  async ({ search, days, hours }) => {
    const now = Math.floor(Date.now() / 1000);
    const since = now - days * 86400;
    const byLecturer = new Map<string, { email: string; overdue: any[]; taken_late: any[]; pending: any[] }>();
    let sessions = 0;
    for (const course of await coursesMatching(search)) {
      const activities = await attendanceActivities(course.id);
      if (!activities.length) continue;
      const lecturers = await lecturersOf(course.id);
      for (const a of activities) {
        for (const ses of await attendanceSessions(a.attendanceid)) {
          if (ses.sessdate < since) continue;
          const state = registerState(ses, now, hours);
          if (state === "future") continue;
          sessions += 1;
          if (state === "on_time") continue;
          const row = {
            course: course.name, shortname: course.shortname, lesson: when(ses.sessdate),
            hours_late: hoursLate(ses, now, hours),
          };
          for (const l of lecturers.length ? lecturers : [{ name: "(nessun docente iscritto)", email: "" }]) {
            const entry = byLecturer.get(l.name) ?? { email: l.email, overdue: [], taken_late: [], pending: [] };
            (state === "overdue" ? entry.overdue : state === "taken_late" ? entry.taken_late : entry.pending).push(row);
            byLecturer.set(l.name, entry);
          }
        }
      }
    }
    const lecturers = [...byLecturer].map(([name, e]) => ({ lecturer: name, ...e }))
      .sort((a, b) => b.overdue.length - a.overdue.length || b.taken_late.length - a.taken_late.length);
    return {
      looked_back_days: days,
      rule_hours: hours,
      lessons_checked: sessions,
      overdue_total: lecturers.reduce((n, l) => n + l.overdue.length, 0),
      lecturers,
    };
  },
);

tool(
  "students_at_risk",
  "One list per student across every course that matches: absences at or over the " +
    "limit, assignments past their due date and not handed in, and failing marks (below " +
    "the pass mark, on assignments and on gradebook items such as Final). A student with " +
    "trouble in two or more courses, or of two kinds, ranks first. Each source says " +
    "whether it could be read: a lecturer's token usually cannot read the gradebook, and " +
    "attendance needs the mod_attendance_* functions.",
  {
    search: z.string().default("_FL").describe('Which courses: text in their short name, e.g. "262701_FL"'),
    max_absences: z.number().int().default(2).describe("Absences (excused + unexcused) that count as a signal"),
    pass_mark: z.number().default(40).describe("Marks below this, out of 100, count as failing (ESE: 40)"),
    lates_per_absence: z.number().int().default(3).describe("Late arrivals that make one absence (ESE: 3)"),
  },
  async ({ search, max_absences, pass_mark, lates_per_absence }) => {
    const now = Math.floor(Date.now() / 1000);
    const signals: Parameters<typeof aggregateRisk>[0] = [];
    const sources = { attendance: 0, assignments: 0, gradebook: 0, courses: 0 };
    const unreadable = new Set<string>();

    for (const course of await coursesMatching(search)) {
      sources.courses += 1;
      const people = (await enrolled(course.id)).filter((p) => p.roles.includes("student"));
      const who = new Map(people.map((p) => [p.userid, p]));
      const push = (userid: number, signal: Signal) => {
        const p = who.get(userid);
        if (p) signals.push({ userid, name: p.name, matriculation: String(p.idnumber || ""), email: p.email, signal });
      };

      try {
        const att = await attendanceByStudent(course.id, ["A"], ["E"], lates_per_absence);
        if (att.taken) sources.attendance += 1;
        for (const st of att.students) {
          if (st.absences.total >= max_absences) {
            push(st.userid, { kind: "absences", course: course.name, total: st.absences.total, unexcused: st.absences.unexcused, excused: st.absences.excused });
          }
        }
      } catch (error) {
        if (error instanceof MoodleError) unreadable.add("attendance"); else throw error;
      }

      try {
        const data = await moodle().call<any>("mod_assign_get_assignments", { courseids: [course.id] });
        const due = (data.courses?.[0]?.assignments ?? []).filter((a: any) => a.duedate && a.duedate < now);
        if (due.length) sources.assignments += 1;
        const missingBy = new Map<number, string[]>();
        for (const a of due) {
          const rows = await submissionRows(a.id);
          const handedIn = new Set(rows.filter((r: any) => r.status === "submitted").map((r: any) => r.userid));
          for (const p of people) {
            if (!handedIn.has(p.userid)) missingBy.set(p.userid, [...(missingBy.get(p.userid) ?? []), plain(a.name)]);
          }
          const grades = await moodle().call<any>("mod_assign_get_grades", { assignmentids: [a.id] });
          for (const g of grades.assignments?.[0]?.grades ?? []) {
            const mark = Number(g.grade);
            const pct = a.grade > 0 ? (mark / a.grade) * 100 : mark;
            if (mark >= 0 && pct < pass_mark) push(g.userid, { kind: "fail", course: course.name, item: plain(a.name), mark: Math.round(pct * 10) / 10 });
          }
        }
        for (const [userid, list] of missingBy) push(userid, { kind: "missing", course: course.name, assignments: list });
      } catch (error) {
        if (error instanceof MoodleError) unreadable.add("assignments"); else throw error;
      }

      try {
        const report = await moodle().call<any>("gradereport_user_get_grade_items", { courseid: course.id });
        sources.gradebook += 1;
        for (const u of report.usergrades ?? []) {
          for (const g of u.gradeitems ?? []) {
            if (g.itemtype === "course" || g.itemtype === "category" || g.itemmodule === "assign") continue;
            if (g.graderaw === null || g.graderaw === undefined || !(g.grademax > 0)) continue;
            const pct = (Number(g.graderaw) / Number(g.grademax)) * 100;
            if (pct < pass_mark) push(u.userid, { kind: "fail", course: course.name, item: plain(g.itemname), mark: Math.round(pct * 10) / 10 });
          }
        }
      } catch (error) {
        if (error instanceof MoodleError) unreadable.add("gradebook"); else throw error;
      }
    }

    const students = aggregateRisk(signals);
    return {
      courses: sources.courses,
      read: {
        attendance: unreadable.has("attendance") ? "not readable with this token (needs mod_attendance_* functions)" : `${sources.attendance} courses with registers taken`,
        assignments: unreadable.has("assignments") ? "not readable" : `${sources.assignments} courses with past deadlines`,
        gradebook: unreadable.has("gradebook") ? "not readable with this token (the academic office's can)" : `${sources.gradebook} courses`,
      },
      rules: { max_absences, pass_mark, lates_per_absence },
      high: students.filter((s) => s.level === "alto").length,
      medium: students.filter((s) => s.level === "medio").length,
      students,
    };
  },
);

// ------------------------------------------------------------------ prompts
//
// Ready-made requests the academic office picks from the app's menu instead of
// writing a prompt. They describe the job in plain Italian and name the tools.

const STYLE =
  "Rispondi in italiano semplice, senza termini tecnici: chi legge lavora in segreteria, non è una programmatrice. " +
  "Niente nomi di tool o di funzioni nella risposta. Prima di qualunque azione che cambia Moodle o manda messaggi, chiedi conferma.";

server.registerPrompt(
  "orario_settimana",
  {
    title: "Orario della settimana",
    description: "Le lezioni della settimana con aule, docenti e studenti; conflitti; messaggio WhatsApp; pagina da aprire",
    argsSchema: { settimana: z.string().optional().describe("Un giorno della settimana, es. 2026-10-05 (vuoto = questa settimana)") },
  },
  ({ settimana }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          `Preparami l'orario della settimana ${settimana ? `che contiene il ${settimana}` : "corrente"} per la sede di Firenze. ` +
          `Usa timetable con search "_FL"${settimana ? ` e week "${settimana}"` : ""} e page_path "Desktop/orario-settimana.html". ` +
          "Poi dimmi, in quest'ordine: 1) se ci sono sovrapposizioni (stessa aula o stesso docente), 2) quali lezioni non hanno ancora un'aula, " +
          "3) il messaggio WhatsApp pronto da copiare, in un blocco a parte, 4) che la pagina è sulla Scrivania. " + STYLE,
      },
    }],
  }),
);

if (staffTools) server.registerPrompt(
  "carica_voti",
  {
    title: "Carica i voti dei professori",
    description: "Controlla la cartella di Excel dei professori e prepara i file da importare su Moodle",
    argsSchema: { cartella: z.string().describe('La cartella con gli Excel, es. "Downloads/Voti T1"') },
  },
  ({ cartella }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          `Nella cartella "${cartella}" (percorso a partire dalla mia cartella utente) ci sono gli Excel con i voti mandati dai professori. ` +
          "1) Controllali con grades_check e riassumimi per ogni file: corso Moodle trovato, quanti voti sono pronti, quanti bloccati e perché, " +
          "e gli studenti iscritti che mancano dal file. 2) Chiedimi conferma. 3) Crea i file per Moodle con grades_csv nella cartella " +
          `"${cartella} - per Moodle". 4) Spiegami passo passo come importarli su Moodle (Valutazioni > Importa > File CSV, abbinare "ID number" a ` +
          "useridnumber, ogni colonna alla voce con lo stesso nome). 5) Ricordami di tornare qui dopo l'import per il controllo finale con grades_verify. " +
          "Le righe bloccate sono in _to_check.csv: preparami una breve mail per ciascun professore con le sue righe da chiarire. " + STYLE,
      },
    }],
  }),
);

if (staffTools) server.registerPrompt(
  "controllo_presenze",
  {
    title: "Controllo presenze del venerdì",
    description: "Assenze della settimana per ogni corso, registri non compilati, studenti che hanno raggiunto una soglia",
    argsSchema: { soglia: z.string().optional().describe("Numero di assenze che fa scattare l'avviso (predefinito 2)") },
  },
  ({ soglia }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          "Fai il controllo presenze della settimana per la sede di Firenze. Trova i corsi con timetable (search \"_FL\"), " +
          `poi per ciascuno usa attendance_report con max_absences ${soglia || "2"} e lates_per_absence 3. ` +
          "Dimmi: 1) le lezioni della settimana il cui registro non risulta compilato (vanno sollecitati i docenti, e quelle lezioni non contano come assenze), " +
          "2) gli studenti che hanno raggiunto la soglia, corso per corso, distinguendo assenze giustificate e non, " +
          "3) per ciascuno una bozza di mail di avviso dal tono pacato. Non inviare nulla: sono bozze da rivedere. " +
          "Se i dati delle presenze non sono accessibili, spiegami che serve l'abilitazione da parte dell'amministratore di Moodle. " + STYLE,
      },
    }],
  }),
);

if (staffTools) {
  server.registerPrompt(
    "registri_in_ritardo",
    {
      title: "Registri presenze in ritardo",
      description: "Docenti che non hanno fatto l'appello su Moodle entro 24 ore dalla lezione, con bozza di sollecito",
      argsSchema: { giorni: z.string().optional().describe("Quanti giorni indietro guardare (predefinito 14)") },
    },
    ({ giorni }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text:
            `Controlla i registri presenze della sede di Firenze degli ultimi ${giorni || "14"} giorni con late_registers (search "_FL"). ` +
            "La regola del syllabus ESE è: appello su Moodle entro 24 ore dalla lezione. Dimmi: 1) quali docenti hanno ancora registri non compilati, " +
            "con corso e data di ogni lezione, 2) chi li ha compilati in ritardo, 3) per ogni docente con registri mancanti una breve mail di sollecito, " +
            "cortese e concreta (quali lezioni, entro quando), in inglese se il docente non è italiano. Non inviare nulla. " + STYLE,
        },
      }],
    }),
  );

  server.registerPrompt(
    "studenti_a_rischio",
    {
      title: "Studenti a rischio",
      description: "Studenti in difficoltà su più corsi: assenze, consegne mancanti, voti insufficienti",
    },
    () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text:
            'Usa students_at_risk (search "_FL") e fammi il quadro degli studenti a rischio della sede di Firenze. ' +
            "Prima quelli a rischio alto (problemi in più corsi e di più tipi), poi medio. Per ciascuno: nome, matricola, e in una riga cosa succede " +
            "corso per corso (assenze, consegne mancanti, voti sotto la sufficienza). Dimmi anche quali dati non è stato possibile leggere, " +
            "così so se il quadro è completo. Alla fine proponimi, per i casi alti, una bozza di mail allo studente per fissare un colloquio, " +
            "dal tono attento e non punitivo. Non inviare nulla. " + STYLE,
        },
      }],
    }),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
