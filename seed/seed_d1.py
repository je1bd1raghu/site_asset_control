#!/usr/bin/env python3
"""
seed_d1.py — Sync SCADA data between local files and the live D1-backed worker,
and deploy the worker itself.

Usage:
  python3 seed/seed_d1.py            # interactive menu
  python3 seed/seed_d1.py pull       # download D1 → local files
  python3 seed/seed_d1.py push       # upload local files → D1
  python3 seed/seed_d1.py verify     # show D1 row / blob sizes
  python3 seed/seed_d1.py deploy     # wrangler deploy (uploads scada-worker-d1.js)

Files live alongside this script under seed/ (paths are resolved relative to the
script, not the current working directory):

    seed/config.json                 ← /config
    seed/status/zone_*_status.json   ← /status
    seed/records/records.csv         ← /output
    seed/records/leakbursts.csv      ← /output
    seed/records/estimates.json      ← /output

Pushing is always safe to repeat — INSERT OR IGNORE means no duplicates.
"""

import json, sys, subprocess, tempfile, os
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

WORKER_URL = "https://scada-visualizer.je1-bd1-raghu.workers.dev"

# All paths are anchored to this script's folder (seed/), so the tool behaves the
# same whether run as `seed/seed_d1.py` from the repo root or `./seed_d1.py`.
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")
STATUS_DIR  = os.path.join(SCRIPT_DIR, "status")
RECORDS_DIR = os.path.join(SCRIPT_DIR, "records")

STATUS_FILES = ["zone_a_status.json", "zone_b_status.json", "zone_c_status.json"]
OUTPUT_FILES = ["records.csv", "leakbursts.csv", "estimates.json"]

def status_path(name):  return os.path.join(STATUS_DIR, name)
def output_path(name):  return os.path.join(RECORDS_DIR, name)

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
        print(f"  📄  loaded {rel(path)} ({len(content):,} bytes)")
        return content
    except FileNotFoundError:
        print(f"  ⚠   {rel(path)} not found — skipping")
        return None

def save(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    print(f"  💾  saved {rel(path)} ({len(content):,} bytes)")

def rel(path):
    """Show paths relative to cwd when possible, else as-is — just for tidy output."""
    try:    return os.path.relpath(path)
    except ValueError:  return path

def count_csv_rows(text):
    if not text or not text.strip():
        return 0
    return max(0, len([l for l in text.strip().splitlines() if l.strip()]) - 1)

# ── wrangler helpers ──────────────────────────────────────────────────────────
# wrangler runs from SCRIPT_DIR (seed/) so it finds wrangler.toml + the worker
# entry point there. shell=True covers Windows (.cmd shim) and POSIX alike.
def wrangler(argstr):
    return subprocess.run(f"wrangler {argstr}", capture_output=True,
                          encoding="utf-8", errors="replace", shell=True, cwd=SCRIPT_DIR)

def wrangler_sql(sql):
    """Run SQL via a temp .sql file + --file, so quotes/braces/newlines in JSON
    never touch the shell, and force UTF-8 output (wrangler emits emoji)."""
    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".sql", encoding="utf-8", delete=False)
    try:
        tmp.write(sql); tmp.close()
        return wrangler(f'd1 execute scada-store --remote --file "{tmp.name}"')
    finally:
        os.unlink(tmp.name)

def section(title):
    print(f"\n── {title} {'─' * max(0, 56 - len(title))}")

# ── PULL: D1 → local files ────────────────────────────────────────────────────
def pull():
    section("pull — config")
    r = get("/config")
    if "files" in r and r["files"].get("config.json") is not None:
        save(CONFIG_PATH, r["files"]["config.json"])
    else:
        print(f"  ❌  {r.get('error', r)}")

    section("pull — status (→ seed/status/)")
    r = get("/status")
    if "files" in r:
        if r["files"]:
            for name, content in r["files"].items():
                save(status_path(name), content)
        else:
            print("  —  no zone status files in D1")
    else:
        print(f"  ❌  {r.get('error', r)}")

    section("pull — output (→ seed/records/)")
    r = get("/output?all=1")   # all=1 → full history, not just this month
    if "files" in r:
        for name in OUTPUT_FILES:
            if name in r["files"]:
                content = r["files"][name]
                if name.endswith(".csv"):
                    print(f"      → {count_csv_rows(content)} data rows in {name}")
                save(output_path(name), content)
    else:
        print(f"  ❌  {r.get('error', r)}")

    print("\n  ✅  pull complete.")

