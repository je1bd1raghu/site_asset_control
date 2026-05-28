#!/usr/bin/env python3
"""
seed_d1.py — Seed SCADA data into D1 via the live worker (and wrangler for config).

Usage:
  python3 seed_d1.py

Place this script in the same folder as your exported files.
Re-running is always safe — INSERT OR IGNORE means no duplicates.
"""

import json, sys, subprocess, platform, tempfile, os
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

WORKER_URL = "https://scada-visualizer.je1-bd1-raghu.workers.dev"
IS_WINDOWS = platform.system() == "Windows"

def patch(endpoint, files_dict):
    url  = WORKER_URL + endpoint
    body = json.dumps({"files": {k: {"content": v} for k, v in files_dict.items()}}).encode()
    req  = Request(url, data=body, method="PATCH", headers={
        "Content-Type": "application/json",
        "User-Agent":   "scada-seed/1.0",
    })
    try:
        with urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except HTTPError as e:
        return {"error": e.read().decode(), "ok": False}
    except URLError as e:
        return {"error": str(e), "ok": False}

def load(path):
    try:
        content = open(path, encoding="utf-8-sig").read()
        print(f"  📄  loaded {path} ({len(content):,} bytes)")
        return content
    except FileNotFoundError:
        print(f"  ⚠   {path} not found — skipping")
        return None

def count_csv_rows(text):
    if not text or not text.strip():
        return 0
    return max(0, len([l for l in text.strip().splitlines() if l.strip()]) - 1)

def run_wrangler(sql):
    """Run a wrangler d1 execute command.

    Two fixes vs the original:
      1. Write the SQL to a temp .sql file and pass it via --file instead of
         --command, so that curly braces, quotes, and other shell-special
         characters in JSON content never touch the command line / SQLite
         token parser.
      2. Force subprocess to decode wrangler's UTF-8 output with errors='replace'
         instead of letting Python use the Windows cp1252 default, which chokes
         on wrangler's emoji (✘, 🪵, ✅, …).
    """
    # Write SQL to a temp file (UTF-8, no BOM) so the shell never sees the content.
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".sql", encoding="utf-8", delete=False
    )
    try:
        tmp.write(sql)
        tmp.close()

        cmd = f'wrangler d1 execute scada-store --remote --file "{tmp.name}"'
        result = subprocess.run(
            cmd,
            capture_output=True,
            # Don't let Python pick the locale codec on Windows — force UTF-8.
            encoding="utf-8",
            errors="replace",       # swap undecodable bytes with ? instead of crashing
            shell=IS_WINDOWS,
        )
        return result
    finally:
        os.unlink(tmp.name)         # always clean up the temp file

# ── 1. config.json — inserted via wrangler (PATCH /config doesn't exist) ──────
print("\n── config ──────────────────────────────────────────────────")
content = load("config.json")
if content:
    # Standard SQL single-quote escaping (double every apostrophe).
    # Curly braces are safe inside a string literal in SQLite, but they
    # were previously broken by being passed through the shell; the --file
    # approach above removes that problem entirely.
    escaped = content.replace("'", "''")
    sql = (
        "INSERT OR REPLACE INTO files (name, content, updated_at) "
        f"VALUES ('config.json', '{escaped}', datetime('now'));"
    )
    try:
        r = run_wrangler(sql)
        if r.returncode == 0:
            print(f"  ✅  config.json written to D1 via wrangler")
        else:
            print(f"  ❌  wrangler error:\n{r.stderr}")
            sys.exit(1)
    except FileNotFoundError:
        print("  ❌  wrangler not found — is it installed?")
        print("      Run: npm install -g wrangler")
        sys.exit(1)

# ── 2. zone status files ──────────────────────────────────────────────────────
print("\n── status ──────────────────────────────────────────────────")
status_payload = {}
for name in ["zone_a_status.json", "zone_b_status.json", "zone_c_status.json"]:
    c = load(name)
    if c:
        status_payload[name] = c

if status_payload:
    r = patch("/status", status_payload)
    if r.get("ok"):
        print(f"  ✅  {', '.join(status_payload.keys())} seeded")
    else:
        print(f"  ❌  {r}"); sys.exit(1)
else:
    print("  —  no zone status files found, skipping")

# ── 3. records.csv + leakbursts.csv ──────────────────────────────────────────
print("\n── output (records + leakbursts) ────────────────────────────")
output_payload = {}

records_csv = load("records.csv")
if records_csv:
    print(f"      → {count_csv_rows(records_csv)} data rows in records.csv")
    output_payload["records.csv"] = records_csv

leakbursts_csv = load("leakbursts.csv")
if leakbursts_csv:
    print(f"      → {count_csv_rows(leakbursts_csv)} data rows in leakbursts.csv")
    output_payload["leakbursts.csv"] = leakbursts_csv

if output_payload:
    r = patch("/output", output_payload)
    if r.get("ok"):
        inserted = r.get("inserted", "?")
        print(f"  ✅  done  ({inserted} INSERT statements — duplicates silently skipped)")
        if isinstance(inserted, int) and inserted == 0:
            print("      ℹ   Zero means all rows already exist in D1 (safe on re-run)")
    else:
        print(f"  ❌  {r}"); sys.exit(1)
else:
    print("  —  no CSV files found, skipping")

# ── 4. Verify ─────────────────────────────────────────────────────────────────
print("\n── verify ──────────────────────────────────────────────────")
print("  Run these to confirm row counts:")
print('  wrangler d1 execute scada-store --remote --command "SELECT COUNT(*) FROM records;"')
print('  wrangler d1 execute scada-store --remote --command "SELECT COUNT(*) FROM leakbursts;"')
print('  wrangler d1 execute scada-store --remote --command "SELECT name, length(content) as bytes FROM files;"')
