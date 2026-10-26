# st-tasks

A small command-line tool for checking the [OpenProject](https://www.openproject.org/) work packages assigned to you. It lists your open tasks, flags the ones that are new or changed since your last check, shows task details and comments, sums up the time you logged on a given day, and lets you comment, log time and change a task's status without opening the browser.

It is a single Node.js script with no dependencies and talks to the OpenProject API v3. It defaults to `https://projects.sourcetop.com` but works with any OpenProject instance.

## Features

- **Your open tasks at a glance:** a summary line and a bordered table, sorted by last update.
- **NEW / UPD flags:** see what appeared or changed since you last checked.
- **One-click time logging:** every task has a `+ Log` link that opens its "log time" form.
- **Task details:** description, status, and the last 5 comments from the terminal.
- **Daily work log:** total time and tasks per day, plus a paste-ready "Working on:" list.
- **Missing time finder:** `st log --miss` lists tasks you commented on or moved to a new status but haven't logged time for.
- **Write from the terminal:** `st comment`, `st log <id> 1h30m` and status shortcuts like `st start`, `st qa` and `st close`.
- **Interactive when you want it:** leave out a task id, user, comment text or log duration and pick from arrow-key lists with type-to-filter instead of memorizing ids and names (terminal only).
- **Update notice:** tells you when a `git pull` is available.
- **Script-friendly:** `--json` output, no colors or truncation when piped, and no dependencies.

## Requirements

- Node.js 22 or newer
- An OpenProject API access token

## Setup

```sh
git clone git@github.com:mahfuzul/st-tasks.git st-tasks
cd st-tasks
cp .env.example .env
npm link   # puts `st` on your PATH (`st-tasks` and `st-task` work too)
```

Then edit `.env`:

```sh
OPENPROJECT_URL=https://projects.sourcetop.com   # your OpenProject instance
OPENPROJECT_TOKEN=your-token-here
```

To create a token, go to [projects.sourcetop.com/my/access_token](https://projects.sourcetop.com/my/access_token) and generate an **API** token. On another OpenProject instance, the same page is at `<your-instance>/my/access_token`.

If you skip `npm link`, run the script directly with `./st-tasks.js` or `node st-tasks.js`.

## Usage

| Command | What it does |
| --- | --- |
| `st` | List the open tasks assigned to you |
| `st show <id>` | Show one task: details, description and recent comments |
| `st log [date]` | Show the time you logged on a day |
| `st log --miss` | Find tasks you worked on but didn't log time for |
| `st log <id> <duration> ["note"]` | Log time on a task |
| `st comment <id> "text"` | Post a comment on a task |
| `st start <id>` | Move a task from Open to In progress (`--force`: from any status, and assign it to you) |
| `st qa <id> [user]` | Move a task to QA and assign it to `<user>`, which it asks for if you leave it out (also `question`, `at_client`) |
| `st close <id>` | Move a task to Closed |
| `st open <id> [user]` | Move a task to Open, and assign it to `<user>` if given (`--force`: to you) |
| `st assign <id> [user]` | Assign a task to `<user>` and nothing else; asks for the name if you leave it out |
| `st -i` | Pick a task, choose an action (show, log, comment, status), repeat; Esc leaves the list |
| `st --help` | Print a short usage summary |

The examples use `st`. After `npm link`, `st-tasks` and `st-task` work too: all three run the same script and take the same arguments. To remove an alias, delete it from `bin` in `package.json` and run `npm link` again.

### Interactive prompts

On a terminal, any argument you leave out is asked for instead of erroring:

- `st show`, `st comment`, `st start`, `st qa`, `st close`, … without an `<id>` open a **task picker**: your open tasks in an arrow-key list. Type to filter by id, subject, project or status, `↑`/`↓` to move, `Enter` to pick, `Esc` to cancel. Typing digits that match nothing offers to use that task id directly. `st open` includes closed tasks, since you usually reopen one.
- `st qa`, `st question`, `st at_client` and `st assign` ask for the person from the project's assignable roster with the same type-to-filter list — no more guessing how a name is spelled.
- `st comment <id>` without a text prompts for the comment.
- `st log <id>` without a duration asks for the time, the date (today by default), an optional note and the activity, with your usual activity preselected.

`st -i` goes further and keeps you in a loop: pick a task, then choose an action from a menu (show details, log time, comment, start, qa, question, at_client, close, open, assign). After an action that only reads or logs you return to the same menu; after a status change you get a freshly fetched task list. A refused or failed action prints its error and returns to the menu instead of leaving. `Esc` goes back one level and leaves at the task list (`q` is just a filter letter). `-i` takes no other command or option and needs a terminal.

`Esc` or `Ctrl-C` cancels any prompt and changes nothing. Without a terminal — in a script or a pipe — missing arguments are still strict usage errors, so scripts never hang.

### `st`: list your tasks

Shows the open tasks assigned to you, most recently updated first. It starts with a summary line, such as "You have 11 open tasks: 7 Open, 3 In progress and 1 On hold", and says when you last checked.

| Option | What it does |
| --- | --- |
| `--all`, `-a` | Include closed tasks |
| `-p`, `--project <name>` | Only tasks whose project name contains `<name>` |
| `-s`, `--status <name>` | Only tasks whose status contains `<name>` |
| `--json` | Print JSON instead of a table |

Project and status matching is case-insensitive, and the two filters can be combined.

```sh
st                       # open tasks assigned to you
st --all                 # include closed tasks
st -p pubportal          # only the PubPortal project
st -s progress           # only "In progress" tasks
st -p kallman -s open    # both filters together
```

The table has these columns: ID, Project, Subject, Status, Priority, Last updated and Log. The ID is a clickable link to the task in terminals that support links. The `+ Log` link opens that task's "log time" page (`/work_packages/<id>/time_entries/new`) in your browser.

**NEW / UPD flags.** Each plain `st` run saves a snapshot of your open tasks to `.state.json`. On the next run, tasks that weren't in the snapshot are marked `NEW` and tasks updated since then are marked `UPD`. Filtered (`-p`, `-s`) and `--all` runs read the snapshot but don't overwrite it, and `--all` shows no flags.

### `st show <id>`: look at one task

Prints the task's title, project, type, status, priority, assignee, author, due date, last updated time, link, description and the last 5 comments. Without an `<id>`, you pick the task from a list (see [Interactive prompts](#interactive-prompts)). `<id>` is the number in the task's URL (for the URL `.../work_packages/1234`, use `1234`).

```sh
st show 1234
```

### `st log [date]`: your work log

Shows the time you logged on a day: a summary line with your total, then a table of tasks sorted by time spent (Time, ID, Project, Subject, Entries, Comments). Without a date it uses today.

| Date | Meaning |
| --- | --- |
| `today` | Today (the default) |
| `yesterday` | Yesterday |
| `-N` | N days ago, for example `-2` |
| `YYYY-MM-DD` | A specific date |

The date can go anywhere in the command.

| Option | What it does |
| --- | --- |
| `--text` | Print the logged tasks as a plain "Working on:" list, ready to paste into a status update |
| `--json` | Print JSON instead of a table |
| `--miss` | List tasks you worked on but didn't log time for (see below) |

```sh
st log                   # today
st log yesterday
st log -2                # two days ago
st log 2026-10-01        # a specific date
st log --text            # a "Working on:" list for today
```

`--text` prints something like:

```
Working on:

- Task #1234: Fix checkout redirect
- Task #1250: Update author guidelines page
```

If nothing was logged, it prints `No time logged on <date>.`

### `st log <id> <duration>`: log time on a task

```sh
st log 20897 1h30m                       # today
st log 20897 45m "fixed the menu"        # with a note
st log 20897 2h yesterday                # on another day (same dates as above)
st log 20897 1h --as qa                  # with a different activity
st log 20897                             # asks for time, date, note and activity
```

Put the date right after the duration. The first other word starts the note and everything after it is the note, including words like `close`, `-1` or `today`, so `st log 20897 1h fixed -1 bug` keeps `-1` in the note. To start a note with a dash, put `--` before it: `st log 20897 1h -- -1 was wrong`.

The duration is limited to what the "Log time" form offers: up to 8 hours plus 15, 30 or 45 minutes, written as `1h`, `45m` or `2h15m` (minutes can only be 15m, 30m or 45m, and the maximum is 8h45m). The command prints the entry and your total for that day.

The activity (Developer, Senior Developer, QA, Project Management, Design / Wireframe, Other) is the one on your latest time entry, falling back to Developer. `--as <name>` picks another; a part of the name is enough (`--as senior`).

### `st comment <id> "text"`: post a comment

```sh
st comment 20897 "Fixed on staging, ready for review"
st comment                               # pick the task, then type the comment when asked
```

Everything after the ID is the comment, even words like `close` or `--json`, and the command prints `Comment #<n> added to task #<id>`.

### Status shortcuts

| Command | Moves the task to | Assigns it |
| --- | --- | --- |
| `st start <id>` | In progress (from Open) | you, with `--force` |
| `st qa <id> <user>` | QA | `<user>` |
| `st question <id> <user>` | Question | `<user>` |
| `st at_client <id> <user>` | At Client | `<user>` |
| `st close <id>` | Closed | |
| `st open <id> [user]` | Open (from any status) | `<user>` if given, you with `--force` |
| `st assign <id> <user>` | (unchanged) | `<user>` |

They only apply to tasks in the expected status: `start` to Open tasks, `qa`, `question`, `at_client` and `close` to Open or In progress ones. `st open` works from any status. Add `--force` to change a task in any other status.

`--force` is also how you take a task back. `st start <id> --force` moves it to In progress from any status (for example when it comes back from QA) and assigns it to you, and `st open <id> --force` does the same with Open. `st assign <id> <user>` only changes the assignee, whatever the status.

If you leave out `<user>` for `qa`, `question`, `at_client` or `assign`, the command shows the people the task can be assigned to in an arrow-key list once it has checked the task: type to filter, `Enter` to pick, `Esc` to cancel with nothing changed. When the input isn't a terminal, for example in a script, it prints the usage message instead of asking.

`<user>` is matched against the people who can be assigned to that task: a part of the name is enough (`st qa 20897 foysal`), and if it matches nobody or more than one person, nothing changes. `st open 20897` without a user or `--force` only changes the status and leaves the assignee alone. Each command prints the change, for example `#20897 In progress → QA, assigned to Abu Foysal`. The IDs in the output are clickable links to the task in the browser.

### `st log --miss`: find missing log time

A reminder for forgotten entries. It shows the tasks where you left a comment or changed the status on that day, on any project and whatever the assignee, but have no time entry that day. Use it with any date.

```sh
st log --miss            # today
st log -2 --miss         # two days ago
```

The output is a table with the task (ID, Project, Subject), what you did (`Commented`, `Status → QA`) and a `+ Log` link to log the time:

```
1 task with activity but no time logged on Tue, 13 Oct 2026:
╭────────┬──────────────────┬────────────────────────┬───────────────────────────────┬───────╮
│ ID     │ Project          │ Subject                │ Activity                      │ Log   │
├────────┼──────────────────┼────────────────────────┼───────────────────────────────┼───────┤
│ #20932 │ Site Maintenance │ Stripe security update │ Commented, Status → At Client │ + Log │
╰────────┴──────────────────┴────────────────────────┴───────────────────────────────┴───────╯
```

In a terminal it then goes through the tasks one at a time and offers to log the time right there: type a duration such as `1h` or `45m` (up to 8h, minutes 15m, 30m or 45m), optionally followed by a note (`45m fixed the menu`), and press Enter. Press Enter on its own to skip a task and `q` to stop. The entry is logged on the day you are checking, with the same activity as `st log <id>` (see below). When the output is piped, or with `--json`, nothing is asked. Ctrl-C or Ctrl-D stops cleanly and still prints what was logged. If a request fails in a way that might have saved the entry (a timeout, a dropped connection), the tool checks before letting you try again, so nothing is logged twice.

It also finds tasks that were updated by someone else after that day. It skips tasks you already logged time on, and it reads the activity of the rest, so it only runs when you ask for it. The first run for an old date can take a while (about 40 seconds for two weeks back); your activity is cached in `.cache.json`, so later runs, for any date, take a few seconds. With `--json` the list is added as `missingLogTime`. `--text` ignores the flag.

### `st --help`: usage summary

Prints the list of commands and options.

```sh
st --help
```

## Good to know

### Updates

When the repository has commits you haven't pulled, the tool prints this to stderr after the output:

```
Update available (2 new commits). Run: git -C /path/to/st-tasks pull
```

It compares against the last fetched state, and a background `git fetch` refreshes that at most every 6 hours, so it never slows a command down. The notice shows one run after a new commit lands. It's skipped when output is piped, with `--json` / `--text`, with `NO_COLOR` set, or if the checkout has no upstream branch.

### Errors

- Failed requests print one readable line (for example `Task #123 not found, or you don't have access to it.`), and the server's own reason when it rejects a change (`Time entry: Hours is too large.`).
- Requests time out after 30 seconds. When a change may have reached the server anyway, the message says so: check with `st show <id>` or `st log` before trying again.
- If the day's total can't be fetched after `st log <id>` saved the entry, you get a warning, not an error, because the entry exists.
- Set `ST_DEBUG=1` to see a stack trace for an unexpected error.

### Output

- In a terminal, task IDs are clickable links (OSC 8) in terminals that support them.
- Colors are turned off when the output is piped or `NO_COLOR` is set.
- When piped, long subjects aren't truncated, so tools like `grep` see the full text.
- While a command is fetching data, a spinner shows on stderr (with a progress bar and elapsed time for `st log --miss`). It's hidden when stderr isn't a terminal, so pipes and redirects stay clean.

## Files

| File | Purpose |
| --- | --- |
| `st-tasks.js` | The whole tool |
| `.env` | Your instance URL and token (git-ignored) |
| `.env.example` | Template for `.env` |
| `.state.json` | Snapshot used for NEW / UPD flags (git-ignored) |
| `.cache.json` | Your activity per task, used to speed up `st log --miss` (git-ignored, safe to delete) |
