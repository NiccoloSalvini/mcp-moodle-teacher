# mcp-moodle-teacher

An MCP server that gives an AI assistant the teacher's half of Moodle: who is
enrolled, who submitted, what they handed in, what is still missing — and, when
you ask for it, a mark with written feedback, or an announcement to the class.

The Moodle MCP servers published so far are written from the student's seat:
*my* courses, *my* grades, *my* deadlines. This one is for the person marking the
work. Nineteen tools, read-first, with the writing tools marked as such.

Tested against Moodle 4.5 with the standard `moodle_mobile_app` web service.

**Not comfortable with a terminal?** There is nothing to type:
[install it as an extension](docs/connect.md), with pictures.

## What it does

**Reading**

| Tool | Answers |
|---|---|
| `whoami` | who the token belongs to, which Moodle, and what that token may do |
| `list_functions` | every web-service function your token is allowed to call |
| `my_courses` | your courses, with the id every other tool needs |
| `students` | who is enrolled: role, email, city, last access |
| `course_contents` | sections and modules as the students see them |
| `assignments` | assignments with due date, maximum grade, and the brief as plain text |
| `submissions` | who submitted what, with file names and download URLs |
| `submission_status` | one student on one assignment: state, grade, feedback, extension |
| `missing` | enrolled students who have **not** submitted — the morning-after list |
| `gradebook` | grade items with marks and feedback |
| `announcements` | recent posts in the course news forum |
| `attendance_sessions` | the sessions of each attendance register: date, duration, whether taken |
| `attendance_report` | presences and absences per student, excused apart, with an optional absence limit |

**Lecturers' grade files** — for the academic office that enters marks sent in
by lecturers as spreadsheets (one file per module, a matriculation number and a
mark per student for each assessment).

| Tool | Does |
|---|---|
| `grades_check` | reads a file or a whole folder: which course each file points at (from its name), which gradebook item each column goes to, and which rows are ready or blocked — mark not a number, student not enrolled in that course, same student twice |
| `grades_csv` | writes one CSV per file for Moodle's gradebook import (Grades ▸ Import ▸ CSV), mark and feedback side by side, plus `_to_check.csv` with every blocked row and why |
| `grades_verify` | after the import, reads the gradebook back and compares it with the lecturers' files, row by row |

Marks are copied, never computed: `57,5` and `57.5` are both 57.5, and anything
uncertain (`ABS`, `5 7`, a cell Excel turned into a date) is reported, not guessed.
Why a CSV and not a direct write: gradebook items created by hand (the usual
"Final" and "resit") have no web service that writes them; the CSV import is
Moodle's own way in.

**Writing** — these change what students see, so the server's instructions tell
the assistant to confirm with you before calling them.

| Tool | Does |
|---|---|
| `grade_submission` | mark and written feedback on one submission |
| `announce` | a post in the news forum; everyone enrolled is emailed |
| `mark_attendance` | one student's status in one session, e.g. absent → excused after a certificate |

The attendance tools need the `mod_attendance_*` functions to be part of your
token's web service. On many sites they are not: `whoami` says so
(`can_read_attendance`), and the site administrator can add them.

## What it deliberately does not do

**Upload course materials.** Moodle core has no web service that creates a
module or a resource, so no MCP server can add a file to a course section. Put
the materials where you already keep them (a course website, a repository) and
link to them from Moodle.

## Install

**As a Claude Desktop extension** — download `mcp-moodle-teacher.mcpb` from the
[latest release](https://github.com/NiccoloSalvini/mcp-moodle-teacher/releases/latest),
then Settings ▸ Extensions ▸ Install Extension… and fill in the two boxes.
Nothing else to install: Claude Desktop runs it. The
[illustrated walkthrough](docs/connect.md) covers this in full.

**From the command line**, for Codex, Claude Code or any other MCP client — it
builds itself on install, so there is nothing to clone:

```bash
npx -y github:NiccoloSalvini/mcp-moodle-teacher
```

**From a clone:**

```bash
npm install && npm run build     # dist/index.js
npm run bundle                   # dist/mcp-moodle-teacher.mcpb
```

## Get a token

Your Moodle must have web services enabled. If *Preferences → Security keys*
exists for your account, copy the token for **Moodle mobile web service**. If
that page is empty — your role may lack `moodle/webservice:createtoken` — the
included script asks Moodle directly:

```bash
MOODLE_SITE=https://moodle.example.edu bash scripts/get-moodle-token.sh
```

It reads the password with `read -s`, never echoes it, never stores it and never
puts it on a command line. It writes `.env` with mode 600.

Use the exact base URL Moodle knows itself by. If you get
`requirecorrectaccess`, you have the wrong host — try it with and without `www`.

## Configure your MCP client

```json
{
  "mcpServers": {
    "moodle": {
      "command": "npx",
      "args": ["-y", "github:NiccoloSalvini/mcp-moodle-teacher"],
      "env": {
        "MOODLE_URL": "https://moodle.example.edu/webservice/rest/server.php",
        "MOODLE_TOKEN": "${MOODLE_TOKEN}"
      }
    }
  }
}
```

For Codex, one line does it:

```bash
codex mcp add moodle --env MOODLE_URL=… --env MOODLE_TOKEN=… -- npx -y github:NiccoloSalvini/mcp-moodle-teacher
```

Export `MOODLE_TOKEN` in the shell that launches the client (`set -a; . .env; set +a`)
rather than writing it into the JSON, so the credential stays out of version control.

Then ask `whoami` first. It reports how many functions your token can reach and
whether grading and posting are among them; most failures are a permission the
site has not granted, not a bug.

## Handling the token

A Moodle web-service token is a bearer credential carrying all of your rights,
including marking. Treat it as a password:

- It is sent in the **POST body**, never in the query string, because URLs are
  written to proxy logs, to the server's access log and to any client's request log.
- Transport and Moodle errors are redacted before they become messages.
- Installed as an extension, the token goes in a field marked sensitive: the app
  stores it, and it never appears in a configuration file you might share.
- `.env` is gitignored and written with mode 600.
- If a token is exposed, revoke it in *Preferences → Security keys* (or ask your
  admin to delete it) and fetch a new one. Requesting a token again returns the
  **same** one until the old is deleted.

## Personal data

These tools return real names, email addresses and submitted work. Anything an
assistant sees can end up in a transcript. Ask for the aggregate — how many are
missing, which one is at risk — before you ask for the list.

## Licence

MIT.
