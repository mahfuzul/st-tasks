# st-tasks — project notes

Maintainer notes for working on this tool. `README.md` covers setup and usage. This file covers the decisions, API quirks and conventions that the code doesn't explain on its own.

## What it is

- A CLI for checking (and, via a few write commands, updating) the OpenProject work packages assigned to the owner on https://projects.sourcetop.com (OpenProject user ID 26).
- One file, `st-tasks.js`. Plain Node ESM, **no dependencies**. Keep it that way: it uses `process.loadEnvFile`, global `fetch` and nothing from npm.
- Needs Node 22 or newer (`engines` in `package.json`). The dev machine runs Node 26.
- `npm link` installs three bin aliases for the same script: `st-tasks`, `st-task` and `st`. The symlinks go in `/opt/homebrew/bin`.

## Commands

| Command | Function | Notes |
| --- | --- | --- |
| `st` / `st-tasks` | `list()` | Open tasks assigned to me. Filters: `--all`/`-a`, `-p <project>`, `-s <status>`, `--json` |
| `st show <id>` | `show()` | Details, description, "Last updated", the last 5 comments |
| `st log [date]` | `worklog()` | Time logged on a date. Date: `today`, `yesterday`, `-N`, `YYYY-MM-DD`, in any position. `--text`, `--json`, `--miss` |
| `st log <id> <dur> ["note"] [date] [--as act]` | `logTime()` | **Writes.** Creates a time entry |
| `st comment <id> "text"` | `comment()` | **Writes.** Prints `Comment #<activity id>` |
| `st start <id>` / `st close <id>` | `changeStatus()` | **Writes.** No user argument. `start --force` (`takeOver`) assigns the task to me |
| `st qa/question/at_client <id> <user>` | `changeStatus()` | **Writes.** Status + assignee; the user is required. Table in `STATUS_CMDS` |
| `st open <id> [user]` | `changeStatus()` | **Writes.** Status to Open from any status; assigns when a user is given (`--force` without one assigns to me, like `start --force`: `takeOver`). There is no browser-opening command any more: task IDs are OSC 8 links |
| `st assign <id> <user>` | `changeStatus()` | **Writes.** Assignee only (`to: null` in `STATUS_CMDS`), any status, no status check |
| `st --help` | inline | Prints the header comment lines of `st-tasks.js` (`.split('\n').slice(1, 24)`). **Update that slice if you add or remove usage lines.** |

## Output (requested by the user, keep as is)

- **Always a table.** Bordered, rounded box drawing (`╭┬╮ │ ├┼┤ ╰┴╯`), dimmed borders, bold header.
- **List columns:** flag (NEW/UPD), ID, Project, Subject, Status, Priority, Last updated, Log. "Last updated" is the local `YYYY-MM-DD HH:MM` plus a dim relative time. "Log" is an OSC 8 link to `${BASE}/work_packages/<id>/time_entries/new` (plain text "+ Log" when not a TTY).
- **Log columns:** Time, ID, Project, Subject, Entries, Comments.
- **Missing log time (`st log --miss`):** shows only a table of tasks I commented on or changed the status of that day with no time entry ("N tasks with activity but no time logged DATE:"). Columns: ID, Project, Subject, Activity (`Commented`, `Status → X`), Log (`+ Log` link). `--json` adds `missingLogTime`; `--text` ignores the flag. It's a flag because it's slow (5-15s): `fetchTouched()` lists tasks with `updatedAt` `<>d` from the start of the local day **until now** (a task I commented on may have been updated since; all projects, any assignee), drops tasks that already have time logged that day, then reads each remaining task's `/activities` (12 at a time) and keeps mine. My activities per task are cached in `.cache.json` (`{base, meId, tasks: {id: {updatedAt, seen, mine: [{at, actions}]}}}`), valid while the task's `updatedAt` is unchanged, so repeat runs and other dates need few requests; entries unseen for 60 days are pruned. A corrupt or missing cache is ignored. A cold run for -14 takes ~40s, mostly because the collection query is ~2.5s per 100 tasks and `select` doesn't shrink it. Plain `st log` stays fast (one time-entries query). On a TTY the table is followed by a prompt to log time per task (see Write commands).
- The **Type**, **Due** and **Activity** columns were removed on purpose from the list and log tables (Activity only exists in the missing-log-time table). `dueLabel()` is still in the file but unused.
- **Summary line above the list:** "You have N open tasks: 7 Open, 3 In progress and 1 On hold." Statuses are sorted by count. Without `--all` it is followed by "Last checked … · N new or updated since then".
- **Log summary:** "You logged Xh Ym today (Wed, 14 Oct 2026) across N tasks (M entries)."
- **`log --text`** prints exactly this, for pasting into chat:
  ```
  Working on:

  - Task #20897: Subject
  - Task #20901: Subject
  ```
  When nothing is logged it prints "No time logged on DATE."
- **Clickable task IDs** use OSC 8 hyperlinks (`wpLink()`), pointing to `${BASE}/work_packages/<id>`. The user's terminal is Warp.

