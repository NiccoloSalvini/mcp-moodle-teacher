"""Teacher-side MCP server for Moodle.

The public moodle-mcp packages are written for students: my courses, my grades,
my deadlines. A tutor needs the other half of the API — who submitted, what did
they submit, put a mark and written feedback on it, tell the class something.

Every tool here is one of the two things a tutor does between sessions:
  READ   who is in the course, what they handed in, what is still missing
  WRITE  a grade with feedback, an announcement, a due-date extension

Writes are marked in their docstring and never happen implicitly.
"""

from __future__ import annotations

import datetime as dt
import html
import re
from typing import Any

from mcp.server.mcpserver import MCPServer

from .client import Moodle, MoodleError

mcp = MCPServer(
    "moodle-teacher",
    instructions=(
        "Teacher-side Moodle. The read tools answer: who is "
        "enrolled, who submitted, what did they hand in, what is still missing. "
        "grade_submission and announce write to Moodle and are immediately "
        "visible to students, so confirm the content with the user before calling "
        "them. Start with whoami() when a call fails: the token's permissions "
        "decide what is possible."
    ),
    version="0.1.0",
)

_moodle: Moodle | None = None


def api() -> Moodle:
    global _moodle
    if _moodle is None:
        _moodle = Moodle()
    return _moodle


def when(timestamp: int | None) -> str | None:
    """Moodle speaks Unix timestamps; 0 means 'not set', which is not 1970."""
    if not timestamp:
        return None
    return dt.datetime.fromtimestamp(timestamp).isoformat(timespec="minutes")


