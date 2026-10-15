#!/usr/bin/env node
// st-tasks — check work packages assigned to me on OpenProject.
//
//   st-tasks                 open tasks assigned to me (NEW / UPDATED since last check are flagged)
//   st-tasks --all           include closed tasks
//   st-tasks -p pubportal    filter by project name (substring, case-insensitive)
//   st-tasks -s progress     filter by status name (substring, case-insensitive)
//   st-tasks --json          raw JSON output
//   st-tasks show <id>       details, description and recent comments for one task
//   st-tasks open <id>       open the task in the browser
//   st-tasks log [date]      my work log for today, yesterday or YYYY-MM-DD: time logged per task
//   st-tasks log --miss      tasks I commented on or changed the status of with no time logged (slower)
//   st-tasks log --text      the same tasks as a plain "Working on:" list to paste into a status update

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawn } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(ROOT, '.state.json');

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

function die(msg) {
  loader.stop();
  console.error(red('error: ') + msg);
  process.exit(1);
}

// Turn a failed API response into a short, readable message.
async function apiError(res, path) {
  let detail = '';
  try { detail = cell((await res.json()).message); } catch {}
  const wp = /^\/api\/v3\/work_packages\/(\d+)/.exec(path)?.[1];
  const what = wp ? `Task #${wp}` : 'That resource';
  if (res.status === 401) return `Authentication failed. Check OPENPROJECT_TOKEN in .env (create one at ${BASE}/my/access_token).`;
  if (res.status === 403) return `${what}: you don't have permission to access it.`;
  if (res.status === 404) return `${what} not found, or you don't have access to it.`;
  if (res.status === 429) return 'Too many requests. Wait a moment and try again.';
  if (res.status >= 500) return `${BASE} had a server error (${res.status}). Try again later.`;
  return `${res.status} ${res.statusText}${detail ? ': ' + detail : ''} (${path})`;
}

async function api(path, params) {
  const url = new URL(BASE + '/api/v3' + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: 'Basic ' + Buffer.from('apikey:' + TOKEN).toString('base64'), Accept: 'application/hal+json' },
    });
  } catch (e) {
    die(`Can't reach ${BASE}${e.cause?.code ? ` (${e.cause.code})` : ''}. Check your connection and OPENPROJECT_URL.`);
  }
  if (!res.ok) die(await apiError(res, url.pathname));
  return res.json();
}

function parseArgs(argv) {
  const opts = { all: false, json: false, project: null, status: null, cmd: 'list', id: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all' || a === '-a') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--text') opts.text = true;
    else if (a === '--miss') opts.miss = true;
    else if (a === '-p' || a === '--project') opts.project = argv[++i];
    else if (a === '-s' || a === '--status') opts.status = argv[++i];
    else if (a === '-h' || a === '--help') opts.cmd = 'help';
    else if (a === 'show' || a === 'open') { opts.cmd = a; opts.id = argv[++i]; }
    else if (a === 'log') opts.cmd = 'log';
    else if (opts.cmd === 'log' && !opts.date && (!a.startsWith('-') || /^-\d+$/.test(a))) opts.date = a;
    else die(`unknown argument: ${a}`);
  }
  if ((opts.cmd === 'show' || opts.cmd === 'open') && !/^\d+$/.test(opts.id || '')) die(`usage: st-tasks ${opts.cmd} <id>`);
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

// Bordered table. Empty columns are dropped; Subject/Comments shrink to fit the terminal.
function table(rows, cols) {
  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '');
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

async function list(opts) {
  loader.start('Fetching your tasks…');
  let tasks = await fetchAssigned(opts.all);
  loader.stop();
  if (opts.project) tasks = tasks.filter((t) => t.project.toLowerCase().includes(opts.project.toLowerCase()));
  if (opts.status) tasks = tasks.filter((t) => t.status.toLowerCase().includes(opts.status.toLowerCase()));

  const prev = loadState();
  const seen = prev?.tasks || {};
  // The snapshot only holds open tasks, so flags are meaningless for --all.
  for (const t of tasks) t.flag = !prev || opts.all ? '' : !(t.id in seen) ? 'NEW' : seen[t.id] !== t.updatedAt ? 'UPD' : '';

  // Only an unfiltered view of open tasks updates the "last checked" snapshot.
  if (!opts.all && !opts.project && !opts.status) {
    writeFileSync(STATE_FILE, JSON.stringify({ checkedAt: new Date().toISOString(), tasks: Object.fromEntries(tasks.map((t) => [t.id, t.updatedAt])) }, null, 2));
  }

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
async function fetchTouched(date, meId) {
  loader.set(`Finding tasks updated on ${date}…`);
  const start = new Date(date + 'T00:00:00'), end = new Date(start);
  end.setDate(end.getDate() + 1);
  const tasks = [];
  for (let offset = 1; ; offset++) {
    const page = await api('/work_packages', {
      filters: [{ updatedAt: { operator: '<>d', values: [start.toISOString(), end.toISOString()] } }],
      pageSize: '100',
      offset: String(offset),
    });
    tasks.push(...page._embedded.elements);
    if (tasks.length >= page.total || page._embedded.elements.length === 0) break;
  }
  const mine = `/users/${meId}`;
  const touched = [];
  let done = 0;
  loader.progress(0, tasks.length, 'Reading task activity');
  // A few activity requests at a time, so a busy day doesn't open dozens of connections.
  for (let i = 0; i < tasks.length; i += 8) {
    await Promise.all(tasks.slice(i, i + 8).map(async (w) => {
      const acts = (await api(`/work_packages/${w.id}/activities`))._embedded.elements;
      loader.progress(++done, tasks.length);
      const actions = new Set();
      for (const a of acts) {
        const at = new Date(a.createdAt);
        if (!a._links.user?.href?.endsWith(mine) || at < start || at >= end) continue;
        if (a.comment?.raw?.trim()) actions.add('Commented');
        for (const d of a.details || []) {
          const m = /^Status changed from .*?\s*\nto (.+)$/s.exec(d.raw || '');
          if (m) actions.add(`Status → ${cell(m[1])}`);
        }
      }
      if (actions.size) touched.push({ id: w.id, project: cell(w._links.project?.title), subject: cell(w.subject), actions: [...actions] });
    }));
  }
  return touched.sort((a, b) => b.id - a.id);
}

async function worklog(opts) {
  const date = parseDate(opts.date);
  loader.start(`Fetching time entries for ${date}…`);
  const me = await api('/users/me');
  const entries = [];
  for (let offset = 1; ; offset++) {
    const page = await api('/time_entries', {
      filters: [{ user: { operator: '=', values: [String(me.id)] } }, { spent_on: { operator: '=d', values: [date] } }],
      pageSize: '100',
      offset: String(offset),
    });
    entries.push(...page._embedded.elements);
    if (entries.length >= page.total || page._embedded.elements.length === 0) break;
  }

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
  const missing = opts.miss ? (await fetchTouched(date, me.id)).filter((t) => !tasks.some((x) => x.id === t.id)) : [];
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
if (opts.cmd === 'help') {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
} else if (opts.cmd === 'log') {
  await worklog(opts);
} else if (opts.cmd === 'show') {
  await show(opts.id);
} else if (opts.cmd === 'open') {
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [`${BASE}/work_packages/${opts.id}`]);
} else {
  await list(opts);
}
if (!['help', 'open'].includes(opts.cmd) && !opts.json && !opts.text) updateNotice();
