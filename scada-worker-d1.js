/**
 * SCADA Asset Control — Cloudflare Worker (D1 + archive edition)
 * Deploy to: scada-visualizer.je1-bd1-raghu.workers.dev
 *
 * D1 binding (wrangler.toml):
 *   [[d1_databases]]
 *   binding       = "DB"
 *   database_name = "scada-store"
 *   database_id   = "<your-d1-database-id>"
 *
 * Schema: see schema.sql
 *
 * Routes (unchanged — front-end needs zero changes):
 *   GET   /config        → { files: { "config.json": "..." } }
 *   GET   /output        → { files: { "records.csv": "<current month>", "leakbursts.csv": "<all>" } }
 *   PATCH /output        → appends new rows only; never overwrites history
 *   GET   /status        → { files: { "zone_a_status.json": "...", ... } }
 *   PATCH /status        → writes zone_*_status.json (whitelist enforced)
 *
 *   BONUS — richer queries the download UI can use:
 *   GET   /output?month=YYYY-MM  → that month's records only
 *   GET   /output?all=1          → all records ever (admin export)
 */

const WORKER_NAME = 'scada-asset-worker-d1';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const STATUS_FILE_RE = /^zone_[a-z0-9_-]+_status\.json$/i;

// Column order must match index.html exactly
const CSV_COLS    = ['sn','personId','personName','zone','assetId','assetName','action','timestamp','date','time','lat','lng','distance','gpsAcc','deviceId'];
const LB_CSV_COLS = ['sn','docket','personId','personName','zone','assetId','assetName','action','timestamp','date','time','lat','lng','distance','deviceId'];

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url    = new URL(request.url);
    const path   = url.pathname.replace(/\/+$/, '').toLowerCase();
    const method = request.method.toUpperCase();

    try {
      if (path === '/config' && method === 'GET')   return await handleConfigGet(env.DB);
      if (path === '/output' && method === 'GET')   return await handleOutputGet(env.DB, url);
      if (path === '/output' && method === 'PATCH') return await handleOutputPatch(env.DB, request);
      if (path === '/status' && method === 'GET')   return await handleStatusGet(env.DB);
      if (path === '/status' && method === 'PATCH') return await handleStatusPatch(env.DB, request);
      return jsonResp({ error: 'Not found', path, method }, 404);
    } catch (err) {
      console.error(`[${WORKER_NAME}]`, err);
      return jsonResp({ error: err.message }, 500);
    }
  }
};

// ── GET /config ────────────────────────────────────────────────────────────────
async function handleConfigGet(db) {
  const row = await db.prepare('SELECT content FROM files WHERE name = ?')
    .bind('config.json').first();
  return jsonResp({ files: { 'config.json': row?.content ?? '{}' } });
}

// ── GET /output ────────────────────────────────────────────────────────────────
// Default: current-month records + all leakburst rows
// ?month=YYYY-MM : specific month (download page)
// ?all=1         : entire history (admin export)
async function handleOutputGet(db, url) {
  const monthParam = url.searchParams.get('month');
  const allParam   = url.searchParams.get('all');

  let recRows;
  if (allParam === '1') {
    const r = await db.prepare('SELECT * FROM records ORDER BY timestamp ASC').all();
    recRows = r.results;
  } else {
    const prefix = monthParam ?? currentMonthPrefix();
    const r = await db.prepare(
      "SELECT * FROM records WHERE date LIKE ? ORDER BY timestamp ASC"
    ).bind(prefix + '%').all();
    recRows = r.results;
  }

  // Leakbursts: always return all rows so the app can track unresolved reports
  const lb = await db.prepare('SELECT * FROM leakbursts ORDER BY timestamp ASC').all();

  // Estimates live in the key-value `files` table (single JSON blob), but the
  // estimate + asset-control front-ends read them from this /output response,
  // so surface the blob here too.
  const estRow = await db.prepare('SELECT content FROM files WHERE name = ?')
    .bind('estimates.json').first();

  return jsonResp({
    files: {
      'records.csv':    toCsv(recRows, CSV_COLS),
      'leakbursts.csv': toCsv(lb.results, LB_CSV_COLS),
      'estimates.json': estRow?.content ?? '[]',
    }
  });
}