# ── PUSH: local files → D1 ────────────────────────────────────────────────────
def push():
    # config.json — inserted via wrangler (there is no PATCH /config endpoint).
    section("push — config")
    content = load(CONFIG_PATH)
    if content:
        escaped = content.replace("'", "''")   # SQL single-quote escaping
        sql = ("INSERT OR REPLACE INTO files (name, content, updated_at) "
               f"VALUES ('config.json', '{escaped}', datetime('now'));")
        r = wrangler_sql(sql)
        if r.returncode == 0:
            print("  ✅  config.json written to D1 via wrangler")
        else:
            print(f"  ❌  wrangler error:\n{r.stderr.strip()}"); return False

    # zone status files — via PATCH /status (whitelisted to zone_*_status.json).
    section("push — status")
    status_payload = {name: c for name in STATUS_FILES if (c := load(status_path(name)))}
    if status_payload:
        r = patch("/status", status_payload)
        if r.get("ok"):
            print(f"  ✅  {', '.join(status_payload.keys())} seeded")
        else:
            print(f"  ❌  {r}"); return False
    else:
        print("  —  no zone status files found, skipping")

    # records + leakbursts + estimates — via PATCH /output (append-only).
    section("push — output")
    output_payload = {}
    for name in OUTPUT_FILES:
        c = load(output_path(name))
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
    for label, q in queries:
        r = wrangler(f'd1 execute scada-store --remote --command "{q}"')
        if r.returncode == 0:
            print(f"  ✅  {label}:\n{r.stdout.strip()}\n")
        else:
            print(f"  ❌  {label}: {r.stderr.strip()}")

# ── DEPLOY: upload the worker (scada-worker-d1.js) ────────────────────────────
def deploy():
    section("deploy — wrangler deploy (scada-worker-d1.js)")
    r = wrangler("deploy")
    print(r.stdout.strip())
    if r.returncode == 0:
        print("\n  ✅  worker deployed.")
    else:
        print(f"  ❌  deploy failed:\n{r.stderr.strip()}")

# ── Console UX ────────────────────────────────────────────────────────────────
def confirm(msg):
    return input(f"  {msg} [y/N] ").strip().lower() in ("y", "yes")

ACTIONS = {"pull": pull, "push": push, "verify": verify, "deploy": deploy}

def menu():
    print("\n  ┌────────────────────────────────────────────┐")
    print("  │             SCADA D1 Seed Tool               │")
    print("  └────────────────────────────────────────────┘")
    print(f"  Worker: {WORKER_URL}")
    print(f"  Files : {rel(SCRIPT_DIR)}/  (config.json, status/, records/)")
    print("  ──────────────────────────────────────────────")
    print("    1)  Pull    download D1 → seed/ files")
    print("    2)  Push    upload seed/ files → D1")
    print("    3)  Verify  show D1 row / blob sizes")
    print("    4)  Deploy  wrangler deploy (upload worker)")
    print("    0)  Exit")
    return input("  Choose: ").strip().lower()

def main():
    # Non-interactive: `seed_d1.py pull|push|verify|deploy`
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
            if confirm("Overwrite local seed/ files with D1 contents?"):
                pull()
        elif choice in ("2", "push"):
            if confirm("Upload seed/ files to the live D1 database?"):
                push()
        elif choice in ("3", "verify"):
            verify()
        elif choice in ("4", "deploy"):
            if confirm("Deploy the worker to Cloudflare?"):
                deploy()
        elif choice in ("0", "q", "quit", "exit", ""):
            print("  Bye 👋")
            break
        else:
            print("  Invalid choice — pick 1, 2, 3, 4 or 0.")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n  Cancelled.")
