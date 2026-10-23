#!/usr/bin/env node
// st-tasks — check work packages assigned to me on OpenProject.
// `st` and `st-task` are aliases of `st-tasks`.
//
//   st-tasks                 open tasks assigned to me (NEW / UPDATED since last check are flagged)
//   st-tasks --all           include closed tasks
//   st-tasks -p pubportal    filter by project name (substring, case-insensitive)
//   st-tasks -s progress     filter by status name (substring, case-insensitive)
//   st-tasks --json          raw JSON output
//   st-tasks show <id>       details, description and recent comments for one task
//   st-tasks log [date]      my work log for today, yesterday or YYYY-MM-DD: time logged per task
//   st-tasks log --miss      tasks I commented on or changed the status of with no time logged (slower); offers to log time
//   st-tasks log --text      the same tasks as a plain "Working on:" list to paste into a status update
//   st-tasks log <id> 1h30m ["note"] [date] [--as qa]   log time (up to 8h; minutes 15m/30m/45m) on a task; default today, my usual activity
//   st-tasks comment <id> "text"                        post a comment on a task
//   st-tasks start <id>                                 Open -> In progress (with --force: from any status, assigned to me)
//   st-tasks qa <id> [user]                             Open/In progress -> QA, assigned to <user>, asked for if left out (also: question, at_client)
//   st-tasks close <id>                                 Open/In progress -> Closed (add --force to skip the status check)
//   st-tasks open <id> [user]                           any status -> Open, assigned to <user> if given (--force: to me)
//   st-tasks assign <id> [user]                         assign to <user> only, status unchanged; asked for if left out
//   st-tasks -i                                         interactive mode: pick a task, choose an action, repeat
//
// On a terminal, anything left out (task id, user, comment text, log duration) is asked for:
// arrow-key lists with type-to-filter for tasks and people, short prompts for the rest.
// Esc cancels. Without a terminal these are strict usage errors, so scripts are unaffected.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(ROOT, '.state.json');
const CACHE_FILE = join(ROOT, '.cache.json');

if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));
const BASE = (process.env.OPENPROJECT_URL || 'https://projects.sourcetop.com').replace(/\/$/, '');
const TOKEN = process.env.OPENPROJECT_TOKEN;
if (!TOKEN) die('OPENPROJECT_TOKEN is not set (see .env.example).');

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
// OSC 8 terminal hyperlink; plain text when not a terminal.
const link = (url, text) => (tty ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text);
const wpLink = (id) => link(`${BASE}/work_packages/${id}`, cyan('#' + id));

// Text from the API is written by other users: drop control characters (escape
// sequences could fake links, write the clipboard, etc.) and bidi overrides.
// `safe` keeps newlines and tabs for multi-line text; `cell` flattens to one line.
const safe = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '');
const cell = (s) => safe(s).replace(/\s+/g, ' ').trim();
const bold = c(1), dim = c(2), red = c(31), green = c(32), yellow = c(33), cyan = c(36), magenta = c(35);