def plain(text: str | None) -> str:
    """Moodle stores descriptions as HTML. Tools return text a human can read."""
    if not text:
        return ""
    text = re.sub(r"<br\s*/?>|</p>|</div>|</li>", "\n", text, flags=re.I)
    text = re.sub(r"<li[^>]*>", "- ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    return re.sub(r"\n{3,}", "\n\n", html.unescape(text)).strip()


# --------------------------------------------------------------------- people


@mcp.tool()
def whoami() -> dict[str, Any]:
    """Who the token belongs to, which Moodle it points at, and how many web-service
    functions that token is allowed to call. Run this first when something fails."""
    info = api().call("core_webservice_get_site_info")
    functions = [f["name"] for f in info.get("functions", [])]
    return {
        "user": info.get("fullname"),
        "username": info.get("username"),
        "userid": info.get("userid"),
        "site": info.get("sitename"),
        "url": info.get("siteurl"),
        "moodle_version": info.get("release"),
        "functions_available": len(functions),
        "can_read_submissions": "mod_assign_get_submissions" in functions,
        "can_grade": "mod_assign_save_grade" in functions,
        "can_post_announcement": "mod_forum_add_discussion" in functions,
        "can_list_students": "core_enrol_get_enrolled_users" in functions,
    }


@mcp.tool()
def list_functions(contains: str = "") -> list[str]:
    """Every web-service function this token may call, optionally filtered by a
    substring (e.g. "assign", "forum", "grade"). Use it to find out what the ESE
    Moodle actually allows before assuming a tool is missing."""
    info = api().call("core_webservice_get_site_info")
    names = sorted(f["name"] for f in info.get("functions", []))
    return [n for n in names if contains.lower() in n.lower()] if contains else names


@mcp.tool()
def my_courses() -> list[dict[str, Any]]:
    """The courses this account is enrolled in, with the id every other tool needs."""
    courses = api().call("core_enrol_get_users_courses", userid=whoami()["userid"])
    return [
        {
            "id": c["id"],
            "shortname": c.get("shortname"),
            "fullname": c.get("fullname"),
            "start": when(c.get("startdate")),
            "end": when(c.get("enddate")),
            "visible": bool(c.get("visible", 1)),
        }
        for c in courses
    ]


@mcp.tool()
def students(courseid: int) -> list[dict[str, Any]]:
    """Everyone enrolled in a course, with their role and last access. The userid
    returned here is what grade_submission expects."""
    users = api().call("core_enrol_get_enrolled_users", courseid=courseid)
    out = []
    for u in users:
        out.append(
            {
                "userid": u["id"],
                "name": u.get("fullname"),
                "email": u.get("email"),
                "roles": [r.get("shortname") for r in u.get("roles", [])],
                "last_access": when(u.get("lastaccess")),
                "city": u.get("city"),
            }
        )
    return sorted(out, key=lambda u: ("student" not in (u["roles"] or []), u["name"] or ""))


# ----------------------------------------------------------------- the course


@mcp.tool()
def course_contents(courseid: int) -> list[dict[str, Any]]:
    """Sections of a course and the modules in each one: what the students see,
    in the order they see it. Module ids ('cmid') identify an activity."""
    sections = api().call("core_course_get_contents", courseid=courseid)
    return [
        {
            "section": s.get("section"),
            "name": s.get("name"),
            "visible": bool(s.get("visible", 1)),
            "summary": plain(s.get("summary"))[:400],
            "modules": [
                {
                    "cmid": m.get("id"),
                    "type": m.get("modname"),
                    "name": m.get("name"),
                    "url": m.get("url"),
                    "visible": bool(m.get("visible", 1)),
                    "files": [c.get("filename") for c in m.get("contents", []) if c.get("filename")],
                }
                for m in s.get("modules", [])
            ],
        }
        for s in sections
    ]


@mcp.tool()
def assignments(courseid: int) -> list[dict[str, Any]]:
    """Assignments in a course: the assignid the submission tools need, the due
    date, the maximum grade and the brief as plain text."""
    data = api().call("mod_assign_get_assignments", courseids=[courseid])
    out = []
    for course in data.get("courses", []):
        for a in course.get("assignments", []):
            out.append(
                {
                    "assignid": a["id"],
                    "cmid": a.get("cmid"),
                    "name": a.get("name"),
                    "due": when(a.get("duedate")),
                    "cutoff": when(a.get("cutoffdate")),
                    "opens": when(a.get("allowsubmissionsfromdate")),
                    "max_grade": a.get("grade"),
                    "team_submission": bool(a.get("teamsubmission")),
                    "brief": plain(a.get("intro"))[:1500],
                }
            )
    return out


# ------------------------------------------------------------- what came in


@mcp.tool()
def submissions(assignid: int, only_submitted: bool = False) -> list[dict[str, Any]]:
    """Who handed in what for one assignment, with the files and any online text.

    Each row carries the userid, the status ('submitted', 'new', 'draft'), when it
    was submitted, whether it was late, and the file names with download URLs.
    Set only_submitted to skip students who have not handed in.
    """
    data = api().call("mod_assign_get_submissions", assignmentids=[assignid])
    due = {a["assignid"]: a["due"] for a in []}  # filled below if needed
    rows: list[dict[str, Any]] = []
    for assignment in data.get("assignments", []):
        for s in assignment.get("submissions", []):
            files, online_text = [], ""
            for plugin in s.get("plugins", []):
                for area in plugin.get("fileareas", []):
                    for f in area.get("files", []):
                        files.append(
                            {
                                "filename": f.get("filename"),
                                "size": f.get("filesize"),
                                "url": f.get("fileurl"),
                                "modified": when(f.get("timemodified")),
                            }
                        )
                for editor in plugin.get("editorfields", []):
                    online_text = plain(editor.get("text"))
            row = {
                "userid": s.get("userid"),
                "status": s.get("status"),
                "attempt": s.get("attemptnumber"),
                "submitted": when(s.get("timemodified")),
                "files": files,
                "online_text": online_text[:2000],
                "gradingstatus": s.get("gradingstatus"),
            }
            if only_submitted and row["status"] != "submitted":
                continue
            rows.append(row)
    _ = due
    return rows


@mcp.tool()
def submission_status(assignid: int, userid: int) -> dict[str, Any]:
    """The full picture for one student on one assignment: submission state,
    whether it is locked, the current grade and any feedback already given."""
    data = api().call("mod_assign_get_submission_status", assignid=assignid, userid=userid)
    last = data.get("lastattempt", {}) or {}
    submission = last.get("submission", {}) or {}
    feedback = data.get("feedback", {}) or {}
    grade = feedback.get("grade", {}) or {}
    comments = ""
    for plugin in feedback.get("plugins", []):
        for editor in plugin.get("editorfields", []):
            comments = plain(editor.get("text"))
    return {
        "status": submission.get("status"),
        "submitted": when(submission.get("timemodified")),
        "gradingstatus": last.get("gradingstatus"),
        "can_edit": last.get("canedit"),
        "graded": bool(grade),
        "grade": grade.get("grade"),
        "graded_at": when(grade.get("timemodified")),
        "feedback": comments,
        "extension_until": when(last.get("extensionduedate")),
    }


@mcp.tool()
def missing(assignid: int, courseid: int) -> list[dict[str, Any]]:
    """Students enrolled in the course who have not submitted this assignment.
    The list to look at on the morning after a deadline."""
    handed_in = {
        s["userid"] for s in submissions(assignid) if s["status"] == "submitted"
    }
    return [
        {"userid": s["userid"], "name": s["name"], "email": s["email"]}
        for s in students(courseid)
        if "student" in (s["roles"] or []) and s["userid"] not in handed_in
    ]


@mcp.tool()
def gradebook(courseid: int, userid: int = 0) -> list[dict[str, Any]]:
    """Grade items for a course, for one student or for everyone the token can see.
    Shows what has a mark and what is still empty."""
    params: dict[str, Any] = {"courseid": courseid}
    if userid:
        params["userid"] = userid
    data = api().call("gradereport_user_get_grade_items", **params)
    rows = []
    for report in data.get("usergrades", []):
        for item in report.get("gradeitems", []):
            rows.append(
                {
                    "student": report.get("userfullname"),
                    "userid": report.get("userid"),
                    "item": item.get("itemname"),
                    "grade": item.get("graderaw"),
                    "formatted": item.get("gradeformatted"),
                    "max": item.get("grademax"),
                    "feedback": plain(item.get("feedback"))[:800],
                }
            )
    return rows


# ------------------------------------------------------------------- writes


@mcp.tool()
def grade_submission(
    assignid: int,
    userid: int,
    grade: float,
    feedback: str = "",
    attempt: int = -1,
    allow_new_attempt: bool = False,
) -> dict[str, Any]:
    """WRITE. Put a mark and written feedback on one student's submission.

    grade is on the assignment's own scale (see assignments()); -1 leaves the mark
    unchanged and only updates the feedback. feedback accepts plain text or simple
    HTML and appears to the student as the feedback comment. Overwrites whatever
    mark and comment were there before. Confirm the numbers with the user first.
    """
    payload: dict[str, Any] = {
        "assignmentid": assignid,
        "userid": userid,
        "grade": grade,
        "attemptnumber": attempt,
        "addattempt": allow_new_attempt,
        "workflowstate": "",
        "applytoall": False,
    }
    if feedback:
        payload["plugindata"] = {
            "assignfeedbackcomments_editor": {"text": feedback, "format": 1}
        }
    api().call("mod_assign_save_grade", **payload)
    return {"ok": True, "assignid": assignid, "userid": userid, "grade": grade,
            "feedback_chars": len(feedback)}


@mcp.tool()
def announce(courseid: int, subject: str, message: str, pinned: bool = False) -> dict[str, Any]:
    """WRITE. Post an announcement in the course's news forum. Every enrolled
    student is notified by email. Check the wording with the user before sending."""
    forums = api().call("mod_forum_get_forums_by_courses", courseids=[courseid])
    news = next((f for f in forums if f.get("type") == "news"), None) or next(iter(forums), None)
    if not news:
        raise MoodleError("noforum", f"No forum found in course {courseid}", "announce")
    result = api().call(
        "mod_forum_add_discussion",
        forumid=news["id"],
        subject=subject,
        message=message,
        options=[{"name": "discussionpinned", "value": pinned}] if pinned else [],
    )
    return {"ok": True, "forum": news.get("name"), "discussionid": result.get("discussionid")}


@mcp.tool()
def announcements(courseid: int, limit: int = 10) -> list[dict[str, Any]]:
    """Recent announcements in the course's news forum, newest first."""
    forums = api().call("mod_forum_get_forums_by_courses", courseids=[courseid])
    news = next((f for f in forums if f.get("type") == "news"), None) or next(iter(forums), None)
    if not news:
        return []
    data = api().call("mod_forum_get_forum_discussions", forumid=news["id"], perpage=limit)
    return [
        {
            "subject": d.get("subject"),
            "by": d.get("userfullname"),
            "posted": when(d.get("created")),
            "message": plain(d.get("message"))[:1500],
            "pinned": bool(d.get("pinned")),
        }
        for d in data.get("discussions", [])
    ]


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
