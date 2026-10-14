# st-tasks

A small command-line tool for checking the [OpenProject](https://www.openproject.org/) work packages assigned to you. It lists your open tasks, flags the ones that are new or changed since your last check, shows task details and comments, and sums up the time you logged on a given day.

It is a single Node.js script with no dependencies and talks to the OpenProject API v3. It defaults to `https://projects.sourcetop.com` but works with any OpenProject instance.

## Requirements

- Node.js 22 or newer
- An OpenProject API access token

## Setup

```sh
git clone <this-repo-url> st-tasks
cd st-tasks
cp .env.example .env
npm link   # optional: puts `st-tasks` and the shortcuts `st` and `st-task` on your PATH
```

Then edit `.env`:

```sh
OPENPROJECT_URL=https://projects.sourcetop.com   # your OpenProject instance
OPENPROJECT_TOKEN=your-token-here
```

To create a token, go to [projects.sourcetop.com/my/access_token](https://projects.sourcetop.com/my/access_token) and generate an **API** token. On another OpenProject instance, the same page is at `<your-instance>/my/access_token`.

If you skip `npm link`, run the script directly with `./st-tasks.js` or `node st-tasks.js`.

## Usage

### Short command: `st`

After `npm link`, `st` is a shortcut for `st-tasks` (`st-task` works too). All three run the same script and take the same arguments, so every example below also works with `st`:

```sh
st                       # same as st-tasks
st log --text            # same as st-tasks log --text
st show 1234             # same as st-tasks show 1234
```

To remove a shortcut, delete it from `bin` in `package.json` and run `npm link` again.

### List your tasks

```sh
st-tasks                 # open tasks assigned to you
st-tasks --all           # include closed tasks (-a also works)
st-tasks -p pubportal    # filter by project name (substring, case-insensitive)
st-tasks -s progress     # filter by status name (substring, case-insensitive)
st-tasks --json          # JSON output
```

The list opens with a summary line, such as "You have 11 open tasks: 7 Open, 3 In progress and 1 On hold", and says when you last checked. Tasks are shown in a bordered table (ID, Project, Subject, Status, Priority, Last updated), sorted by last update.

**NEW / UPD flags.** Each plain `st-tasks` run saves a snapshot of your open tasks to `.state.json`. On the next run, tasks that weren't in the snapshot are marked `NEW` and tasks updated since then are marked `UPD`. Filtered (`-p`, `-s`) and `--all` runs read the snapshot but don't overwrite it.

### Look at one task

```sh
st-tasks show 1234       # details, description and the last 5 comments
st-tasks open 1234       # open the task in your browser
```

### Work log

```sh
st-tasks log             # time you logged today
st-tasks log yesterday
st-tasks log -2          # two days ago
st-tasks log 2026-10-01  # a specific date
st-tasks log --text      # the logged tasks as a "Working on:" list, ready to paste
st-tasks log --json
```

The log shows your total time and a table of tasks sorted by time spent (Time, ID, Project, Subject, Entries, Comments). `--text` prints something like:

```
Working on:

- Task #1234: Fix checkout redirect
- Task #1250: Update author guidelines page
```

### Help

```sh
st-tasks --help
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
