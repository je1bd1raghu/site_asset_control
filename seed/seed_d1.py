#!/usr/bin/env python3
"""
seed_d1.py — Sync SCADA data between local files and the live D1-backed worker,
and deploy the worker itself.

Usage:
  python3 seed/seed_d1.py            # interactive menu
  python3 seed/seed_d1.py pull                 # download D1 → local files
  python3 seed/seed_d1.py push                 # upload ALL local files → D1
  python3 seed/seed_d1.py push config status   # by group: config | status | output | all
  python3 seed/seed_d1.py push zone_a_status.json records.csv   # by individual file
  python3 seed/seed_d1.py verify               # show D1 row / blob sizes
  python3 seed/seed_d1.py deploy               # wrangler deploy (upserts scada-worker-d1.js)

The interactive menu's Push option lists every file so you can pick specific ones.

Files live alongside this script under seed/ (paths are resolved relative to the
script, not the current working directory):

    seed/config.json                 ← /config
    seed/status/zone_*_status.json   ← /status
    seed/records/records.csv         ← /output
    seed/records/leakbursts.csv      ← /output
    seed/records/estimates.json      ← /output

Push is a mirror: config/status/estimates are replaced, and the records /
leakbursts row tables are made to match the local files exactly — new local rows
are inserted AND remote rows whose `sn` is absent locally are DELETED. (The public
worker stays append-only; only this admin tool deletes, via wrangler.) A
present-but-empty CSV is skipped rather than wiping the whole table.
"""

import json, sys, subprocess, tempfile, os, csv, io, re
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

# Every individually-pushable file, in display order, plus the group shortcuts that
# expand to a set of them. push() works on a concrete list of these file names.
PUSHABLE = ["config.json", *STATUS_FILES, *OUTPUT_FILES]
GROUPS   = {"all": PUSHABLE, "config": ["config.json"],
            "status": STATUS_FILES, "output": OUTPUT_FILES}

def status_path(name):  return os.path.join(STATUS_DIR, name)
def output_path(name):  return os.path.join(RECORDS_DIR, name)
def local_path(name):
    if name == "config.json": return CONFIG_PATH
    if name in STATUS_FILES:  return status_path(name)
    return output_path(name)

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
# push() takes a concrete list of file names and groups them by endpoint. Each
# pusher returns True on success (or nothing to do) and False on a real failure.

def push_config_file():
    # config.json — upserted via wrangler (there is no PATCH /config endpoint).
    section("push · config.json")
    content = load(CONFIG_PATH)
    if content is None:
        return True   # load() already reported it's missing
    escaped = content.replace("'", "''")   # SQL single-quote escaping
    sql = ("INSERT OR REPLACE INTO files (name, content, updated_at) "
           f"VALUES ('config.json', '{escaped}', datetime('now'));")
    r = wrangler_sql(sql)
    if r.returncode == 0:
        print("  ✅  config.json → D1")
        return True
    print(f"  ❌  config.json failed:\n{r.stderr.strip()}")
    return False

def push_status_files(names):
    # zone status files — via PATCH /status (whitelisted to zone_*_status.json).
    section("push · status (" + ", ".join(names) + ")")
    payload = {n: c for n in names if (c := load(status_path(n))) is not None}
    if not payload:
        print("  —  nothing to push")
        return True
    r = patch("/status", payload)
    if r.get("ok"):
        print(f"  ✅  {len(payload)} status file(s) → D1: {', '.join(payload)}")
        return True
    print(f"  ❌  status push failed: {r.get('error', r)}")
    return False

# Row tables (keyed on `sn`) that push mirrors. estimates.json is a full-blob
# replace via PATCH /output, so it needs no row deletion.
TABLE_FOR_FILE = {"records.csv": "records", "leakbursts.csv": "leakbursts"}

def csv_sns(text):
    """Set of non-empty `sn` values in a CSV string."""
    if not text or not text.strip():
        return set()
    return {(r.get("sn") or "").strip()
            for r in csv.DictReader(io.StringIO(text)) if (r.get("sn") or "").strip()}

def delete_rows(table, sns):
    """DELETE the given sns from a table via wrangler (chunked IN lists)."""
    CHUNK = 200
    stmts = []
    for i in range(0, len(sns), CHUNK):
        vals = ",".join("'" + s.replace("'", "''") + "'" for s in sns[i:i + CHUNK])
        stmts.append(f"DELETE FROM {table} WHERE sn IN ({vals});")
    r = wrangler_sql("\n".join(stmts))
    if r.returncode == 0:
        print(f"  🗑  {table}: deleted {len(sns)} remote row(s) not present locally")
        return True
    print(f"  ❌  {table} delete failed:\n{r.stderr.strip()}")
    return False

def mirror_delete_output(payload):
    """Make the remote row tables mirror the local files: delete remote rows whose
    `sn` is absent locally. Only files actually pushed this run are touched; a
    present-but-empty file is skipped to avoid accidentally wiping a whole table."""
    remote = get("/output?all=1")   # all=1 → full history for a correct diff
    if "files" not in remote:
        print(f"  ⚠   could not read remote for mirror-delete: {remote.get('error', remote)}")
        return False
    ok = True
    for fname, table in TABLE_FOR_FILE.items():
        if fname not in payload:
            continue   # not pushed this run → leave that table untouched
        local_sns = csv_sns(payload[fname])
        if not local_sns:
            print(f"  ⚠   {fname} has no rows — skipping mirror-delete to avoid wiping {table}")
            continue
        to_delete = sorted(csv_sns(remote["files"].get(fname, "")) - local_sns)
        if not to_delete:
            print(f"  —  {table}: remote already matches local (nothing to delete)")
            continue
        if not delete_rows(table, to_delete):
            ok = False
    return ok

