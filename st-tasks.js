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
//   st-tasks log [date]      my work log for today, yesterday or YYYY-MM-DD: total time and tasks by time logged
//   st-tasks log --text      the same tasks as a plain "Working on:" list to paste into a status update

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

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
const bold = c(1), dim = c(2), red = c(31), green = c(32), yellow = c(33), cyan = c(36), magenta = c(35);

function die(msg) {
  console.error(red('error: ') + msg);
  process.exit(1);
}

async function api(path, params) {
  const url = new URL(BASE + '/api/v3' + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const res = await fetch(url, {
    headers: { Authorization: 'Basic ' + Buffer.from('apikey:' + TOKEN).toString('base64'), Accept: 'application/hal+json' },
  });
  if (!res.ok) die(`${res.status} ${res.statusText} — ${url.pathname}\n${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function parseArgs(argv) {
  const opts = { all: false, json: false, project: null, status: null, cmd: 'list', id: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all' || a === '-a') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--text') opts.text = true;
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
    project: w._links.project?.title ?? '',
    subject: w.subject,
    type: w._links.type?.title ?? '',
    status: w._links.status?.title ?? '',
    priority: w._links.priority?.title ?? '',
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
  let tasks = await fetchAssigned(opts.all);
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

async function worklog(opts) {
  const date = parseDate(opts.date);
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
        project: e._links.project?.title ?? '',
        subject: wp?.title ?? '(no task)',
        activities: new Set(),
        comments: [],
        entries: 0,
        hours: 0,
      });
    }
    const t = byTask.get(key);
    t.hours += hoursOf(e.hours);
    t.entries++;
    if (e._links.activity?.title) t.activities.add(e._links.activity.title);
    const comment = (typeof e.comment === 'string' ? e.comment : e.comment?.raw)?.trim();
    if (comment) t.comments.push(comment);
  }
  const tasks = [...byTask.values()].sort((a, b) => b.hours - a.hours);
  const total = tasks.reduce((sum, t) => sum + t.hours, 0);

  if (opts.json) return console.log(JSON.stringify({ date, totalHours: total, tasks: tasks.map((t) => ({ ...t, activities: [...t.activities] })) }, null, 2));

  // Plain list for pasting into a status update.
  if (opts.text) {
    if (!tasks.length) return console.log(`No time logged on ${date}.`);
    return console.log('Working on:\n\n' + tasks.map((t) => `- ${t.id ? `Task #${t.id}: ` : ''}${t.subject}`).join('\n'));
  }

  const day = new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const when = date === isoDate(0) ? `today (${day})` : date === isoDate(-1) ? `yesterday (${day})` : `on ${day}`;
  if (!entries.length) return console.log(`You haven't logged any time ${when}.`);

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

const decode = (s) => s.replace(/&nbsp;|\u00a0/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const userNames = new Map();
async function userName(href) {
  if (!href) return '?';
  if (!userNames.has(href)) userNames.set(href, api(href.replace(/^\/api\/v3/, '')).then((u) => u.name, () => '?'));
  return userNames.get(href);
}

async function show(id) {
  const w = await api(`/work_packages/${id}`);
  const acts = await api(`/work_packages/${id}/activities`);
  const L = w._links;
  console.log(bold(wpLink(w.id) + ' ' + w.subject));
  console.log(`${dim('Project:')}  ${L.project?.title}    ${dim('Type:')} ${L.type?.title}    ${dim('Status:')} ${statusColor(L.status?.title)(L.status?.title)}    ${dim('Priority:')} ${L.priority?.title}`);
  console.log(`${dim('Assignee:')} ${L.assignee?.title ?? '-'}    ${dim('Author:')} ${L.author?.title ?? '-'}    ${dim('Due:')} ${dueLabel(w.dueDate) || '-'}    ${dim('Last updated:')} ${stamp(w.updatedAt)} ${dim(`(${rel(w.updatedAt)})`)}`);
  console.log(dim(`${BASE}/work_packages/${w.id}`));
  const desc = w.description?.raw?.trim();
  if (desc) console.log('\n' + bold('Description') + '\n' + decode(desc));
  const comments = acts._embedded.elements.filter((a) => a.comment?.raw?.trim()).slice(-5);
  if (comments.length) {
    console.log('\n' + bold(`Recent comments (${comments.length})`));
    const names = await Promise.all(comments.map((a) => a._links.user?.title ?? userName(a._links.user?.href)));
    comments.forEach((a, i) => console.log(`\n${cyan(names[i])} ${dim(rel(a.createdAt))}\n${decode(a.comment.raw).trim()}`));
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
