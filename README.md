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

The examples use `st`. After `npm link`, `st-tasks` and `st-task` work too: all three run the same script and take the same arguments.

To remove an alias, delete it from `bin` in `package.json` and run `npm link` again.

### List your tasks

```sh
st                 # open tasks assigned to you
st --all           # include closed tasks (-a also works)
st -p pubportal    # filter by project name (substring, case-insensitive)
st -s progress     # filter by status name (substring, case-insensitive)
st --json          # JSON output
```

The list opens with a summary line, such as "You have 11 open tasks: 7 Open, 3 In progress and 1 On hold", and says when you last checked. Tasks are shown in a bordered table (ID, Project, Subject, Status, Priority, Last updated, Log), sorted by last update. The `+ Log` link in the last column opens that task's "log time" page (`/work_packages/<id>/time_entries/new`) in your browser.

**NEW / UPD flags.** Each plain `st` run saves a snapshot of your open tasks to `.state.json`. On the next run, tasks that weren't in the snapshot are marked `NEW` and tasks updated since then are marked `UPD`. Filtered (`-p`, `-s`) and `--all` runs read the snapshot but don't overwrite it.

### Look at one task

```sh
st show 1234       # details, description and the last 5 comments
st open 1234       # open the task in your browser
```

### Work log

```sh
st log             # time you logged today
st log yesterday
st log -2          # two days ago
st log 2026-10-01  # a specific date
st log --text      # the logged tasks as a "Working on:" list, ready to paste
st log --json
st log --miss      # tasks you touched but haven't logged time for (slower)
st log -2 --miss   # the same for a specific day
```

The log shows your total time and a table of tasks sorted by time spent (Time, ID, Project, Subject, Entries, Comments). `--text` prints something like:

```
Working on:

- Task #1234: Fix checkout redirect
- Task #1250: Update author guidelines page
```

**Missing log time.** `st log --miss` is a reminder for forgotten entries. It lists the tasks where you left a comment or changed the status on that day (any project, any assignee) but have no time entry, with a short Activity note (`Commented`, `Status → QA`) and a `+ Log` link for each. It takes a few seconds because it reads the activity of every task updated that day, so it only runs when you ask for it. `--json` adds a `missingLogTime` list when `--miss` is used; `--text` ignores the flag.

### Updates

When the repository has commits you haven't pulled, the tool prints this to stderr after the output:

```
Update available (2 new commits). Run: git -C /path/to/st-tasks pull
```

It compares against the last fetched state, and a background `git fetch` refreshes that at most every 6 hours, so it never slows a command down. The notice shows one run after a new commit lands. It's skipped when output is piped, with `--json` / `--text`, with `NO_COLOR` set, or if the checkout has no upstream branch.

### Help

```sh
st --help
```

## Output notes

- In a terminal, task IDs are clickable links (OSC 8) in terminals that support them.
- Colors are turned off when the output is piped or `NO_COLOR` is set.
- When piped, long subjects aren't truncated, so tools like `grep` see the full text.

## Files

| File | Purpose |
| --- | --- |
| `st-tasks.js` | The whole tool |
| `.env` | Your instance URL and token (git-ignored) |
| `.env.example` | Template for `.env` |
| `.state.json` | Snapshot used for NEW / UPD flags (git-ignored) |