def push_output_files(names):
    # records + leakbursts + estimates — via PATCH /output (append-only insert),
    # then mirror-delete so the pushed row tables match the local files exactly.
    section("push · output (" + ", ".join(names) + ")")
    payload = {}
    for n in names:
        c = load(output_path(n))
        if c is None:
            continue
        if n.endswith(".csv"):
            print(f"      → {count_csv_rows(c)} data rows in {n}")
        payload[n] = c
    if not payload:
        print("  —  nothing to push")
        return True
    r = patch("/output", payload)
    if not r.get("ok"):
        print(f"  ❌  output push failed: {r.get('error', r)}")
        return False
    print(f"  ✅  {len(payload)} output file(s) → D1: {', '.join(payload)} "
          f"({r.get('inserted', '?')} insert stmt(s); duplicates skipped)")
    # Mirror-delete only the row tables among the files actually pushed.
    if any(n in TABLE_FOR_FILE for n in payload):
        section("push · mirror (remove remote rows absent locally)")
        return mirror_delete_output(payload)
    return True

def resolve_push_args(tokens):
    """Expand CLI tokens (group names and/or file names) into a concrete file list.
    No tokens → all files. Returns None if any token is unrecognized."""
    if not tokens:
        return list(PUSHABLE)
    out = []
    for t in tokens:
        t = t.lower()
        if t in GROUPS:        out += GROUPS[t]
        elif t in PUSHABLE:    out.append(t)
        else:                  return None
    seen = set()
    return [n for n in out if not (n in seen or seen.add(n))]

def push(names=None):
    """Push a concrete list of file names (None → all), grouped by endpoint.
    Continues through groups on error and reports an overall result."""
    sel = names if names is not None else list(PUSHABLE)
    cfg = [n for n in sel if n == "config.json"]
    st  = [n for n in sel if n in STATUS_FILES]
    out = [n for n in sel if n in OUTPUT_FILES]
    ok = True
    if cfg and not push_config_file():   ok = False
    if st  and not push_status_files(st): ok = False
    if out and not push_output_files(out): ok = False
    print()
    print(f"  ✅  push complete — {', '.join(sel)}" if ok
          else "  ⚠   push finished with errors (see above)")
    return ok

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

def ask_push_targets():
    """Show every pushable file and let the operator pick specific ones.
    Returns the chosen file-name list, or None to cancel."""
    print("\n  Files to push:")
    for i, name in enumerate(PUSHABLE, 1):
        mark = "✓ present" if os.path.exists(local_path(name)) else "· missing"
        print(f"    {i:>2}) {name:<20} {mark}")
    print("     a) all      x) cancel")
    raw = input("  Push which? (numbers e.g. '1,3', 'a', or 'x') [a] ").strip().lower()
    if raw in ("x", "cancel", "q"):
        return None
    if raw in ("", "a", "all"):
        return list(PUSHABLE)
    sel = []
    for tok in re.split(r"[\s,]+", raw):
        if not tok:
            continue
        if tok.isdigit() and 1 <= int(tok) <= len(PUSHABLE):
            sel.append(PUSHABLE[int(tok) - 1])
        elif tok in PUSHABLE:
            sel.append(tok)
        else:
            print(f"  Invalid selection: {tok}")
            return None
    seen = set()
    return [n for n in sel if not (n in seen or seen.add(n))] or None

ACTIONS = {"pull": pull, "verify": verify, "deploy": deploy}   # push is dispatched separately (takes file args)

def menu():
    print("\n  ┌────────────────────────────────────────────┐")
    print("  │             SCADA D1 Seed Tool               │")
    print("  └────────────────────────────────────────────┘")
    print(f"  Worker: {WORKER_URL}")
    print(f"  Files : {rel(SCRIPT_DIR)}/  (config.json, status/, records/)")
    print("  ──────────────────────────────────────────────")
    print("    1)  Pull    download D1 → seed/ files")
    print("    2)  Push    upload seed/ files → D1  (pick individual files)")
    print("    3)  Verify  show D1 row / blob sizes")
    print("    4)  Deploy  wrangler deploy (upsert worker)")
    print("    0)  Exit")
    return input("  Choose: ").strip().lower()

def main():
    # Non-interactive:
    #   seed_d1.py pull|verify|deploy
    #   seed_d1.py push [config|status|output]   (no target → all)
    if len(sys.argv) > 1:
        action = sys.argv[1].lower()
        if action == "push":
            names = resolve_push_args(sys.argv[2:])
            if names is None:
                print("Unknown push target. Groups: " + ", ".join(GROUPS) +
                      " | files: " + ", ".join(PUSHABLE))
                sys.exit(1)
            push(names)
        elif action in ACTIONS:
            ACTIONS[action]()
        else:
            print(f"Unknown action '{action}'. Use: push, {', '.join(ACTIONS)}")
            sys.exit(1)
        return

    # Interactive menu loop.
    while True:
        choice = menu()
        if choice in ("1", "pull"):
            if confirm("Overwrite local seed/ files with D1 contents?"):
                pull()
        elif choice in ("2", "push"):
            names = ask_push_targets()
            if names:   # None = cancelled
                print(f"\n  Will push: {', '.join(names)}")
                if any(n in TABLE_FOR_FILE for n in names):
                    print("  ⚠  records/leakbursts are mirrored — this DELETES remote rows missing locally")
                if confirm("Upload to the live D1 database?"):
                    push(names)
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