## Implementation notes

- **Colours and links** are on only when `process.stdout.isTTY && !process.env.NO_COLOR`.
- **`table()`**:
  - `strip()` removes both SGR and OSC 8 codes before measuring widths.
  - Width comes from `process.stdout.columns`, then `$COLUMNS`, then `Infinity`, so piped output is never truncated.
  - Only the Subject and Comments columns shrink (minimum 20).
  - Columns with no title and no values are dropped.
- **`.state.json`** holds `{checkedAt, tasks: {id: updatedAt}}`. It drives the NEW/UPD flags. Only a plain, unfiltered open-task run writes it. `--all` shows no flags at all, otherwise closed tasks would all show as NEW.
- **`rel()`** returns m/h/d, then `Nmo ago`, then `X.Yy ago`. This keeps old tasks from showing duplicate-looking dates.
- **Update notice:** `updateNotice()` prints "Update available (N new commits). Run: git -C <repo> pull" to **stderr** (TTY only, never with `--json`/`--text`/`--help`). It counts `HEAD..@{u}` locally, and a detached background `git fetch` runs when `.git/FETCH_HEAD` is over 6h old, so the notice shows one run after a push. Needs an upstream branch; silent otherwise.
- **Loader:** `loader` (spinner + progress bar) draws on **stderr** only when `process.stderr.isTTY`, otherwise every call is a no-op. Commands `start()` it before fetching and must `stop()` it before the first stdout line; `die()` stops it, and `exit`/`SIGINT` handlers restore the cursor. `fetchTouched()` drives the bar with `loader.progress(done, total)`. Test the TTY path with the Node wrapper (also set `process.stderr.isTTY = true`).
- **EPIPE** (e.g. `st | head`) is handled by a `process.stdout.on('error')` handler that exits 0.
- **Interactive widgets** (section marked `---- Interactive widgets ----` in `st-tasks.js`): zero-dependency, terminal only. `select()` is an arrow-key list with type-to-filter on raw stdin (`emitKeypressEvents` + `setRawMode`, Esc/Ctrl-C cancels, `Ctrl-P/N` move, `Ctrl-U` clears the filter, a `decorate` hook adds synthetic rows like "use task #N anyway"); its core (`selectState`/`selectKey`/`selectLines`/`filterItems`) is pure and testable by slicing the section out of the file. `input()` is a validated one-line prompt over `promptLine()`. Derived pickers: `taskPicker()`, `personPicker()`, `logWizard()`. The widget erases itself after a choice and echoes it on one line; the cursor is hidden while active and always restored.

- **Untrusted text:** subjects, comments, project and user names are written by other OpenProject users. Pass every API string through `cell()` (one line, for table cells and headers) or `safe()` / `decode()` (multi-line, for descriptions and comments) where it enters the program. They strip control characters and bidi overrides so content can't inject terminal escape sequences (fake OSC 8 links, OSC 52 clipboard writes).

## Write commands

- These are the only commands that change data on the live OpenProject. They run immediately, with no confirmation. Test them on a task the owner picks, and delete test time entries afterwards.
- **Time entries:** `POST /api/v3/time_entries` with `workPackage` and `activity` links, `hours` as ISO 8601 and `spentOn`. The server has no `/time_entries/form`, `/schema` or `/activities` list, so activity ids are hard-coded in `ACTIVITIES` (from the Log time form: 1 Project Management, 3 Developer, 29 Senior Developer, 19 QA, 30 Design / Wireframe, 6 Other). The default activity is the one on my latest time entry (`defaultActivity()`), else Developer (3).
- **Time entry `comment` is a plain string** on this server, both when reading and writing. Sending `{raw: ...}` stores the literal text `{"raw"=>"..."}`. Deleting needs `Accept: application/hal+json` (a bare `DELETE` gets 406); test entries are removed through the API with the entry's `delete` link.
- **Durations** mirror the Log time form: 0-8 h plus 0/15/30/45 min (`durationOf()`). The form's own values 25/50/75 for the minutes are hundredths of an hour, so we send real minutes.
- **Comments:** `POST /work_packages/<id>/activities` with `{comment: {raw}}`. The printed number is the activity `id`; the link anchor uses its `version` (the per-task number the web UI shows).
- **Status:** `PATCH /work_packages/<id>` with `lockVersion` and `_links.status` (looked up by name in `/statuses`, not hard-coded). Assignees come from `<project>/available_assignees` (the work-package-level path 404s, paged by `fetchAssignees()`) and are matched by `matchName()`, or picked from a list when no user was typed.
- `api()` takes `{method, body}` for writes and `{soft: true}` to throw instead of exiting (used so `st log --miss` can carry on after one failure).
- `st log --miss` asks for a duration per task through `readline/promises` on a TTY only (`offerLogging()`).

## Argument parsing and error handling

