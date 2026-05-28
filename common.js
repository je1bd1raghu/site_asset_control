/* ============================================================================
 * common.js — shared helpers and constants for the SCADA Asset Control site.
 *
 * Loaded (before any page-specific script) by:
 *   index.html, estimate.html, scada-visualizer.html, graph-analyzer.html
 *
 * Everything here lives in the global scope, so each page can call these
 * directly. Page-specific constants (GIST_BASE, GIST_ID, REFRESH_INTERVAL_MS,
 * etc.) stay on their own pages.
 * ========================================================================== */

// ─── BACKEND CONSTANTS ───────────────────────────────────────────────────────
const WORKER         = 'https://scada-visualizer.je1-bd1-raghu.workers.dev';
const RECORDS_FILE   = 'records.csv';     // on/off toggle records only
const LEAKBURST_FILE = 'leakbursts.csv';  // leak/burst report + clear records
const CONFIG_FILE    = 'config.json';
const ESTIMATES_FILE = 'estimates.json';

// ─── STRING / TIME HELPERS ───────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}
function pad(n) { return n < 10 ? '0' + n : '' + n; }
const pad2 = pad;   // alias kept for inline scripts in scada-visualizer.html
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function timeStr(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ─── UNIQUE RECORD SERIAL ────────────────────────────────────────────────────
// Globally-unique value for a record's `sn` PRIMARY KEY. The worker inserts
// rows with INSERT OR IGNORE keyed on `sn`, so any collision SILENTLY DROPS the
// row. A per-list ordinal (e.g. array.length + 1) is NOT safe: it collides
// across months, across pages, and across concurrent devices. Always use this.
function makeSn() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── DEVICE ID (requires FingerprintJS; pages that need it load fp.min.js) ───
async function getDeviceId() {
  try {
    const fp = await FingerprintJS.load();
    return (await fp.get()).visitorId;
  } catch { return 'unknown'; }
}

// ─── WORKER API ──────────────────────────────────────────────────────────────
async function workerGet(endpoint) {
  const r = await fetch(`${WORKER}/${endpoint}`);
  if (!r.ok) throw new Error(`Worker ${endpoint} failed: HTTP ${r.status}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.files;  // { filename: rawString }
}
async function workerPatch(fileMap) {
  return workerPatch2('output', fileMap);
}
// Generic PATCH helper — targets any worker endpoint (e.g. 'status', 'output').
async function workerPatch2(endpoint, fileMap) {
  const files = {};
  for (const [k, v] of Object.entries(fileMap))
    files[k] = { content: typeof v === 'string' ? v : JSON.stringify(v, null, 2) };
  const r = await fetch(`${WORKER}/${endpoint}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files })
  });
  if (!r.ok) throw new Error(`Worker ${endpoint} write failed: HTTP ${r.status}`);
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || 'Gist write failed');
}

// ─── TOAST ───────────────────────────────────────────────────────────────────
// Expects an element with id="toast". Optionally mirrors to id="sr-announcer"
// for screen-reader users when that element exists.
let _toastTmr;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  if (el) {
    el.textContent = msg;
    el.className = 'toast ' + (type || '');
    void el.offsetWidth;            // restart the CSS transition
    el.classList.add('show');
    clearTimeout(_toastTmr);
    _toastTmr = setTimeout(() => el.classList.remove('show'), 3400);
  }
  const sr = document.getElementById('sr-announcer');
  if (sr) { sr.textContent = ''; requestAnimationFrame(() => { sr.textContent = msg; }); }
}

// ─── HEADER CLOCK ──────────────────────────────────────────────────────────
// Updates whichever of these elements exist on the page:
//   dispDate, dispTime, dispDay, headerDate
function updateClock() {
  const now    = new Date();
  const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  set('dispDate', `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`);
  set('dispTime', `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`);
  set('dispDay',  DAYS[now.getDay()].slice(0, 3));
  set('headerDate', `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`);
}
