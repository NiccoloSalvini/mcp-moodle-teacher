#!/usr/bin/env node
/**
 * Teacher-side MCP server for Moodle.
 *
 * The Moodle MCP servers published so far are written from the student's seat:
 * my courses, my grades, my deadlines. A tutor needs the other half of the API —
 * who submitted, what did they submit, put a mark and written feedback on it,
 * tell the class something.
 *
 * Reads come first. The two writing tools say so in their description, and the
 * server's instructions tell the assistant to confirm before calling them.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { Moodle, MoodleError, plain, when } from "./moodle.js";

const server = new McpServer(
  { name: "moodle-teacher", version: "0.1.0" },
  {
    instructions:
      "Teacher-side Moodle. The read tools answer: who is enrolled, who submitted, " +
      "what did they hand in, what is still missing. grade_submission and announce " +
      "write to Moodle and are immediately visible to students, so confirm the content " +
      "with the user before calling them. Call whoami first when something fails: the " +
      "token's permissions, not a bug, decide what is possible. These tools return real " +
      "names, email addresses and submitted work — prefer the aggregate (how many are " +
      "missing) over the full list unless the user asks for names.",
  },
);

let client: Moodle | null = null;
const moodle = () => (client ??= new Moodle());

/** Every tool returns JSON as text; errors come back readable, not as a stack. */
function tool(
  name: string,
  description: string,
  schema: z.ZodRawShape,
  handler: (args: any) => Promise<unknown>,
) {
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

const transport = new StdioServerTransport();
await server.connect(transport);
