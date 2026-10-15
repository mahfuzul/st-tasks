# st-tasks

A small command-line tool for checking the [OpenProject](https://www.openproject.org/) work packages assigned to you. It lists your open tasks, flags the ones that are new or changed since your last check, shows task details and comments, and sums up the time you logged on a given day.

It is a single Node.js script with no dependencies and talks to the OpenProject API v3. It defaults to `https://projects.sourcetop.com` but works with any OpenProject instance.

## Features

- **Your open tasks at a glance:** a summary line and a bordered table, sorted by last update.
- **NEW / UPD flags:** see what appeared or changed since you last checked.
- **One-click time logging:** every task has a `+ Log` link that opens its "log time" form.
- **Task details:** description, status, and the last 5 comments from the terminal.
- **Daily work log:** total time and tasks per day, plus a paste-ready "Working on:" list.
- **Missing time finder:** `st log --miss` lists tasks you commented on or moved to a new status but haven't logged time for.
- **Update notice:** tells you when a `git pull` is available.
- **Script-friendly:** `--json` output, no colors or truncation when piped, and no dependencies.

## Requirements

- Node.js 22 or newer
- An OpenProject API access token

## Setup

```sh
git clone <this-repo-url> st-tasks
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
| `st open <id>` | Open a task in your browser |
| `st log [date]` | Show the time you logged on a day |
| `st log --miss` | Find tasks you worked on but didn't log time for |
| `st --help` | Print a short usage summary |

The examples use `st`. After `npm link`, `st-tasks` and `st-task` work too: all three run the same script and take the same arguments. To remove an alias, delete it from `bin` in `package.json` and run `npm link` again.

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

Prints the task's title, project, type, status, priority, assignee, author, due date, last updated time, link, description and the last 5 comments. `<id>` is the number in the task's URL (for the URL `.../work_packages/1234`, use `1234`).

```sh
st show 1234
```

### `st open <id>`: open a task in the browser

Opens `/work_packages/<id>` in your default browser (`open` on macOS, `xdg-open` on Linux).

```sh
st open 1234
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