- **Only the first word picks the command** (`parseArgs()`). Later words belong to that command and can never switch to another one: `st log 1 1h close 2` is a note, `st assign 5 John open` is a name. This matters because the commands write. To test the parser, slice `STATUS_CMDS` up to `fetchAssigned` (plus `parseDuration`) out of the file and run it with a stubbed `die`. Never test it through the CLI: a successful parse goes on to write.
- **Missing-argument completion** (terminal only): `parseArgs()` computes `canAsk` (stdin and stdout TTY) and, instead of a usage error, sets `opts.pickTask` (missing `<id>` on id-commands — `open` also shows closed tasks), `opts.askMessage` (`comment` without text), `opts.askLog` (`log <id>` without a duration) or `opts.askWho` (see below). After parsing, the dispatch fills these in with the pickers in the "Interactive widgets" section, then the normal handlers run unchanged: task picker → id, `logWizard()` → duration/date/note/activity, one-line `input()` → comment text. Without a TTY all of these stay strict usage errors, so scripts and pipes never prompt.
- **Missing `<user>`** (`qa`, `question`, `at_client`, `assign`; `user: 'required'` in `STATUS_CMDS`): on a TTY `parseArgs()` sets `opts.askWho` and `changeStatus()` runs `personPicker()` (arrow-key list of the project's `available_assignees` with type-to-filter) after the status guard, so a refused task never asks. The picked user goes straight into `opts.whoUser`, skipping `matchName()`. Cancelling dies without writing. Without a TTY it is the usage error.
- `st log <id>`: after the duration and an optional date, the first other word starts the note and **everything after it is note**, including `-1` and `today`. `--` lets a note start with a dash.
- `api()` has a 30 s timeout. A thrown error carries `ambiguous` when a write may have been applied (timeout, dropped connection, 5xx; not refused/unresolvable). Writes add "check before trying again" to the message; `offerLogging()` re-reads the day's entries before offering a retry. Never retry a write blindly.
- After a successful write, follow-up reads must not fail the command: `logTime()` prints a warning if the day's total can't be fetched.
- `defaultActivity()` warns on stderr when it falls back to Developer because the lookup failed; no earlier entry falls back silently.
- `offerLogging()` guards every `rl.question()` (`ask()` returns null once the prompt is closed) and prints its summary in a `finally`, so Ctrl-C/Ctrl-D never lose the list of what was saved.
- The dispatch is wrapped in a try/catch that turns anything unexpected into a one-line error. `ST_DEBUG=1` prints the stack.
- **Testing failure paths:** run a copy of the script (the script keeps `.env`, `.state.json` and `.cache.json` next to itself) from the scratchpad against a throwaway local mock server, with `OPENPROJECT_URL`/`OPENPROJECT_TOKEN` set in the environment (they win over `.env`). A Node wrapper that sets `stdout.isTTY`/`stdin.isTTY` drives `--miss`; feed stdin slowly, because readline drops lines that arrive before a prompt. Use a normal port: Node refuses to connect to port 1.

## OpenProject API v3 quirks

- **Auth:** Basic auth with user `apikey` and the token as the password. Responses are HAL JSON.
- **Assigned open tasks:** `GET /api/v3/work_packages` with
  - `filters=[{"assignee":{"operator":"=","values":["me"]}},{"status":{"operator":"o","values":[]}}]`
  - `sortBy=[["updatedAt","desc"]]`
  - pagination via `pageSize` and `offset` (1-based page number)
- **Time entries:** the `user` filter **rejects `"me"`**. Fetch `/api/v3/users/me` first and use the numeric ID. Filter the date with `spent_on` and operator `=d`. `hours` is an ISO 8601 duration such as `PT1H30M` (parsed by `hoursOf()`).
- **Activity / comment authors:** `_links.user` has no `title`, so names are looked up by href and cached (`userName()`).
- **Comments and descriptions** contain HTML entities. Pass them through `decode()`.

## Secrets

- The token lives in `.env` (`OPENPROJECT_URL`, `OPENPROJECT_TOKEN`), chmod 600, git-ignored. `.env.example` is the template.
- Never print, log, echo or commit the token. The original token was pasted into a chat on 2026-10-14, so it should be rotated at `/my/access_token`.

## Testing

- No test suite. Test by running against live data:
  ```sh
  env -u FORCE_COLOR NO_COLOR=1 COLUMNS=250 ./st-tasks.js
  env -u FORCE_COLOR NO_COLOR=1 COLUMNS=250 ./st-tasks.js log yesterday
  ./st-tasks.js log --text
  ./st-tasks.js | head -3          # EPIPE check
  ```
- `FORCE_COLOR` is set in Claude's shell and triggers a Node warning next to `NO_COLOR`, so unset it there. This doesn't affect the user.
- To test the TTY code path (colours, OSC 8, borders) without a real terminal, run the script through a small Node wrapper that sets `process.stdout.isTTY = true` and `process.stdout.columns`. `script` can't allocate a pty in the sandbox.

## Repo housekeeping

- Not a git repo yet. If it gets initialised, `.gitignore` already excludes `.env`, `.state.json`, `.cache.json`, `node_modules/` and `/graft/`.
- `graft/` is a local code-graph cache (regenerate it with `graft build`). `.ignore` re-admits it to ripgrep search.
