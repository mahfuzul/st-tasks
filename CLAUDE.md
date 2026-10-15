# st-tasks — project notes

Maintainer notes for working on this tool. `README.md` covers setup and usage. This file covers the decisions, API quirks and conventions that the code doesn't explain on its own.

## What it is

- A CLI for checking the OpenProject work packages assigned to the owner on https://projects.sourcetop.com (OpenProject user ID 26).
- One file, `st-tasks.js`. Plain Node ESM, **no dependencies**. Keep it that way: it uses `process.loadEnvFile`, global `fetch` and nothing from npm.
- Needs Node 22 or newer (`engines` in `package.json`). The dev machine runs Node 26.
- `npm link` installs three bin aliases for the same script: `st-tasks`, `st-task` and `st`. The symlinks go in `/opt/homebrew/bin`.

## Commands

| Command | Function | Notes |
| --- | --- | --- |
| `st` / `st-tasks` | `list()` | Open tasks assigned to me. Filters: `--all`/`-a`, `-p <project>`, `-s <status>`, `--json` |
| `st show <id>` | `show()` | Details, description, "Last updated", the last 5 comments |
| `st open <id>` | inline | Opens the task in the browser (`open` on macOS, `xdg-open` elsewhere) |
| `st log [date]` | `worklog()` | Time logged on a date. Date: `today`, `yesterday`, `-N`, `YYYY-MM-DD`, in any position. `--text`, `--json`, `--miss` |
| `st --help` | inline | Prints the header comment lines of `st-tasks.js` (`.split('\n').slice(1, 13)`). **Update that slice if you add or remove usage lines.** |

## Output (requested by the user, keep as is)

- **Always a table.** Bordered, rounded box drawing (`╭┬╮ │ ├┼┤ ╰┴╯`), dimmed borders, bold header.
- **List columns:** flag (NEW/UPD), ID, Project, Subject, Status, Priority, Last updated, Log. "Last updated" is the local `YYYY-MM-DD HH:MM` plus a dim relative time. "Log" is an OSC 8 link to `${BASE}/work_packages/<id>/time_entries/new` (plain text "+ Log" when not a TTY).
- **Log columns:** Time, ID, Project, Subject, Entries, Comments.
- **Missing log time (`st log --miss`):** shows only a table of tasks I commented on or changed the status of that day with no time entry ("N tasks with activity but no time logged DATE:"). Columns: ID, Project, Subject, Activity (`Commented`, `Status → X`), Log (`+ Log` link). `--json` adds `missingLogTime`; `--text` ignores the flag. It's a flag because it's slow (5-15s): `fetchTouched()` lists tasks with `updatedAt` `<>d` from the start of the local day **until now** (a task I commented on may have been updated since; all projects, any assignee), drops tasks that already have time logged that day, then reads each remaining task's `/activities` (12 at a time) and keeps mine. My activities per task are cached in `.cache.json` (`{base, meId, tasks: {id: {updatedAt, seen, mine: [{at, actions}]}}}`), valid while the task's `updatedAt` is unchanged, so repeat runs and other dates need few requests; entries unseen for 60 days are pruned. A corrupt or missing cache is ignored. A cold run for -14 takes ~40s, mostly because the collection query is ~2.5s per 100 tasks and `select` doesn't shrink it. Plain `st log` stays fast (one time-entries query).
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
- **Update notice:** `updateNotice()` prints "Update available (N new commits). Run: git -C <repo> pull" to **stderr** (TTY only, never with `--json`/`--text`/`open`/`--help`). It counts `HEAD..@{u}` locally, and a detached background `git fetch` runs when `.git/FETCH_HEAD` is over 6h old, so the notice shows one run after a push. Needs an upstream branch; silent otherwise.
- **Loader:** `loader` (spinner + progress bar) draws on **stderr** only when `process.stderr.isTTY`, otherwise every call is a no-op. Commands `start()` it before fetching and must `stop()` it before the first stdout line; `die()` stops it, and `exit`/`SIGINT` handlers restore the cursor. `fetchTouched()` drives the bar with `loader.progress(done, total)`. Test the TTY path with the Node wrapper (also set `process.stderr.isTTY = true`).
- **EPIPE** (e.g. `st | head`) is handled by a `process.stdout.on('error')` handler that exits 0.

- **Untrusted text:** subjects, comments, project and user names are written by other OpenProject users. Pass every API string through `cell()` (one line, for table cells and headers) or `safe()` / `decode()` (multi-line, for descriptions and comments) where it enters the program. They strip control characters and bidi overrides so content can't inject terminal escape sequences (fake OSC 8 links, OSC 52 clipboard writes).

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