// Spinner / progress bar on stderr for slow commands. A no-op unless stderr is a terminal, so
// pipes and redirects stay clean. Call stop() before printing anything to stdout.
const loader = (() => {
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  let timer = null, label = '', prog = null, started = 0, i = 0;
  const on = process.stderr.isTTY;
  const clock = () => { const s = Math.floor((Date.now() - started) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function draw() {
    const cols = process.stderr.columns || 80;
    let text = label;
    if (prog) {
      const pct = Math.round((prog.done / prog.total) * 100), fill = Math.round((prog.done / prog.total) * 20);
      const tail = `  [${'█'.repeat(fill)}${'░'.repeat(20 - fill)}] ${prog.done}/${prog.total}  ${pct}%  ·  ${clock()}`;
      text = (label.length + tail.length + 2 > cols ? label.slice(0, Math.max(0, cols - tail.length - 3)) + '…' : label) + tail;
    } else if (Date.now() - started > 3000) text += `  ·  ${clock()}`;
    process.stderr.write(`\r\x1b[2K${dim(frames[i++ % frames.length])} ${text.slice(0, cols - 2)}`);
  }
  const self = {
    start(text) {
      if (!on || timer) return self.set(text);
      label = text; started = Date.now();
      process.stderr.write('\x1b[?25l');
      draw();
      timer = setInterval(draw, 80);
      timer.unref();
    },
    set(text) { label = text; prog = null; },
    progress(done, total, text) { if (text) label = text; prog = { done, total }; },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      process.stderr.write('\r\x1b[2K\x1b[?25h');
    },
  };
  if (on) {
    process.on('exit', self.stop);
    process.on('SIGINT', () => { self.stop(); process.exit(130); });
  }
  return self;
})();

// Interactive mode (`st -i`) sets this so a failed action throws back to its menu instead of exiting:
// die() and api() throw, and cancel() throws a `cancelled` error the menu swallows.
let inSession = false;
function cancel(msg) {
  if (inSession) throw Object.assign(new Error(msg), { cancelled: true });
  die(msg);
}
function die(msg) {
  loader.stop();
  if (inSession) throw new Error(msg);
  console.error(red('error: ') + msg);
  process.exit(1);
}

// Turn a failed API response into a short, readable message.
async function apiError(res, path, write) {
  let detail = '';
  try {
    const body = await res.json();
    detail = cell(body._embedded?.errors?.map((e) => e.message).join(' ') || body.message);
  } catch {}
  const wp = /^\/api\/v3\/work_packages\/(\d+)/.exec(path)?.[1];
  const what = wp ? `Task #${wp}` : /\/time_entries/.test(path) ? 'Time entry' : 'That resource';
  if (res.status === 401) return `Authentication failed. Check OPENPROJECT_TOKEN in .env (create one at ${BASE}/my/access_token).`;
  if (res.status === 403) return `${what}: you don't have permission to ${write ? 'change it' : 'access it'}.`;
  if (res.status === 404) return `${what} not found, or you don't have access to it.`;
  if (res.status === 409) return `${what} was changed by someone else a moment ago. Run the command again.`;
  if (res.status === 422 && detail) return `${what}: ${detail}`;
  if (res.status === 429) return 'Too many requests. Wait a moment and try again.';
  if (res.status >= 500) return `${BASE} had a server error (${res.status}). Try again later.`;
  return `${res.status} ${res.statusText}${detail ? ': ' + detail : ''} (${path})`;
}

// `init`: { method, body } for writes; { soft: true } throws instead of exiting, so a caller can carry on.
// A thrown error has `ambiguous` set when the request may have reached the server (timeout, dropped
// connection, 5xx), so a write may have been applied even though it reports a failure.
async function api(path, params, init = {}) {
  const url = new URL(BASE + '/api/v3' + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const fail = (msg, ambiguous = false) => {
    if (ambiguous && init.method) msg += ' The change may still have been applied: check before trying again.';
    if (init.soft || inSession) throw Object.assign(new Error(msg), { ambiguous });
    die(msg);
  };
  let res;
  try {
    res = await fetch(url, {
      method: init.method,
      body: init.body && JSON.stringify(init.body),
      headers: {
        Authorization: 'Basic ' + Buffer.from('apikey:' + TOKEN).toString('base64'),
        Accept: 'application/hal+json',
        ...(init.body && { 'Content-Type': 'application/json' }),
      },
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    const code = e.cause?.code ?? e.cause?.errors?.[0]?.code; // Node wraps IPv4/IPv6 attempts in an AggregateError
    // Refused or unresolvable means the request never left, so nothing can have been applied.
    fail(e.name === 'TimeoutError' ? `${BASE} didn't respond within 30 seconds.` : `Can't reach ${BASE}${code ? ` (${code})` : ''}. Check your connection and OPENPROJECT_URL.`, !['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code));
  }
  if (!res.ok) fail(await apiError(res, url.pathname, Boolean(init.method)), res.status >= 500);
  if (res.status === 204) return null;
  try {
    return await res.json();
  } catch {
    fail(`${BASE} sent a response that is not valid JSON.`, true);
  }
}

// Status shortcuts: `st qa 123 alex` moves a task from one of `from` to `to` (and assigns it when `user`).
// `takeOver`: with --force the task is assigned to me. `to: null` only changes the assignee.
const STATUS_CMDS = {
  start: { to: 'In progress', from: ['Open'], takeOver: true },
  qa: { to: 'QA', from: ['Open', 'In progress'], user: 'required' },
  question: { to: 'Question', from: ['Open', 'In progress'], user: 'required' },
  at_client: { to: 'At Client', from: ['Open', 'In progress'], user: 'required' },
  close: { to: 'Closed', from: ['Open', 'In progress'] },
  open: { to: 'Open', user: 'optional', takeOver: true }, // from any status
  assign: { to: null, user: 'required' }, // assignee only, status untouched
};
const isDate = (a) => a === 'today' || a === 'yesterday' || /^-\d+$/.test(a) || /^\d{4}-\d{2}-\d{2}$/.test(a);

function parseArgs(argv) {
  const opts = { all: false, json: false, project: null, status: null, cmd: 'list', id: null };
  const value = (flag, v) => v ?? die(`${flag} needs a value`);
  let literal = false; // after `--` every word is text, never an option
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], flag = literal ? null : a;
    if (flag === '--') literal = true;
    else if (flag === '--all' || flag === '-a') opts.all = true;
    else if (flag === '--interactive' || flag === '-i') opts.interactive = true;
    else if (flag === '--json') opts.json = true;
    else if (flag === '--text') opts.text = true;
    else if (flag === '--miss') opts.miss = true;
    else if (flag === '--force' || flag === '-f') opts.force = true;
    else if (flag === '--as') opts.as = value(flag, argv[++i]);
    else if (flag === '-p' || flag === '--project') opts.project = value(flag, argv[++i]);
    else if (flag === '-s' || flag === '--status') opts.status = value(flag, argv[++i]);
    else if (flag === '-h' || flag === '--help') opts.cmd = 'help';
    else if (opts.cmd === 'list') {
      // Only the first word picks the command. Later words are that command's arguments and can
      // never switch to another one, so a note like "close 456" can't run `st close 456`.
      if (!['show', 'comment', 'log'].includes(a) && !Object.hasOwn(STATUS_CMDS, a)) die(`unknown argument: ${a}`);
      opts.cmd = a;
      if (a !== 'log') opts.id = argv[++i];
      if (a === 'comment') {
        // Everything after the id is the comment, so it may contain dashes and unquoted words.
        opts.message = argv.slice(i + 1).join(' ').trim();
        break;
      }
    }
    else if (opts.cmd === 'help') continue;
    else if (Object.hasOwn(STATUS_CMDS, opts.cmd)) {
      if (!literal && a.startsWith('-')) die(`unknown argument: ${a}`);
      (opts.who ??= []).push(a); // the person's name, even if a word in it is also a command
    }
    else if (opts.cmd === 'log') {
      if (opts.noteWords) opts.noteWords.push(a); // once the note starts it runs to the end
      else if (!opts.id && !opts.date && /^\d+$/.test(a)) opts.id = a; // st log <id> <duration> ...
      else if (!opts.id) {
        // st log [date]
        if (opts.date || (a.startsWith('-') && !/^-\d+$/.test(a))) die(`unknown argument: ${a}`);
        opts.date = a;
      }
      else if (!opts.duration && parseDuration(a)) opts.duration = a;
      else if (!opts.date && isDate(a)) opts.date = a;
      else if (!literal && a.startsWith('-')) die(`unknown option "${a}" (to start a note with a dash, put -- before the note)`);
      else opts.noteWords = [a];
    }
    else die(`unknown argument: ${a}`);
  }
  const spec = STATUS_CMDS[opts.cmd];
  const idCmds = ['show', 'comment', ...Object.keys(STATUS_CMDS)];
  // On a terminal, missing pieces are asked for with pickers and prompts (see the widget
  // section); elsewhere they stay usage errors, so scripts and pipes never prompt.
  const canAsk = process.stdin.isTTY && process.stdout.isTTY;
  if (idCmds.includes(opts.cmd) && !/^\d+$/.test(opts.id || '')) {
    if (opts.id == null && canAsk) opts.pickTask = true;
    else die(`usage: st-tasks ${opts.cmd} <id>${opts.cmd === 'comment' ? ' "text"' : spec?.user === 'required' ? ' <user>' : spec?.user ? ' [user]' : ''}`);
  }
  if (opts.cmd === 'comment' && !opts.message) {
    if (canAsk) opts.askMessage = true;
    else die('usage: st-tasks comment <id> "text"');
  }
  if (spec?.user === 'required' && !opts.who) {
    // On a terminal, pick the person once the task has been checked; otherwise there is nobody to ask.
    if (!canAsk) die(`usage: st-tasks ${opts.cmd} <id> <user>`);
    opts.askWho = true;
  }
  if (spec && !spec.user && opts.who) die(`unknown argument: ${opts.who[0]}`);
  if (opts.cmd === 'log' && opts.id && !opts.duration) {
    if (canAsk) opts.askLog = true;
    else die('usage: st-tasks log <id> <duration> ["note"] [date]   e.g. st-tasks log 123 1h30m "fixed the bug"');
  }
  if (opts.interactive) {
    if (opts.cmd !== 'list' || opts.json || opts.text || opts.miss || opts.all || opts.project || opts.status) die('interactive mode (-i) does not combine with a command or other options');
    if (!canAsk) die('interactive mode needs a terminal');
    opts.cmd = 'interactive';
  }
  return opts;
}

async function fetchAssigned(includeClosed) {
  const filters = [{ assignee: { operator: '=', values: ['me'] } }];
  if (!includeClosed) filters.push({ status: { operator: 'o', values: [] } });
  const sortBy = [['updatedAt', 'desc']];
  const items = [];
  for (let offset = 1; ; offset++) {
    const page = await api('/work_packages', { filters, sortBy, pageSize: '100', offset: String(offset) });
    items.push(...page._embedded.elements);
    if (items.length >= page.total || page._embedded.elements.length === 0) break;
  }
  return items.map((w) => ({
    id: w.id,
    project: cell(w._links.project?.title),
    subject: cell(w.subject),
    type: cell(w._links.type?.title),
    status: cell(w._links.status?.title),
    priority: cell(w._links.priority?.title),
    dueDate: w.dueDate,
    updatedAt: w.updatedAt,
    url: `${BASE}/work_packages/${w.id}`,
  }));
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

// Local "YYYY-MM-DD HH:MM".
function stamp(iso) {
  const d = new Date(iso), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function rel(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d ago`;
  if (s < 86400 * 365) return `${Math.round(s / (86400 * 30))}mo ago`;
  return `${(s / (86400 * 365)).toFixed(1).replace(/\.0$/, '')}y ago`;
}

const statusColor = (s) => (/progress/i.test(s) ? yellow : /hold|block/i.test(s) ? magenta : /closed|done|resolved|rejected/i.test(s) ? dim : /new|open/i.test(s) ? cyan : (x) => x);
const priorityColor = (p) => (/immediate|urgent/i.test(p) ? (x) => bold(red(x)) : /high/i.test(p) ? red : /low/i.test(p) ? dim : (x) => x);

function dueLabel(d) {
  if (!d) return '';
  const days = Math.round((new Date(d) - new Date(new Date().toISOString().slice(0, 10))) / 86400000);
  if (days < 0) return red(`${d} (overdue)`);
  if (days <= 2) return yellow(`${d} (${days === 0 ? 'today' : days + 'd'})`);
  return d;
}

// Visible text of a string: SGR colors and OSC 8 links removed (for width measuring).
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '');

// Bordered table. Empty columns are dropped; Subject/Comments shrink to fit the terminal.
function table(rows, cols) {
  const strip = stripAnsi;
  cols = cols.filter((col) => col.title || rows.some((r) => strip(col.get(r))));
  // Don't truncate when piped, so other tools get full subjects.
  const width = process.stdout.columns || Number(process.env.COLUMNS) || Infinity;
  const w = cols.map((col) => Math.max(col.title.length, ...rows.map((r) => strip(col.get(r)).length)));
  const shrinkable = cols.map((col, i) => (['Subject', 'Comments'].includes(col.title) ? i : -1)).filter((i) => i >= 0);
  let over = w.reduce((a, b) => a + b, 0) + 3 * cols.length + 1 - width;
  while (over > 0 && shrinkable.length) {
    const i = shrinkable.reduce((m, j) => (w[j] > w[m] ? j : m));
    if (w[i] <= 20) break;
    w[i]--;
    over--;
  }
  const fit = (s, n) => {
    const plain = strip(s);
    if (plain.length <= n) return s + ' '.repeat(n - plain.length);
    return plain.slice(0, n - 1) + '…';
  };
  const line = (l, m, r) => dim(l + w.map((n) => '─'.repeat(n + 2)).join(m) + r);
  const row = (cells) => dim('│') + ' ' + cells.map((cell, i) => fit(cell, w[i])).join(' ' + dim('│') + ' ') + ' ' + dim('│');
  console.log(line('╭', '┬', '╮'));
  console.log(row(cols.map((col) => bold(col.title))));
  console.log(line('├', '┼', '┤'));
  for (const r of rows) console.log(row(cols.map((col) => col.get(r))));
  console.log(line('╰', '┴', '╯'));
}

// ---- Interactive widgets ----
// `select` is split into a pure core (selectState/selectKey/selectLines: no I/O, testable by
// slicing this section out of the file) and a thin raw-mode wrapper. `input` wraps promptLine.
// Everything here is terminal-only; callers gate on `canAsk` (stdin and stdout TTY).

// Items whose label+hint contain every word of the filter (case-insensitive), matchName-style.
function filterItems(items, filter) {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((it) => words.every((w) => (it.label + ' ' + (it.hint || '')).toLowerCase().includes(w)));
}

function selectState(items, decorate) {
  return { items, decorate, filter: '', filtered: items, index: 0 };
}

function filterSelect(state, filter) {
  let filtered = filterItems(state.items, filter);
  if (state.decorate) filtered = state.decorate(filter, filtered) || filtered;
  return { ...state, filter, filtered, index: Math.min(state.index, Math.max(filtered.length - 1, 0)) };
}

// One keypress on a select state. Returns the next state, { done: value } or { cancelled: true }.
function selectKey(state, key) {
  if (!key || !key.name) return state;
  if (key.name === 'up' || (key.ctrl && key.name === 'p')) return { ...state, index: Math.max(state.index - 1, 0) };
  if (key.name === 'down' || (key.ctrl && key.name === 'n')) return { ...state, index: Math.min(state.index + 1, Math.max(state.filtered.length - 1, 0)) };
  if (key.name === 'return') return state.filtered.length ? { done: state.filtered[Math.min(state.index, state.filtered.length - 1)].value } : state;
  if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return { cancelled: true };
  if (key.name === 'backspace') return filterSelect(state, state.filter.slice(0, -1));
  if (key.ctrl && key.name === 'u') return filterSelect(state, '');
  if (!key.ctrl && !key.meta && key.sequence && key.sequence.length === 1 && key.sequence >= ' ') return filterSelect(state, state.filter + key.sequence);
  return state;
}

// The widget as lines of text: a header with the filter, then up to `height` windowed rows.
function selectLines(state, { title, cols = Infinity, height = 10 } = {}) {
  let head = bold(title) + (state.filter ? '  ' + cyan(state.filter) : dim('  (type to filter, ↑/↓, enter, esc)'));
  if (stripAnsi(head).length > cols) head = stripAnsi(head).slice(0, Math.max(0, cols - 1)) + '…';
  const lines = [head];
  const list = state.filtered;
  const start = Math.max(0, Math.min(state.index - (height >> 1), list.length - height));
  for (let i = start; i < Math.min(start + height, list.length); i++) {
    const it = list[i], on = i === state.index;
    let label = it.label;
    const hint = it.hint ? '  ' + it.hint : '';
    const room = cols - 2 - stripAnsi(hint).length;
    if (stripAnsi(label).length > room) label = stripAnsi(label).slice(0, Math.max(0, room - 1)) + '…';
    lines.push((on ? cyan('❯') : ' ') + ' ' + (on ? bold(label) : label) + dim(hint));
  }
  if (!list.length) lines.push(dim('  no matches'));
  return lines;
}

// Arrow-key picker on raw stdin. Returns the picked item's value, or null when cancelled.
// `decorate(filter, filtered)` may swap in synthetic rows (e.g. "use task #123 anyway").
function select({ title, items, decorate }) {
  if (!process.stdin.isTTY || !items.length) return Promise.resolve(null);
  let state = selectState(items, decorate);
  const stdin = process.stdin, stdout = process.stdout;
  emitKeypressEvents(stdin);
  let drawn = 0, done = false;
  const draw = () => {
    const lines = selectLines(state, { title, cols: stdout.columns || 80 });
    stdout.write((drawn ? `\x1b[${drawn}F` : '') + lines.map((l) => '\x1b[2K' + l).join('\n') + '\n\x1b[J');
    drawn = lines.length;
  };
  return new Promise((resolve) => {
    const showCursor = () => stdout.write('\x1b[?25h');
    const finish = (value, label) => {
      if (done) return;
      done = true;
      stdin.removeListener('keypress', onKey);
      stdout.removeListener('resize', draw);
      process.removeListener('exit', showCursor);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write(`\x1b[${drawn}F\x1b[J\x1b[?25h`); // erase the widget, keep an echo of the choice
      if (label !== undefined) console.log(green('✔') + ' ' + title + ': ' + bold(label));
      resolve(value);
    };
    const onKey = (str, key = {}) => {
      const r = selectKey(state, key);
      if (r.cancelled) finish(null);
      else if (Object.hasOwn(r, 'done')) finish(r.done, state.filtered.find((it) => it.value === r.done)?.label);
      else { state = r; draw(); }
    };
    stdout.write('\x1b[?25l');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKey);
    stdout.on('resize', draw);
    process.once('exit', showCursor);
    draw();
  });
}

// One line of input with an optional default and validation. Null when cancelled (Ctrl-C/Ctrl-D).
async function input({ question, def, validate }) {
  for (;;) {
    const ans = await promptLine(question + (def ? dim(` [${def}]`) : '') + ' ');
    if (ans === undefined) return null;
    const v = ans.trim() || def || '';
    if (!validate) return v;
    const err = validate(v);
    if (err === true) return v;
    console.log(red('✗ ' + err));
  }
}

// Pick one of my tasks. `includeClosed` for `st open`, which usually targets a closed task.
function pickTask(tasks, title) {
  return select({
    title,
    items: tasks.map((t) => ({ label: `${t.flag ? t.flag + ' ' : ''}#${t.id}  ${t.subject}`, hint: `${t.project} · ${statusColor(t.status)(t.status)}`, value: String(t.id) })),
    // Escape hatch for a task not in the list (not assigned to me): digits that match nothing.
    decorate: (filter, filtered) => (filtered.length || !/^\d+$/.test(filter.trim()) ? filtered : [{ label: `Use task #${filter.trim()}`, hint: 'not in this list', value: filter.trim() }]),
  });
}

async function taskPicker({ includeClosed = false } = {}) {
  loader.start('Fetching your tasks…');
  const tasks = await fetchAssigned(includeClosed);
  loader.stop();
  if (!tasks.length) die('No tasks to pick from.');
  const id = await pickTask(tasks, 'Task');
  if (id === null) die('Cancelled. Nothing was changed.');
  return id;
}

// Pick the person to assign to from the project's roster.
async function personPicker(project, id) {
  loader.start('Fetching people…');
  const people = await fetchAssignees(project, id);
  loader.stop();
  const u = await select({ title: `Assign #${id} to`, items: people.map((p) => ({ label: cell(p.name), value: p })) });
  if (!u) cancel('Cancelled. Nothing was changed.');
  return u;
}

// `st log <id>` without a duration: ask for the time, date, note and activity instead.
async function logWizard(opts) {
  const duration = await input({ question: `Time on #${opts.id} (${DURATION_HELP}):`, validate: (v) => (durationOf(v) ? true : `use ${DURATION_HELP}`) });
  if (!duration) cancel('Cancelled. Nothing was logged.');
  const date = await input({ question: 'Date:', def: 'today', validate: (v) => (isDate(v) ? true : 'use today, yesterday, -N (days ago) or YYYY-MM-DD') });
  if (date === null) cancel('Cancelled. Nothing was logged.');
  const note = await input({ question: 'Note (optional):' });
  if (note === null) cancel('Cancelled. Nothing was logged.');
  loader.start('Checking your usual activity…');
  const me = await api('/users/me');
  const def = await defaultActivity(me.id);
  loader.stop();
  const activity = await select({
    title: 'Activity',
    items: ACTIVITIES.map(([id, name]) => ({ label: name, hint: activityHref(id) === def ? 'your latest' : '', value: name }))
      .sort((a, b) => (a.hint ? -1 : b.hint ? 1 : 0)),
  });
  if (!activity) cancel('Cancelled. Nothing was logged.');
  opts.duration = duration;
  opts.date = date === 'today' ? undefined : date;
  if (note) opts.noteWords = [note];
  opts.as = activity; // an exact ACTIVITIES name, resolved by activityByName() in logTime()
}
// ---- End of interactive widgets ----

// NEW/UPD flags against the last-check snapshot `prev` (null on the first run).
function flagTasks(tasks, prev, all) {
  const seen = prev?.tasks || {};
  // The snapshot only holds open tasks, so flags are meaningless for --all.
  for (const t of tasks) t.flag = !prev || all ? '' : !(t.id in seen) ? 'NEW' : seen[t.id] !== t.updatedAt ? 'UPD' : '';
}

function saveSnapshot(tasks) {
  writeFileSync(STATE_FILE, JSON.stringify({ checkedAt: new Date().toISOString(), tasks: Object.fromEntries(tasks.map((t) => [t.id, t.updatedAt])) }, null, 2));
}

async function list(opts) {
  loader.start('Fetching your tasks…');
  let tasks = await fetchAssigned(opts.all);
  loader.stop();
  if (opts.project) tasks = tasks.filter((t) => t.project.toLowerCase().includes(opts.project.toLowerCase()));
  if (opts.status) tasks = tasks.filter((t) => t.status.toLowerCase().includes(opts.status.toLowerCase()));

  const prev = loadState();
  flagTasks(tasks, prev, opts.all);
  // Only an unfiltered view of open tasks updates the "last checked" snapshot.
  if (!opts.all && !opts.project && !opts.status) saveSnapshot(tasks);

  if (opts.json) return console.log(JSON.stringify(tasks, null, 2));

  if (!tasks.length) return console.log(green('No matching tasks assigned to you.'));

  // Summary, e.g. "You have 11 open tasks: 7 Open, 3 In progress and 1 On hold."
  const counts = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  const parts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([st, n]) => `${bold(n)} ${statusColor(st)(st)}`);
  const joined = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts.at(-1) : parts[0];
  const scope = [opts.project && `in projects matching "${opts.project}"`, opts.status && `with status matching "${opts.status}"`].filter(Boolean).join(' ');
  const noun = `${opts.all ? '' : 'open '}task${tasks.length === 1 ? '' : 's'}`;
  console.log(`You have ${bold(tasks.length)} ${noun}${scope ? ' ' + scope : ''}: ${joined}.`);
  const flagged = tasks.filter((t) => t.flag).length;
  if (prev && !opts.all) console.log(dim(`Last checked ${rel(prev.checkedAt)}`) + (flagged ? dim(' · ') + yellow(`${flagged} new or updated since then`) : dim(' · nothing new since then')));
  console.log();

  table(tasks, [
    { title: '', get: (t) => (t.flag === 'NEW' ? green('NEW') : t.flag === 'UPD' ? yellow('UPD') : '') },
    { title: 'ID', get: (t) => wpLink(t.id) },
    { title: 'Project', get: (t) => t.project },
    { title: 'Subject', get: (t) => t.subject },
    { title: 'Status', get: (t) => statusColor(t.status)(t.status) },
    { title: 'Priority', get: (t) => priorityColor(t.priority)(t.priority) },
    { title: 'Last updated', get: (t) => stamp(t.updatedAt) + ' ' + dim(`(${rel(t.updatedAt)})`) },
    { title: 'Log', get: (t) => link(`${t.url}/time_entries/new`, green('+ Log')) },
  ]);
}

// Local date as YYYY-MM-DD, `offset` days from today.
function isoDate(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDate(arg) {
  if (!arg || arg === 'today') return isoDate(0);
  if (arg === 'yesterday') return isoDate(-1);
  if (/^-\d+$/.test(arg)) return isoDate(Number(arg)); // e.g. -2 = two days ago
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg) && !isNaN(new Date(arg))) return arg;
  die(`invalid date "${arg}" — use today, yesterday, -N (days ago) or YYYY-MM-DD`);
}

// ISO 8601 duration ("PT1H30M", "PT0.5H", "P1DT2H") -> hours.
function hoursOf(dur) {
  const m = /^P(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(dur || '');
  if (!m) return 0;
  const [, d = 0, h = 0, mi = 0, se = 0] = m;
  return d * 24 + Number(h) + mi / 60 + se / 3600;
}

function fmtHours(h) {
  const mins = Math.round(h * 60);
  const hh = Math.floor(mins / 60), mm = mins % 60;
  return hh && mm ? `${hh}h ${mm}m` : hh ? `${hh}h` : `${mm}m`;
}

// Tasks where I commented or changed the status on `date` (local day), whoever they're assigned to.
// Cache of my activities per task, keyed by the task's updatedAt (any new activity changes it), so
// tasks that haven't changed since the last run need no request, for any date.
function loadCache(meId) {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (c.base === BASE && c.meId === meId && c.tasks) return c;
  } catch {}
  return { base: BASE, meId, tasks: {} };
}

// Tasks where I commented or changed the status on `date` (local day), whoever they're assigned to.
// Tasks in `skipIds` (already have time logged that day) are not checked.
async function fetchTouched(date, meId, skipIds = new Set()) {
  loader.set(`Finding tasks updated since ${date}…`);
  const start = new Date(date + 'T00:00:00'), end = new Date(start);
  end.setDate(end.getDate() + 1);
  // Updated from the start of that day until now: a task I commented on that day may have changed since.
  const all = [];
  for (let offset = 1; ; offset++) {
    const page = await api('/work_packages', {
      filters: [{ updatedAt: { operator: '<>d', values: [start.toISOString(), new Date().toISOString()] } }],
      pageSize: '100',
      offset: String(offset),
    });
    all.push(...page._embedded.elements);
    if (all.length >= page.total || page._embedded.elements.length === 0) break;
  }
  const tasks = all.filter((w) => !skipIds.has(w.id));

  const cache = loadCache(meId), mine = `/users/${meId}`, now = Date.now();
  const todo = tasks.filter((w) => cache.tasks[w.id]?.updatedAt !== w.updatedAt);
  const cached = tasks.length - todo.length;
  let done = 0;
  loader.progress(0, todo.length, `Reading task activity${cached ? ` (${cached} cached)` : ''}`);
  // A few activity requests at a time, so a busy day doesn't open dozens of connections.
  for (let i = 0; i < todo.length; i += 12) {
    await Promise.all(todo.slice(i, i + 12).map(async (w) => {
      const acts = (await api(`/work_packages/${w.id}/activities`))._embedded.elements;
      loader.progress(++done, todo.length);
      const found = [];
      for (const a of acts) {
        if (!a._links.user?.href?.endsWith(mine)) continue;
        const actions = new Set();
        if (a.comment?.raw?.trim()) actions.add('Commented');
        for (const d of a.details || []) {
          const m = /^Status changed from .*?\s*\nto (.+)$/s.exec(d.raw || '');
          if (m) actions.add(`Status → ${cell(m[1])}`);
        }
        if (actions.size) found.push({ at: a.createdAt, actions: [...actions] });
      }
      cache.tasks[w.id] = { updatedAt: w.updatedAt, seen: now, mine: found };
    }));
  }
  if (todo.length) {
    // Keep the file small: forget tasks not seen for 60 days.
    for (const [id, t] of Object.entries(cache.tasks)) if (now - t.seen > 60 * 86400000) delete cache.tasks[id];
    try { writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch {}
  }

  const touched = [];
  for (const w of tasks) {
    const actions = new Set();
    for (const a of cache.tasks[w.id].mine) {
      const at = new Date(a.at);
      if (at >= start && at < end) a.actions.forEach((x) => actions.add(x));
    }
    if (actions.size) touched.push({ id: w.id, project: cell(w._links.project?.title), subject: cell(w.subject), actions: [...actions] });
  }
  return touched.sort((a, b) => b.id - a.id);
}

// My time entries on `date`.
async function fetchEntries(meId, date, init) {
  const entries = [];
  for (let offset = 1; ; offset++) {
    const page = await api('/time_entries', {
      filters: [{ user: { operator: '=', values: [String(meId)] } }, { spent_on: { operator: '=d', values: [date] } }],
      pageSize: '100',
      offset: String(offset),
    }, init);
    entries.push(...page._embedded.elements);
    if (entries.length >= page.total || page._embedded.elements.length === 0) break;
  }
  return entries;
}

async function worklog(opts) {
  const date = parseDate(opts.date);
  const activity = opts.as && activityByName(opts.as);
  loader.start(`Fetching time entries for ${date}…`);
  const me = await api('/users/me');
  const entries = await fetchEntries(me.id, date);

  // Group entries by task, most time first.
  const byTask = new Map();
  for (const e of entries) {
    const wp = e._links.workPackage;
    const key = wp?.href ?? 'none';
    if (!byTask.has(key)) {
      byTask.set(key, {
        id: wp?.href ? Number(wp.href.split('/').pop()) : null,
        project: cell(e._links.project?.title),
        subject: wp?.title ? cell(wp.title) : '(no task)',
        activities: new Set(),
        comments: [],
        entries: 0,
        hours: 0,
      });
    }
    const t = byTask.get(key);
    t.hours += hoursOf(e.hours);
    t.entries++;
    if (e._links.activity?.title) t.activities.add(cell(e._links.activity.title));
    const comment = cell(typeof e.comment === 'string' ? e.comment : e.comment?.raw);
    if (comment) t.comments.push(comment);
  }
  const tasks = [...byTask.values()].sort((a, b) => b.hours - a.hours);
  const total = tasks.reduce((sum, t) => sum + t.hours, 0);

  // Plain list for pasting into a status update.
  if (opts.text) {
    loader.stop();
    if (!tasks.length) return console.log(`No time logged on ${date}.`);
    return console.log('Working on:\n\n' + tasks.map((t) => `- ${t.id ? `Task #${t.id}: ` : ''}${t.subject}`).join('\n'));
  }

  // Slow (one request per task updated that day), so only on request.
  const missing = opts.miss ? await fetchTouched(date, me.id, new Set(tasks.map((t) => t.id))) : [];
  loader.stop();

  if (opts.json) return console.log(JSON.stringify({ date, totalHours: total, tasks: tasks.map((t) => ({ ...t, activities: [...t.activities] })), ...(opts.miss && { missingLogTime: missing }) }, null, 2));

  const day = new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const when = date === isoDate(0) ? `today (${day})` : date === isoDate(-1) ? `yesterday (${day})` : `on ${day}`;
  if (opts.miss) {
    if (!missing.length) return console.log(green(`No tasks with activity but no time logged ${when}.`));
  } else if (!entries.length) console.log(`You haven't logged any time ${when}.`);
  else {
    console.log(
      `You logged ${bold(fmtHours(total))} ${when} across ${bold(tasks.length)} task${tasks.length === 1 ? '' : 's'}` +
        dim(` (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`) + '.\n',
    );
    table(tasks, [
      { title: 'Time', get: (t) => bold(fmtHours(t.hours)) },
      { title: 'ID', get: (t) => (t.id ? wpLink(t.id) : '') },
      { title: 'Project', get: (t) => t.project },
      { title: 'Subject', get: (t) => t.subject },
      { title: 'Entries', get: (t) => t.entries },
      { title: 'Comments', get: (t) => dim(t.comments.join('; ')) },
    ]);
  }

  if (missing.length) {
    console.log(`${yellow(`${missing.length} task${missing.length === 1 ? '' : 's'} with activity but no time logged ${when}:`)}\n`);
    table(missing, [
      { title: 'ID', get: (t) => wpLink(t.id) },
      { title: 'Project', get: (t) => t.project },
      { title: 'Subject', get: (t) => t.subject },
      { title: 'Activity', get: (t) => t.actions.join(', ') },
      { title: 'Log', get: (t) => link(`${BASE}/work_packages/${t.id}/time_entries/new`, green('+ Log')) },
    ]);
    if (process.stdin.isTTY && process.stdout.isTTY) await offerLogging(missing, date, me.id, activity);
  }
}

const decode = (s) => safe(s).replace(/&nbsp;|\u00a0/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const userNames = new Map();
async function userName(href) {
  if (!href) return '?';
  if (!userNames.has(href)) userNames.set(href, api(href.replace(/^\/api\/v3/, '')).then((u) => cell(u.name) || '?', () => '?'));
  return userNames.get(href);
}

async function show(id) {
  loader.start(`Fetching task #${id}…`);
  const w = await api(`/work_packages/${id}`);
  const acts = await api(`/work_packages/${id}/activities`);
  loader.stop();
  const L = w._links;
  const t = (k) => cell(L[k]?.title) || '-';
  console.log(bold(wpLink(w.id) + ' ' + cell(w.subject)));
  console.log(`${dim('Project:')}  ${t('project')}    ${dim('Type:')} ${t('type')}    ${dim('Status:')} ${statusColor(t('status'))(t('status'))}    ${dim('Priority:')} ${t('priority')}`);
  console.log(`${dim('Assignee:')} ${t('assignee')}    ${dim('Author:')} ${t('author')}    ${dim('Due:')} ${dueLabel(w.dueDate) || '-'}    ${dim('Last updated:')} ${stamp(w.updatedAt)} ${dim(`(${rel(w.updatedAt)})`)}`);
  console.log(dim(`${BASE}/work_packages/${w.id}`));
  const desc = w.description?.raw?.trim();
  if (desc) console.log('\n' + bold('Description') + '\n' + decode(desc));
  const comments = acts._embedded.elements.filter((a) => a.comment?.raw?.trim()).slice(-5);
  if (comments.length) {
    console.log('\n' + bold(`Recent comments (${comments.length})`));
    const names = await Promise.all(comments.map((a) => (a._links.user?.title ? cell(a._links.user.title) : userName(a._links.user?.href))));
    comments.forEach((a, i) => console.log(`\n${cyan(names[i])} ${dim(rel(a.createdAt))}\n${decode(a.comment.raw).trim()}`));
  }
}

// ---- Writing: time entries, comments, status changes ----

// Time entry activities on this OpenProject (ids come from the "Log time" form).
const ACTIVITIES = [[1, 'Project Management'], [3, 'Developer'], [29, 'Senior Developer'], [19, 'QA'], [30, 'Design / Wireframe'], [6, 'Other']];
const activityHref = (id) => `/api/v3/time_entries/activities/${id}`;
const DURATION_HELP = 'up to 8h and minutes of 15m, 30m or 45m, e.g. 1h, 45m, 2h15m';

// Items whose name matches `query`: an exact name wins, otherwise every word of the query must appear in it.
function matchName(items, query, nameOf) {
  const q = query.toLowerCase().trim();
  const exact = items.filter((x) => nameOf(x).toLowerCase() === q);
  if (exact.length) return exact;
  const words = q.split(/\s+/);
  return items.filter((x) => words.every((w) => nameOf(x).toLowerCase().includes(w)));
}

function activityByName(name) {
  const hits = matchName(ACTIVITIES, name, (a) => a[1]);
  if (hits.length === 1) return activityHref(hits[0][0]);
  die(`${hits.length ? `"${name}" matches ${hits.map((a) => a[1]).join(', ')}` : `unknown activity "${name}"`} — choose one of: ${ACTIVITIES.map((a) => a[1]).join(', ')}`);
}

function parseDuration(s) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/i.exec(s || '');
  return s && m ? { h: Number(m[1] || 0), m: Number(m[2] || 0) } : null;
}

// Only what the Log time form offers: up to 8h plus 0/15/30/45 minutes. Returns null when invalid.
function durationOf(s) {
  const d = parseDuration(s);
  if (!d || d.h > 8 || ![0, 15, 30, 45].includes(d.m) || (d.h === 8 && d.m > 45) || d.h + d.m === 0) return null;
  return { iso: 'PT' + (d.h ? `${d.h}H` : '') + (d.m ? `${d.m}M` : ''), hours: d.h + d.m / 60 };
}

// The activity on my latest time entry (it follows the role), else Developer.
async function defaultActivity(meId) {
  let page;
  try {
    page = await api('/time_entries', { filters: [{ user: { operator: '=', values: [String(meId)] } }], sortBy: [['spentOn', 'desc']], pageSize: '1' }, { soft: true });
  } catch (e) {
    loader.stop();
    console.error(yellow('warning: ') + `couldn't read your latest activity (${e.message}); using Developer. Pick another with --as.`);
    return activityHref(3);
  }
  return page._embedded?.elements?.[0]?._links?.activity?.href || activityHref(3);
}

const activityName = (href) => ACTIVITIES.find(([id]) => activityHref(id) === href)?.[1] || 'activity ' + href.split('/').pop();

function createEntry({ id, dur, date, note, activity, soft }) {
  return api('/time_entries', {}, {
    soft,
    method: 'POST',
    body: {
      _links: { workPackage: { href: `/api/v3/work_packages/${id}` }, activity: { href: activity } },
      hours: dur.iso,
      spentOn: date,
      ...(note && { comment: note }), // plain text on this server (a {raw} object is stored literally)
    },
  });
}

async function logTime(opts) {
  const dur = durationOf(opts.duration) || die(`invalid duration "${opts.duration}" — use ${DURATION_HELP}`);
  const date = parseDate(opts.date), note = (opts.noteWords || []).join(' ');
  let activity = opts.as && activityByName(opts.as);
  loader.start(`Logging time on task #${opts.id}…`);
  const me = await api('/users/me');
  activity ||= await defaultActivity(me.id);
  const e = await createEntry({ id: opts.id, dur, date, note, activity });
  loader.stop();
  const title = cell(e._links.workPackage?.title), act = cell(e._links.activity?.title);
  console.log(`${green('Logged')} ${bold(fmtHours(dur.hours))} on ${wpLink(opts.id)}${title ? ' ' + title : ''} ${dim(`(${date}${act ? ', ' + act : ''}) · entry #${e.id}`)}`);
  // The entry exists by now, so a failed total must not look like a failed command (a retry would log twice).
  try {
    const total = (await fetchEntries(me.id, date, { soft: true })).reduce((sum, x) => sum + hoursOf(x.hours), 0);
    console.log(`Total ${date === isoDate(0) ? 'today' : 'on ' + date}: ${bold(fmtHours(total))}`);
  } catch (err) {
    console.error(yellow('warning: ') + `the entry was saved, but the total for ${date} couldn't be fetched (${err.message})`);
  }
}

// After `st log --miss`: ask for a duration for each task without time, e.g. "1h" or "45m fixed the menu".
async function offerLogging(missing, date, meId, activity) {
  activity ||= await defaultActivity(meId);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  const closedP = new Promise((resolve) => rl.once('close', () => { closed = true; resolve(null); }));
  rl.on('SIGINT', () => rl.close());
  // null once the prompt is closed (Ctrl-C, Ctrl-D, input ended); asking a closed prompt would throw.
  const ask = async (q) => {
    if (closed) return null;
    try { return await Promise.race([rl.question(q), closedP]); } catch { return null; }
  };
  console.log(dim(`\nLog time on ${date} as ${activityName(activity)} now? Type a duration (up to 8h, minutes 15m, 30m or 45m: 1h, 45m, 2h15m), optionally followed by a note. Enter skips, q stops.`));
  let logged = 0, count = 0;
  const unsure = [];
  const done = (dur) => { logged += dur.hours; count++; };
  try {
    tasks: for (const t of missing) {
      console.log(`\n${wpLink(t.id)} ${t.subject} ${dim('· ' + t.actions.join(', '))}`);
      for (;;) {
        const line = await ask('  time › ');
        if (line === null || /^q(uit)?$/i.test(line.trim())) break tasks;
        const [first, ...rest] = line.trim().split(/\s+/);
        if (!first) break;
        const dur = durationOf(first);
        if (!dur) { console.log(red('  ✗ ') + `use ${DURATION_HELP}`); continue; }
        try {
          const e = await createEntry({ id: t.id, dur, date, note: rest.join(' '), activity, soft: true });
          console.log(green('  ✓ ') + `Logged ${bold(fmtHours(dur.hours))} ${dim(`· ${cell(e._links.activity?.title) || activityName(activity)} · entry #${e.id}`)}`);
          done(dur);
        } catch (err) {
          if (!err.ambiguous) { console.log(red('  ✗ ') + err.message); continue; }
          // The request may have gone through. Look before offering a retry, so nothing is logged twice
          // (these tasks had no time that day, so any entry on one is the one we just sent).
          let saved = null;
          try { saved = (await fetchEntries(meId, date, { soft: true })).some((x) => x._links.workPackage?.href?.endsWith('/' + t.id)); } catch {}
          if (saved) { console.log(green('  ✓ ') + `Logged ${bold(fmtHours(dur.hours))} ${dim('· saved despite a connection error')}`); done(dur); }
          else if (saved === null) { console.log(yellow('  ? ') + "Couldn't tell whether it was saved. Check before logging it again."); unsure.push(t.id); }
          else { console.log(red('  ✗ ') + 'Not saved (connection problem). Try again, or press Enter to skip.'); continue; }
        }
        break;
      }
    }
  } finally {
    rl.close();
    console.log(count ? `\nLogged ${bold(fmtHours(logged))} across ${count} task${count === 1 ? '' : 's'}.` : '\nNothing logged.');
    if (unsure.length) console.log(yellow(`Not sure these were saved: ${unsure.map((id) => '#' + id).join(', ')}. Check with: st log ${date}`));
  }
}

async function comment(id, text) {
  loader.start(`Posting comment on task #${id}…`);
  const a = await api(`/work_packages/${id}/activities`, {}, { method: 'POST', body: { comment: { raw: text } } });
  loader.stop();
  console.log(`${green('Comment')} ${link(`${BASE}/work_packages/${id}/activity#activity-${a.version}`, cyan('#' + a.id))} added to task ${wpLink(id)}`);
}

// Ask one question on a terminal. Resolves undefined when the prompt is cancelled (Ctrl-C, Ctrl-D).
async function promptLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise((resolve) => rl.once('close', () => resolve(undefined)));
  rl.on('SIGINT', () => rl.close());
  try {
    return await Promise.race([rl.question(question), closed]);
  } catch {
    return undefined;
  } finally {
    rl.close();
  }
}

// Everyone a task in this project can be assigned to (paged).
async function fetchAssignees(project, id) {
  const people = [];
  for (let offset = 1; ; offset++) {
    const page = await api(project.replace(/^\/api\/v3/, '') + '/available_assignees', { pageSize: '100', offset: String(offset) }, { soft: true })
      .catch((e) => die(`Can't list the people task #${id} can be assigned to: ${e.message}`));
    people.push(...page._embedded.elements);
    if (people.length >= page.total || page._embedded.elements.length === 0) break;
  }
  return people;
}

async function changeStatus(opts) {
  const spec = STATUS_CMDS[opts.cmd], id = opts.id;
  loader.start(`Updating task #${id}…`);
  const w = await api(`/work_packages/${id}`);
  const from = cell(w._links.status?.title);
  if (!opts.force && spec.from && !spec.from.some((s) => s.toLowerCase() === from.toLowerCase())) {
    die(`Task #${id} is "${from}", and ${opts.cmd} only applies to ${spec.from.join(' or ')} tasks.${inSession ? '' : ' Add --force to change it anyway.'}`);
  }
  const target = spec.to && (await api('/statuses'))._embedded.elements.find((s) => s.name.toLowerCase() === spec.to.toLowerCase());
  if (spec.to && !target) die(`This OpenProject has no "${spec.to}" status.`);

  if (opts.askWho) {
    // After the status guard, so a refused task never asks. The picker sets the user directly.
    loader.stop();
    const project = w._links.project?.href || die(`Task #${id} has no project, so there is nobody to assign it to.`);
    opts.whoUser = await personPicker(project, id);
    loader.start(`Updating task #${id}…`);
  }

  let who = null;
  if (opts.whoUser) who = opts.whoUser;
  else if (opts.who) {
    const query = opts.who.join(' '), project = w._links.project?.href;
    if (!project) die(`Task #${id} has no project, so there is nobody to assign it to.`);
    const people = await fetchAssignees(project, id);
    const hits = matchName(people, query, (u) => cell(u.name));
    if (!hits.length) die(`Nobody who can be assigned to task #${id} matches "${query}".`);
    if (hits.length > 1) die(`"${query}" matches ${hits.length} people: ${hits.slice(0, 8).map((u) => cell(u.name)).join(', ')}${hits.length > 8 ? ', …' : ''}. Be more specific.`);
    who = hits[0];
  } else if (spec.takeOver && opts.force) who = await api('/users/me'); // taking a task back

  await api(`/work_packages/${id}`, {}, {
    method: 'PATCH',
    body: { lockVersion: w.lockVersion, _links: { ...(target && { status: { href: target._links.self.href } }), ...(who && { assignee: { href: who._links.self.href } }) } },
  });
  loader.stop();
  const to = target ? cell(target.name) : from;
  const assigned = who ? `assigned to ${bold(cell(who.name))}` : '';
  console.log(`${wpLink(id)} ${target ? `${statusColor(from)(from)} → ${statusColor(to)(to)}${assigned ? ', ' : ''}` : `${statusColor(from)(from)}, `}${assigned}`);
}

// ---- `st -i`: interactive mode ----

// The action menu for one task. A failure prints inline and returns to the menu instead of ending
// the session (see `inSession`). Esc at the menu goes back to the list.
async function interactiveTask(id, subject) {
  const actions = [
    { label: 'Show details', value: 'show' },
    { label: 'Log time', value: 'log' },
    { label: 'Comment', value: 'comment' },
    ...Object.entries(STATUS_CMDS).map(([cmd, spec]) => ({
      label: cmd.replace(/_/g, ' '),
      hint: spec.to ? `→ ${spec.to}` + (spec.user ? ', assign' : '') : 'assign only',
      value: cmd,
    })),
  ];
  for (;;) {
    const action = await select({ title: `#${id}${subject ? '  ' + subject : ''}`, items: actions });
    if (action === null) return; // Esc: back to the task list
    let o;
    try {
      if (action === 'show') {
        await show(id);
        await input({ question: dim('(enter to continue)') });
      } else if (action === 'log') {
        o = { cmd: 'log', id };
        await logWizard(o);
        await logTime(o);
      } else if (action === 'comment') {
        const text = await input({ question: `Comment on #${id}:` });
        if (text) await comment(id, text);
      } else {
        // changeStatus() asks for the person itself, after its status guard, so a refused task never asks.
        await changeStatus({ cmd: action, id, askWho: STATUS_CMDS[action].user === 'required' });
        console.log();
        return; // status changed: back to a freshly fetched task list
      }
    } catch (e) {
      loader.stop();
      if (!e.cancelled) console.error(red('error: ') + e.message);
      // A timed-out or 5xx write may have been applied: show what is there before anyone retries.
      if (e.ambiguous && action === 'log') {
        try { await worklog({ date: o.date }); } catch (err) { console.error(yellow('warning: ') + `couldn't re-read the day's entries (${err.message})`); }
      } else if (e.ambiguous) console.error(yellow('warning: ') + `check task #${id} (Show details) before trying again`);
    }
    console.log();
  }
}

// Pick a task, act on it, repeat. Esc at the task list ends the session.
async function interactive() {
  inSession = true;
  const prev = loadState(); // flags stay relative to the check before this session
  let tasks;
  for (let first = true; ; first = false) {
    loader.start('Fetching your tasks…');
    try {
      tasks = await fetchAssigned(false);
    } catch (e) {
      loader.stop();
      if (first) throw e;
      console.error(yellow('warning: ') + `couldn't refresh the list (${e.message}); showing the previous one`);
    }
    loader.stop();
    if (!tasks.length) return console.log(green('No open tasks assigned to you.'));
    flagTasks(tasks, prev, false);
    if (first) saveSnapshot(tasks); // a session counts as a check
    const id = await pickTask(tasks, `Your open tasks (${tasks.length})`);
    if (id === null) return;
    const task = tasks.find((t) => String(t.id) === id);
    await interactiveTask(id, task?.subject || '');
  }
}

// Tell the user when the upstream repo has commits they haven't pulled. The check is a local
// rev-list against the last fetched state; a throttled background `git fetch` keeps that fresh
// (FETCH_HEAD's mtime is the throttle), so there is never any added latency.
function updateNotice() {
  if (!process.stderr.isTTY || process.env.NO_COLOR || !existsSync(join(ROOT, '.git'))) return;
  try {
    const behind = Number(execFileSync('git', ['-C', ROOT, 'rev-list', '--count', 'HEAD..@{u}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    if (behind > 0) console.error('\n' + yellow(`Update available (${behind} new commit${behind === 1 ? '' : 's'}). Run: git -C ${ROOT} pull`));
  } catch {}
  let age = Infinity;
  try { age = Date.now() - statSync(join(ROOT, '.git', 'FETCH_HEAD')).mtimeMs; } catch {}
  if (age > 6 * 3600 * 1000) {
    const git = spawn('git', ['-C', ROOT, 'fetch', '--quiet'], { detached: true, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    git.on('error', () => {});
    git.unref();
  }
}

// Exit quietly when the reader goes away (e.g. `st-tasks | head`).
process.stdout.on('error', (e) => (e.code === 'EPIPE' ? process.exit(0) : Promise.reject(e)));

const opts = parseArgs(process.argv.slice(2));
try {
  // Argument completion: on a terminal, pickers and prompts fill in what was left out
  // (opts.pickTask / askLog / askMessage from parseArgs), then the handlers run unchanged.
  if (opts.pickTask) opts.id = await taskPicker({ includeClosed: opts.cmd === 'open' });
  if (opts.askLog) await logWizard(opts);
  if (opts.askMessage) {
    const message = await input({ question: `Comment on #${opts.id}:` });
    if (!message) die('Cancelled. Nothing was changed.');
    opts.message = message;
  }
  if (opts.cmd === 'help') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 25).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  } else if (opts.cmd === 'log') {
    await (opts.id ? logTime(opts) : worklog(opts));
  } else if (opts.cmd === 'comment') {
    await comment(opts.id, opts.message);
  } else if (Object.hasOwn(STATUS_CMDS, opts.cmd)) {
    await changeStatus(opts);
  } else if (opts.cmd === 'show') {
    await show(opts.id);
  } else if (opts.cmd === 'interactive') {
    await interactive();
  } else {
    await list(opts);
  }
} catch (e) {
  // Anything unexpected becomes a one-line error; ST_DEBUG=1 shows the stack.
  if (process.env.ST_DEBUG) console.error(e?.stack);
  die(e?.message || String(e));
}
if (opts.cmd !== 'help' && !opts.json && !opts.text) updateNotice();
