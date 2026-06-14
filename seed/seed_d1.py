#!/usr/bin/env python3
"""
seed_d1.py — Sync SCADA data between local files and the live D1-backed worker.

Usage:
  python3 seed/seed_d1.py            # interactive menu
  python3 seed/seed_d1.py pull       # download D1 → local files
  python3 seed/seed_d1.py push       # upload local files → D1
  python3 seed/seed_d1.py verify     # show D1 row / blob sizes

Run from the folder that holds your exported files (config.json,
zone_*_status.json, records.csv, leakbursts.csv) — paths are resolved
relative to the current working directory, not this script's location.
Pushing is always safe to repeat — INSERT OR IGNORE means no duplicates.
"""

import json, sys, subprocess, platform, tempfile, os
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

WORKER_URL = "https://scada-visualizer.je1-bd1-raghu.workers.dev"
IS_WINDOWS = platform.system() == "Windows"

# Files this tool knows how to pull/push.
STATUS_FILES = ["zone_a_status.json", "zone_b_status.json", "zone_c_status.json"]
OUTPUT_FILES = ["records.csv", "leakbursts.csv", "estimates.json"]
CONFIG_FILE  = "config.json"

# ── HTTP helpers ──────────────────────────────────────────────────────────────
def get(endpoint):
    """GET an endpoint and return the parsed JSON ({files:{...}} on success)."""
    req = Request(WORKER_URL + endpoint, headers={"User-Agent": "scada-seed/1.0"})
    try:
        with urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except HTTPError as e:
        return {"error": e.read().decode(), "ok": False}
    except URLError as e:
        return {"error": str(e), "ok": False}

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

# ── File helpers ──────────────────────────────────────────────────────────────
def load(path):
    try:
        content = open(path, encoding="utf-8-sig").read()
        print(f"  📄  loaded {path} ({len(content):,} bytes)")
        return content
    except FileNotFoundError:
        print(f"  ⚠   {path} not found — skipping")
        return None

def save(path, content):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    print(f"  💾  saved {path} ({len(content):,} bytes)")

def count_csv_rows(text):
    if not text or not text.strip():
        return 0
    return max(0, len([l for l in text.strip().splitlines() if l.strip()]) - 1)

def run_wrangler(args, sql=None):
    """Run a `wrangler d1 execute scada-store --remote …` command.

    Pass either sql=<text> (written to a temp .sql file and run via --file, so
    that quotes / braces / newlines in JSON never touch the shell) or
    args=[...] for a one-off --command query.

    Output is forced to UTF-8 with errors='replace' so wrangler's emoji
    (✘, 🪵, ✅, …) don't crash Python's locale codec on Windows (cp1252).
    """
    base = "wrangler d1 execute scada-store --remote"
    if sql is not None:
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".sql", encoding="utf-8", delete=False)
        try:
            tmp.write(sql)
            tmp.close()
            cmd = f'{base} --file "{tmp.name}"'
            return subprocess.run(cmd, capture_output=True, encoding="utf-8",
                                  errors="replace", shell=IS_WINDOWS)
        finally:
            os.unlink(tmp.name)
    cmd = f'{base} {args}'
    return subprocess.run(cmd, capture_output=True, encoding="utf-8",
                          errors="replace", shell=IS_WINDOWS)

def section(title):
    print(f"\n── {title} {'─' * max(0, 56 - len(title))}")

# ── PULL: D1 → local files ────────────────────────────────────────────────────
def pull():
    section("pull — config")
    r = get("/config")
    if "files" in r and r["files"].get(CONFIG_FILE) is not None:
        save(CONFIG_FILE, r["files"][CONFIG_FILE])
    else:
        print(f"  ❌  {r.get('error', r)}")

    section("pull — status (zone_*_status.json)")
    r = get("/status")
    if "files" in r:
        if r["files"]:
            for name, content in r["files"].items():
                save(name, content)
        else:
            print("  —  no zone status files in D1")
    else:
        print(f"  ❌  {r.get('error', r)}")

    section("pull — output (records / leakbursts / estimates)")
    r = get("/output?all=1")   # all=1 → full history, not just this month
    if "files" in r:
        for name in OUTPUT_FILES:
            if name in r["files"]:
                content = r["files"][name]
                if name.endswith(".csv"):
                    print(f"      → {count_csv_rows(content)} data rows in {name}")
                save(name, content)
    else:
        print(f"  ❌  {r.get('error', r)}")

    print("\n  ✅  pull complete.")