// ── PATCH /output ──────────────────────────────────────────────────────────────
// Front-end sends the full CSV it has in memory (append-only by design).
// We INSERT OR IGNORE each row — "sn" is the PK so duplicates are harmless.
async function handleOutputPatch(db, request) {
  const body = await parseBody(request);
  if (!body?.files) return jsonResp({ error: 'Body must contain a "files" object' }, 400);

  const stmts = [];
  const now   = new Date().toISOString();

  if (typeof body.files['records.csv']?.content === 'string') {
    const rows = parseCsv(body.files['records.csv'].content);
    for (const r of rows) {
      stmts.push(db.prepare(`
        INSERT OR IGNORE INTO records
          (sn,personId,personName,zone,assetId,assetName,action,timestamp,date,time,lat,lng,distance,gpsAcc,deviceId)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        r.sn, r.personId, r.personName, r.zone, r.assetId, r.assetName,
        r.action, r.timestamp, r.date, r.time,
        numOrNull(r.lat), numOrNull(r.lng), numOrNull(r.distance), numOrNull(r.gpsAcc), r.deviceId
      ));
    }
  }

  if (typeof body.files['leakbursts.csv']?.content === 'string') {
    const rows = parseCsv(body.files['leakbursts.csv'].content);
    for (const r of rows) {
      stmts.push(db.prepare(`
        INSERT OR IGNORE INTO leakbursts
          (sn,docket,personId,personName,zone,assetId,assetName,action,timestamp,date,time,lat,lng,distance,deviceId)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        r.sn, r.docket||null, r.personId, r.personName, r.zone,
        r.assetId, r.assetName, r.action, r.timestamp, r.date, r.time,
        numOrNull(r.lat), numOrNull(r.lng), numOrNull(r.distance), r.deviceId
      ));
    }
  }

  // Estimates: a full-array JSON blob stored in the key-value `files` table.
  // INSERT OR REPLACE — the client always sends the complete current array.
  const estVal = body.files['estimates.json'];
  if (estVal != null) {
    const content = typeof estVal === 'string' ? estVal : (estVal?.content ?? JSON.stringify(estVal));
    stmts.push(
      db.prepare('INSERT OR REPLACE INTO files (name, content, updated_at) VALUES (?, ?, ?)')
        .bind('estimates.json', content, now)
    );
  }

  if (stmts.length > 0) await db.batch(stmts);
  return jsonResp({ ok: true, updatedAt: now, inserted: stmts.length });
}
async function handleStatusGet(db) {
  const { results } = await db
    .prepare("SELECT name, content FROM files WHERE name LIKE 'zone_%_status.json'")
    .all();
  return jsonResp({ files: Object.fromEntries(results.map(r => [r.name, r.content])) });
}

// ── PATCH /status ──────────────────────────────────────────────────────────────
async function handleStatusPatch(db, request) {
  const body = await parseBody(request);
  if (!body?.files) return jsonResp({ error: 'Body must contain a "files" object' }, 400);

  const rejected = Object.keys(body.files).filter(n => !STATUS_FILE_RE.test(n));
  if (rejected.length > 0) {
    return jsonResp({ error: 'Only zone_*_status.json files may be written via /status', rejected }, 403);
  }

  await upsertFiles(db, body.files);
  return jsonResp({ ok: true, updatedAt: new Date().toISOString() });
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

async function upsertFiles(db, filesObj) {
  const now   = new Date().toISOString();
  const stmts = Object.entries(filesObj).map(([name, val]) => {
    const content = typeof val === 'string' ? val : (val?.content ?? JSON.stringify(val));
    return db.prepare('INSERT OR REPLACE INTO files (name, content, updated_at) VALUES (?, ?, ?)')
      .bind(name, content, now);
  });
  await db.batch(stmts);
}

// Empty string → NULL, but preserve a real 0 (which `x || null` would lose).
function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function currentMonthPrefix() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Dependency-free CSV parser (no Papa in the worker runtime)
function parseCsv(text) {
  if (!text?.trim()) return [];
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').trim());
  return lines.slice(1).map(line => {
    const vals = splitCsvLine(line);
    const row  = {};
    header.forEach((col, i) => { row[col] = (vals[i] ?? '').replace(/^"|"$/g, '').trim(); });
    return row;
  }).filter(r => Object.values(r).some(v => v !== ''));
}

function splitCsvLine(line) {
  const out = []; let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"')        inQ = !inQ;
    else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function toCsv(rows, cols) {
  const esc = v => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(','), ...( rows?.map(r => cols.map(c => esc(r[c])).join(',')) ?? [] )];
  return lines.join('\r\n');
}

async function parseBody(req) {
  try { return await req.json(); } catch { return null; }
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