# ── PUSH: local files → D1 ────────────────────────────────────────────────────
def push():
    # config.json — inserted via wrangler (there is no PATCH /config endpoint).
    section("push — config")
    content = load(CONFIG_FILE)
    if content:
        escaped = content.replace("'", "''")   # SQL single-quote escaping
        sql = ("INSERT OR REPLACE INTO files (name, content, updated_at) "
               f"VALUES ('{CONFIG_FILE}', '{escaped}', datetime('now'));")
        try:
            r = run_wrangler(None, sql=sql)
            if r.returncode == 0:
                print(f"  ✅  {CONFIG_FILE} written to D1 via wrangler")
            else:
                print(f"  ❌  wrangler error:\n{r.stderr}"); return False
        except FileNotFoundError:
            print("  ❌  wrangler not found — is it installed?")
            print("      Run: npm install -g wrangler")
            return False

    # zone status files — via PATCH /status (whitelisted to zone_*_status.json).
    section("push — status")
    status_payload = {name: c for name in STATUS_FILES if (c := load(name))}
    if status_payload:
        r = patch("/status", status_payload)
        if r.get("ok"):
            print(f"  ✅  {', '.join(status_payload.keys())} seeded")
        else:
            print(f"  ❌  {r}"); return False
    else:
        print("  —  no zone status files found, skipping")

    # records + leakbursts + estimates — via PATCH /output (append-only).
    section("push — output (records / leakbursts / estimates)")
    output_payload = {}
    for name in OUTPUT_FILES:
        c = load(name)
        if c:
            if name.endswith(".csv"):
                print(f"      → {count_csv_rows(c)} data rows in {name}")
            output_payload[name] = c

    if output_payload:
        r = patch("/output", output_payload)
        if r.get("ok"):
            inserted = r.get("inserted", "?")
            print(f"  ✅  done  ({inserted} INSERT statements — duplicates silently skipped)")
            if isinstance(inserted, int) and inserted == 0:
                print("      ℹ   Zero means all rows already exist in D1 (safe on re-run)")
        else:
            print(f"  ❌  {r}"); return False
    else:
        print("  —  no output files found, skipping")

    print("\n  ✅  push complete.")
    return True

# ── VERIFY: row counts / blob sizes from D1 ───────────────────────────────────
def verify():
    section("verify — D1 contents")
    queries = [
        ("records",    "SELECT COUNT(*) AS n FROM records;"),
        ("leakbursts", "SELECT COUNT(*) AS n FROM leakbursts;"),
        ("files",      "SELECT name, length(content) AS bytes FROM files;"),
    ]
    try:
        for label, q in queries:
            r = run_wrangler(f'--command "{q}"')
            if r.returncode == 0:
                print(f"  ✅  {label}:\n{r.stdout.strip()}\n")
            else:
                print(f"  ❌  {label}: {r.stderr.strip()}")
    except FileNotFoundError:
        print("  ❌  wrangler not found — install it (npm install -g wrangler), or run:")
        print('      wrangler d1 execute scada-store --remote --command "SELECT COUNT(*) FROM records;"')

# ── Console UX ────────────────────────────────────────────────────────────────
def confirm(msg):
    return input(f"  {msg} [y/N] ").strip().lower() in ("y", "yes")

ACTIONS = {"pull": pull, "push": push, "verify": verify}

def menu():
    print("\n  ┌──────────────────────────────────────────┐")
    print("  │           SCADA D1 Seed Tool               │")
    print("  └──────────────────────────────────────────┘")
    print(f"  Worker: {WORKER_URL}")
    print(f"  CWD:    {os.getcwd()}")
    print("  ────────────────────────────────────────────")
    print("    1)  Pull    download D1 → local files")
    print("    2)  Push    upload local files → D1")
    print("    3)  Verify  show D1 row / blob sizes")
    print("    0)  Exit")
    return input("  Choose: ").strip().lower()

def main():
    # Non-interactive: `seed_d1.py pull|push|verify`
    if len(sys.argv) > 1:
        action = sys.argv[1].lower()
        if action in ACTIONS:
            ACTIONS[action]()
        else:
            print(f"Unknown action '{action}'. Use: {', '.join(ACTIONS)}")
            sys.exit(1)
        return

    # Interactive menu loop.
    while True:
        choice = menu()
        if choice in ("1", "pull"):
            if confirm("Overwrite local files with D1 contents?"):
                pull()
        elif choice in ("2", "push"):
            if confirm("Upload local files to the live D1 database?"):
                push()
        elif choice in ("3", "verify"):
            verify()
        elif choice in ("0", "q", "quit", "exit", ""):
            print("  Bye 👋")
            break
        else:
            print("  Invalid choice — pick 1, 2, 3 or 0.")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n  Cancelled.")
