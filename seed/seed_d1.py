#!/usr/bin/env python3
"""
seed_d1.py — Sync SCADA data between local files and the live D1-backed worker,
deploy the worker, and build zone files from a WaterGEMS export.

Usage:
  python3 seed/seed_d1.py            # interactive menu
  python3 seed/seed_d1.py pull                 # download D1 → local files
  python3 seed/seed_d1.py push                 # upload ALL local files → D1
  python3 seed/seed_d1.py push config status   # by group: config | status | output | all
  python3 seed/seed_d1.py push zone_a_status.json records.csv   # by individual file
  python3 seed/seed_d1.py verify               # show D1 row / blob sizes
  python3 seed/seed_d1.py deploy               # wrangler deploy (upserts scada-worker-d1.js)
  python3 seed/seed_d1.py build                # interactive zone builder (xlsx → KML + status)

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
are inserted AND remote rows whose `sn` is absent locally are DELETED. A file
that is selected for push but MISSING locally is deleted from D1 entirely
(blob → its files-table row; CSV → every row of that table). A present-but-empty
CSV is skipped rather than wiping the whole table. (The public worker stays
append-only; only this admin tool deletes, via wrangler.)

The zone builder (menu item 5 / `build`) is built in: it turns a WaterGEMS .xlsx
export into zones/{zone_id}.kml + zones/{zone_id}_status.json, with an optional
KML base file preserving real pipe routes. Every path prompt accepts pasted
paths wrapped in single or double quotation marks.
"""

import csv
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

try:
    import openpyxl
    from openpyxl.utils import get_column_letter
    HAS_OPENPYXL = True
except ImportError:
    HAS_OPENPYXL = False

try:
    from pyproj import Transformer
    HAS_PYPROJ = True
except ImportError:
    HAS_PYPROJ = False

WORKER_URL = "https://scada-visualizer.je1-bd1-raghu.workers.dev"

# All paths are anchored to this script's folder (seed/), so the tool behaves the
# same whether run as `seed/seed_d1.py` from the repo root or `./seed_d1.py`.
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")
STATUS_DIR  = os.path.join(SCRIPT_DIR, "status")
RECORDS_DIR = os.path.join(SCRIPT_DIR, "records")

OUTPUT_FILES = ["records.csv", "leakbursts.csv", "estimates.json"]

# Repo root (one level above seed/): the zone builder drops zones/*.kml and
# zones/*_status.json here, so status discovery looks in BOTH seed/status/
# (where pulls land) and zones/ (where new builds appear).
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
ZONES_DIR = os.path.join(REPO_ROOT, "zones")

# Baseline names kept so known zones stay listed even before their files exist.
_KNOWN_STATUS = [
    "zone_a_status.json",
    "zone_b_status.json",
    "zone_c_status.json",
    "zone_ayeshbag_status.json",
]


def status_path(name: str) -> str:
    return os.path.join(STATUS_DIR, name)


def output_path(name: str) -> str:
    return os.path.join(RECORDS_DIR, name)


def status_source_path(name: str) -> str:
    """Prefer seed/status/ (where pulls land); fall back to zones/ (builder output)."""
    seed = status_path(name)
    zone_ = os.path.join(ZONES_DIR, name)
    if not os.path.exists(seed) and os.path.exists(zone_):
        return zone_
    return seed


def scan_status_files() -> set:
    """Discover every zone_*_status.json in seed/status/ and zones/ so newly
    built zones show up automatically (same pattern the worker whitelists)."""
    names = set()
    for d in (STATUS_DIR, ZONES_DIR):
        if os.path.isdir(d):
            for f in os.listdir(d):
                if re.match(r"^zone_[a-z0-9_-]+_status\.json$", f, re.I):
                    names.add(f)
    return names


def status_files() -> list:
    """Pushable zone status files: the known baseline plus anything discovered."""
    return sorted(set(_KNOWN_STATUS) | scan_status_files())


def pushable_files() -> list:
    return ["config.json", *status_files(), *OUTPUT_FILES]


def push_groups() -> dict:
    return {"all": pushable_files(), "config": ["config.json"],
            "status": status_files(), "output": OUTPUT_FILES}


def local_path(name: str) -> str:
    if name == "config.json": return CONFIG_PATH
    if name in status_files(): return status_source_path(name)
    return output_path(name)

# ── HTTP helpers ──────────────────────────────────────────────────────────────
_USER_AGENT = "scada-seed/1.0"
_HTTP_TIMEOUT = 30


def _http_request(method: str, endpoint: str, body: Optional[dict] = None) -> dict:
    """Shared HTTP helper. Returns parsed JSON or {"error": ..., "ok": False}."""
    url = WORKER_URL + endpoint
    headers = {"User-Agent": _USER_AGENT}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = Request(url, data=data, method=method, headers=headers)
    try:
        with urlopen(req, timeout=_HTTP_TIMEOUT) as r:
            return json.loads(r.read())
    except HTTPError as e:
        return {"error": e.read().decode(), "ok": False}
    except URLError as e:
        return {"error": str(e), "ok": False}


def get(endpoint: str) -> dict:
    """GET an endpoint and return the parsed JSON ({files:{...}} on success)."""
    return _http_request("GET", endpoint)


def patch(endpoint: str, files_dict: dict) -> dict:
    body = {"files": {k: {"content": v} for k, v in files_dict.items()}}
    return _http_request("PATCH", endpoint, body)

# ── File helpers ──────────────────────────────────────────────────────────────
def load(path: str) -> Optional[str]:
    try:
        content = open(path, encoding="utf-8-sig").read()
        badge("LOAD", f"loaded {rel(path)} ({len(content):,} bytes)")
        return content
    except FileNotFoundError:
        badge("SKIP", f"{rel(path)} not found — skipping")
        return None

def save(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    badge("SAVE", f"saved {rel(path)} ({len(content):,} bytes)")

def rel(path) -> str:
    """Show paths relative to cwd when possible, else as-is — just for tidy output."""
    try:    return os.path.relpath(path)
    except ValueError:  return path

def count_csv_rows(text: str) -> int:
    if not text or not text.strip():
        return 0
    return max(0, len([l for l in text.strip().splitlines() if l.strip()]) - 1)

# ── wrangler helpers ──────────────────────────────────────────────────────────
# wrangler runs from SCRIPT_DIR (seed/) so it finds wrangler.toml + the worker
# entry point there. shell=True covers Windows (.cmd shim) and POSIX alike.
def wrangler(argstr: str) -> subprocess.CompletedProcess:
    return subprocess.run(f"wrangler {argstr}", capture_output=True,
                          encoding="utf-8", errors="replace", shell=True, cwd=SCRIPT_DIR)

def wrangler_sql(sql: str) -> subprocess.CompletedProcess:
    """Run SQL via a temp .sql file + --file, so quotes/braces/newlines in JSON
    never touch the shell, and force UTF-8 output (wrangler emits emoji)."""
    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".sql", encoding="utf-8", delete=False)
    try:
        tmp.write(sql); tmp.close()
        return wrangler(f'd1 execute scada-store --remote --file "{tmp.name}"')
    finally:
        os.unlink(tmp.name)

def section(title: str) -> None:
    print()
    print("  " + paint("── ", _fg(CYAN))
          + paint(str(title), _fg(VIOLET), _BOLD) + "  "
          + paint("─" * max(1, 44 - _visible_len(str(title))), _fg(CYAN)))

# ── PULL: D1 → local files ────────────────────────────────────────────────────
def pull() -> None:
    section("pull — config")
    r = get("/config")
    if "files" in r and r["files"].get("config.json") is not None:
        save(CONFIG_PATH, r["files"]["config.json"])
    else:
        badge("ERR", str(r.get("error", r)))

    section("pull — status (→ seed/status/)")
    r = get("/status")
    if "files" in r:
        if r["files"]:
            for name, content in r["files"].items():
                save(status_path(name), content)
        else:
            say("no zone status files in D1")
    else:
        badge("ERR", str(r.get("error", r)))

    section("pull — output (→ seed/records/)")
    r = get("/output?all=1")   # all=1 → full history, not just this month
    if "files" in r:
        for name in OUTPUT_FILES:
            if name in r["files"]:
                content = r["files"][name]
                if name.endswith(".csv"):
                    print("      " + paint("→ ", _fg(CYAN))
                          + paint(f"{count_csv_rows(content)} data rows in {name}",
                                  _fg(SILVER)))
                save(output_path(name), content)
    else:
        badge("ERR", str(r.get("error", r)))

    badge("OK", "pull complete.")

# ── PUSH: local files → D1 ────────────────────────────────────────────────────
# push() takes a concrete list of file names and groups them by endpoint. Each
# pusher returns True on success (or nothing to do) and False on a real failure.

def push_config_file() -> bool:
    # config.json — upserted via wrangler (there is no PATCH /config endpoint).
    section("push · config.json")
    if not os.path.exists(CONFIG_PATH):
        badge("SKIP", f"{rel(CONFIG_PATH)} missing locally — deleting from D1")
        return delete_file_remote("config.json")
    content = load(CONFIG_PATH)
    if content is None:
        badge("ERR", f"could not read {rel(CONFIG_PATH)}")
        return False
    escaped = content.replace("'", "''")   # SQL single-quote escaping
    sql = ("INSERT OR REPLACE INTO files (name, content, updated_at) "
           f"VALUES ('config.json', '{escaped}', datetime('now'));")
    r = wrangler_sql(sql)
    if r.returncode == 0:
        badge("OK", "config.json → D1")
        return True
    badge("ERR", f"config.json failed:\n{r.stderr.strip()}")
    return False

def push_status_files(names: list) -> bool:
    # zone status files — via PATCH /status (whitelisted to zone_*_status.json).
    section("push · status (" + ", ".join(names) + ")")
    payload, missing = {}, []
    for n in names:
        src = status_source_path(n)
        if not os.path.exists(src):
            missing.append(n)
        else:
            payload[n] = load(src)
    ok = True
    for n in missing:
        badge("SKIP", f"{n} missing locally — deleting from D1")
        if not delete_file_remote(n):
            ok = False
    if not payload:
        return ok
    r = patch("/status", payload)
    if r.get("ok"):
        badge("OK", f"{len(payload)} status file(s) → D1: {', '.join(payload)}")
        return ok
    badge("ERR", f"status push failed: {r.get('error', r)}")
    return False

# Row tables (keyed on `sn`) that push mirrors. estimates.json is a full-blob
# replace via PATCH /output, so it needs no row deletion.
TABLE_FOR_FILE = {"records.csv": "records", "leakbursts.csv": "leakbursts"}

def delete_file_remote(name: str) -> bool:
    """Delete a selected file's remote counterpart because it is missing locally.
    Blobs (config/status/estimates) live in the `files` table; the CSV outputs
    live in their row tables, so those are dropped in full (mirror semantics).
    Returns True on success."""
    if not confirm(f"Are you sure you want to delete remote file/table: {name}?"):
        badge("SKIP", f"Deletion of {name} cancelled by operator.")
        return False

    if name in TABLE_FOR_FILE:
        sql = f"DELETE FROM {TABLE_FOR_FILE[name]};"
    else:
        esc = name.replace("'", "''")
        sql = f"DELETE FROM files WHERE name = '{esc}';"
    r = wrangler_sql(sql)
    if r.returncode == 0:
        badge("DEL", f"{name} missing locally — deleted from D1")
        return True
    badge("ERR", f"{name} delete failed:\n{r.stderr.strip()}")
    return False

def csv_sns(text: Optional[str]) -> set:
    """Set of non-empty `sn` values in a CSV string."""
    if not text or not text.strip():
        return set()
    return {(r.get("sn") or "").strip()
            for r in csv.DictReader(io.StringIO(text)) if (r.get("sn") or "").strip()}

def delete_rows(table: str, sns: list) -> bool:
    """DELETE the given sns from a table via wrangler (chunked IN lists)."""
    CHUNK = 200
    stmts = []
    for i in range(0, len(sns), CHUNK):
        vals = ",".join("'" + s.replace("'", "''") + "'" for s in sns[i:i + CHUNK])
        stmts.append(f"DELETE FROM {table} WHERE sn IN ({vals});")
    r = wrangler_sql("\n".join(stmts))
    if r.returncode == 0:
        badge("DEL", f"{table}: deleted {len(sns)} remote row(s) not present locally")
        return True
    badge("ERR", f"{table} delete failed:\n{r.stderr.strip()}")
    return False

def mirror_delete_output(payload: dict) -> bool:
    """Make the remote row tables mirror the local files: delete remote rows whose
    `sn` is absent locally. Only files actually pushed this run are touched; a
    present-but-empty file is skipped to avoid accidentally wiping a whole table."""
    remote = get("/output?all=1")   # all=1 → full history for a correct diff
    if "files" not in remote:
        badge("WARN", f"could not read remote for mirror-delete: {remote.get('error', remote)}")
        return False
    ok = True
    for fname, table in TABLE_FOR_FILE.items():
        if fname not in payload:
            continue   # not pushed this run → leave that table untouched
        local_sns = csv_sns(payload[fname])
        if not local_sns:
            badge("WARN", f"{fname} has no rows — skipping mirror-delete to avoid wiping {table}")
            continue
        to_delete = sorted(csv_sns(remote["files"].get(fname, "")) - local_sns)
        if not to_delete:
            print("  " + paint("— ", _fg(VIOLET), _DIM)
                  + paint(f"{table}: remote already matches local (nothing to delete)",
                          _fg(SILVER), _DIM))
            continue

        preview = ", ".join(to_delete[:5])
        if len(to_delete) > 5:
            preview += f", ... (+{len(to_delete) - 5} more)"
        print("      " + paint("→ ", _fg(CYAN))
              + paint(f"Remote {table} sn(s) to delete: {preview}", _fg(SILVER)))

        if not confirm(f"Are you sure you want to delete {len(to_delete)} row(s) from remote table '{table}'?"):
            badge("SKIP", f"Mirror-deletion of {len(to_delete)} rows in {table} cancelled.")
            ok = False
            continue

        if not delete_rows(table, to_delete):
            ok = False
    return ok

def push_output_files(names: list) -> bool:
    # records + leakbursts + estimates — via PATCH /output (append-only insert),
    # then mirror-delete so the pushed row tables match the local files exactly.
    section("push · output (" + ", ".join(names) + ")")
    payload, missing = {}, []
    for n in names:
        if not os.path.exists(output_path(n)):
            missing.append(n)
            continue
        c = load(output_path(n))
        if c is None:
            continue
        if n.endswith(".csv"):
            print("      " + paint("→ ", _fg(CYAN))
                  + paint(f"{count_csv_rows(c)} data rows in {n}",
                          _fg(SILVER)))
        payload[n] = c
    ok = True
    for n in missing:
        badge("SKIP", f"{n} missing locally — deleting from D1")
        if n in TABLE_FOR_FILE:
            print("      " + paint(f"(drops every remote row in {TABLE_FOR_FILE[n]})",
                                   _fg(CYAN), _DIM))
        if not delete_file_remote(n):
            ok = False
    if not payload:
        return ok
    r = patch("/output", payload)
    if not r.get("ok"):
        badge("ERR", f"output push failed: {r.get('error', r)}")
        return False
    badge("OK", f"{len(payload)} output file(s) → D1: {', '.join(payload)} "
          f"({r.get('inserted', '?')} insert stmt(s); duplicates skipped)")
    # Mirror-delete only the row tables among the files actually pushed.
    if any(n in TABLE_FOR_FILE for n in payload):
        section("push · mirror (remove remote rows absent locally)")
        return mirror_delete_output(payload) and ok
    return ok

def resolve_push_args(tokens: list) -> Optional[list]:
    """Expand CLI tokens (group names and/or file names) into a concrete file list.
    No tokens → all files. Returns None if any token is unrecognized."""
    groups = push_groups()
    all_files = pushable_files()
    if not tokens:
        return all_files
    out = []
    for t in tokens:
        t = t.lower()
        if t in groups:          out += groups[t]
        elif t in all_files:     out.append(t)
        else:                    return None
    seen = set()
    return [n for n in out if not (n in seen or seen.add(n))]

def push(names: Optional[list] = None) -> bool:
    """Push a concrete list of file names (None → all), grouped by endpoint.
    Continues through groups on error and reports an overall result."""
    sel = names if names is not None else pushable_files()
    st_files = set(status_files())
    cfg = [n for n in sel if n == "config.json"]
    st  = [n for n in sel if n in st_files]
    out = [n for n in sel if n in OUTPUT_FILES]
    ok = True
    if cfg and not push_config_file():   ok = False
    if st  and not push_status_files(st): ok = False
    if out and not push_output_files(out): ok = False
    print()
    if ok:
        badge("OK", f"push complete — {', '.join(sel)}")
    else:
        badge("WARN", "push finished with errors (see above)")
    return ok

# ── VERIFY: row counts / blob sizes from D1 ───────────────────────────────────
def verify() -> None:
    section("verify — D1 contents")
    queries = [
        ("records",    "SELECT COUNT(*) AS n FROM records;"),
        ("leakbursts", "SELECT COUNT(*) AS n FROM leakbursts;"),
        ("files",      "SELECT name, length(content) AS bytes FROM files;"),
    ]
    for label, q in queries:
        r = wrangler(f'd1 execute scada-store --remote --command "{q}"')
        if r.returncode == 0:
            badge("OK", f"{label}:\n{r.stdout.strip()}")
        else:
            badge("ERR", f"{label}: {r.stderr.strip()}")
    print()

# ── DEPLOY: upload the worker (scada-worker-d1.js) ────────────────────────────
def deploy() -> None:
    section("deploy — wrangler deploy (scada-worker-d1.js)")
    r = wrangler("deploy")
    print(r.stdout.strip())
    if r.returncode == 0:
        print()
        badge("OK", "worker deployed.")
    else:
        badge("ERR", f"deploy failed:\n{r.stderr.strip()}")

# ══ ZONE BUILDER (merged from build_zone_files.py) ═════════════════════════════
# Turns a WaterGEMS .xlsx export into zones/{zone_id}.kml + _status.json.
# Reads Junction / Reservoir / Pipe sheets (header-driven columns), reprojects
# UTM (Zone 45N) → WGS84, and optionally preserves real pipe routes from a
# base .kml file.

class ZoneBuildError(Exception):
    """A recoverable problem with the conversion — lets the menu continue."""


# ── Builder console styling (ANSI 256-color) ──────────────────────────────────
# Palette tuned to a dark, blue-focused developer-tool feel (JetBrains Mono /
# IBM Plex Sans lineage): electric blue + violet accents, gold highlights.
# All helpers no-op their color codes when stdout is not a TTY or NO_COLOR is set,
# so piped output stays clean.

BLUE     = 75    # primary accent (electric blue)
VIOLET   = 141   # soft lavender — borders, secondary
PURPLE   = 177
MAGENTA  = 213
CYAN     = 80    # info / bullets
GREEN    = 114   # success
GOLD     = 220   # headings, highlights
AMBER    = 214   # warnings
CORAL    = 209   # warm secondary accent
RED      = 204   # errors
SILVER   = 252   # body text
WHITE    = 255

_ESC = "\x1b["
_BOLD = _ESC + "1m"
_DIM  = _ESC + "2m"
_RST  = _ESC + "0m"


def _fg(n: int) -> str:
    return f"{_ESC}38;5;{n}m"


def _console_init() -> None:
    """Enable ANSI support on modern Windows consoles and decide on color."""
    global ENABLE_COLOR
    if os.environ.get("NO_COLOR"):
        ENABLE_COLOR = False
        return
    if os.name == "nt":
        try:
            os.system("")   # turns on virtual terminal processing in cmd/WT
        except Exception:
            pass
    try:
        ENABLE_COLOR = bool(sys.stdout.isatty())
    except Exception:
        ENABLE_COLOR = False


_console_init()


def paint(text, *codes) -> str:
    if not ENABLE_COLOR:
        return str(text)
    return "".join(codes) + str(text) + _RST


def fg(text, n: int) -> str:
    return paint(text, _fg(n))


def bold(text) -> str:
    return paint(text, _BOLD)


def dim(text) -> str:
    return paint(text, _DIM)


def _visible_len(text) -> int:
    return len(re.sub(r"\x1b\[[0-9;]*m", "", str(text)))


def clear_screen() -> None:
    os.system("cls" if os.name == "nt" else "clear")


def badge(kind: str, msg: str) -> None:
    """Colored [LABEL] status line: OK / ERR / WARN / DEL / SKIP / LOAD / SAVE."""
    color = {"OK": GREEN, "ERR": RED, "WARN": AMBER, "DEL": CYAN,
             "SKIP": AMBER, "LOAD": CYAN, "SAVE": VIOLET}[kind]
    text_color = color if kind in ("ERR", "WARN") else SILVER
    print("  " + paint("[" + kind + "]", _BOLD, _fg(color))
          + "  " + paint(msg, _fg(text_color)))


# ── Builder UX helpers ────────────────────────────────────────────────────────
def header(title: str) -> None:
    """Section banner for wizards — gold title between cyan rules."""
    rule()
    print("  " + paint("▸ ", _fg(CYAN), _BOLD)
          + paint(str(title).upper(), _fg(GOLD), _BOLD))
    rule()


def box(lines, width: Optional[int] = None) -> None:
    """Print a bordered box of one or more lines. When the box is a single line
    it reads as a title (gold bold); multi-line boxes render `key : value` rows
    with the key in violet. ANSI codes are excluded from padding math, so the
    left/right borders and the ┌──┐/└──┘ corners always line up."""
    text = [str(l) for l in lines]
    w = width or max(_visible_len(l) for l in text)
    edge = paint("┌" + "─" * (w + 2) + "┐", _fg(VIOLET))
    base = paint("└" + "─" * (w + 2) + "┘", _fg(VIOLET))
    print("  " + edge)
    for l in text:
        visible = _visible_len(l)
        if visible != len(l):
            # Already painted by the caller — pad to w on the right by visible
            # width so the ANSI codes are not counted by ljust.
            body = l + " " * max(0, w - visible)
        elif len(text) == 1:
            body = paint(l.ljust(w), _fg(GOLD), _BOLD)
        elif ":" in l:
            key, _, rest = l.partition(":")
            body = paint(key, _fg(VIOLET), _BOLD) + paint(":", _fg(VIOLET)) \
                   + paint(" " * max(0, w - len(key) - 1 - len(rest)), _fg(SILVER)) \
                   + paint(rest, _fg(SILVER))
        else:
            body = paint(l.ljust(w), _fg(SILVER))
        # One space either side of the body keeps the content row the same
        # width as the dashed top/bottom (w + 2 between the borders).
        print("  " + paint("│", _fg(CYAN))
              + paint(" ", _fg(CYAN)) + body + paint(" ", _fg(CYAN))
              + paint("│", _fg(CYAN)))
    print("  " + base)


def rule(title: str = "") -> None:
    if title:
        print("  " + paint("──", _fg(CYAN)) + "  "
              + paint(str(title), _fg(GOLD), _BOLD) + "  "
              + paint("─" * max(1, 34 - _visible_len(str(title))), _fg(CYAN)))
    else:
        print("  " + paint("─" * 46, _fg(VIOLET), _DIM))


def step(num: int, total: int, title: str) -> None:
    print("")
    print("  " + paint(f"STEP {num}/{total}", _fg(GOLD), _BOLD)
          + "   " + paint(str(title), _fg(CYAN), _BOLD))


def say(msg) -> None:
    print("  " + paint("▸ ", _fg(CYAN)) + paint(str(msg), _fg(SILVER)))


def ok(msg: str) -> None:
    badge("OK", msg)


def warn(msg: str) -> None:
    badge("WARN", msg)


def ask(label: str, default: str = "", required: bool = False, validate=None) -> str:
    """Prompt for a value; Enter uses the default. validate(value) -> error str.
    Accepts pasted paths wrapped in matching single or double quotes."""
    while True:
        line = "  " + paint(str(label), _fg(CYAN), _BOLD)
        if default:
            line += "  " + paint("[" + str(default) + "]", _fg(GOLD), _DIM)
        try:
            raw = input(line + "\n  " + paint("→ ", _fg(GOLD), _BOLD)).strip()
        except EOFError:
            raise SystemExit("\n  Aborted.")
        # Undo copy-paste quoting: "C:\path\file.xlsx" → C:\path\file.xlsx
        if len(raw) >= 2 and raw[0] in ('"', "'") and raw[-1] == raw[0]:
            raw = raw[1:-1]
        value = raw or default
        if required and not value:
            badge("ERR", "Required — please enter a value.")
            continue
        if validate:
            err = validate(value)
            if err:
                badge("ERR", err)
                continue
        return value


def ask_yesno(prompt: str, default: str = "n") -> bool:
    hint = "Y/n" if default.lower().startswith("y") else "y/N"
    while True:
        y, n = hint.split("/")
        shown = (paint(y, _fg(GOLD), _BOLD) + "/" + paint(n, _fg(SILVER), _DIM)
                 if default.lower().startswith("y") else
                 paint(y, _fg(SILVER), _DIM) + "/" + paint(n, _fg(GOLD), _BOLD))
        try:
            raw = input("  " + paint(str(prompt), _fg(CYAN), _BOLD)
                        + " [" + shown + "] "
                        + paint("→ ", _fg(GOLD), _BOLD)).strip().lower()
        except EOFError:
            raise SystemExit("\n  Aborted.")
        if not raw:
            return default.lower().startswith("y")
        if raw in ("y", "yes"):
            return True
        if raw in ("n", "no"):
            return False
        badge("ERR", "Please answer y or n.")


def pick_option(prompt: str, options: list, default: Optional[int] = None) -> int:
    """Numbered menu with an input prompt; returns the 1-based index chosen."""
    print("  " + paint(str(prompt), _fg(CYAN), _BOLD))
    for i, opt in enumerate(options, 1):
        num = paint(f"{i})", _BOLD, _fg(GOLD))
        mark = "  " + paint("(default)", _fg(GOLD), _DIM) if default == i else ""
        print("    " + num + "  " + paint(str(opt), _fg(SILVER)) + mark)
    hint = str(default) if default else "1-" + str(len(options))
    while True:
        try:
            raw = input("  " + paint("→", _fg(GOLD), _BOLD)
                        + " [" + paint(hint, _fg(GOLD), _DIM) + "]: ").strip()
        except EOFError:
            raise SystemExit("\n  Aborted.")
        if not raw and default:
            return default
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return int(raw)
        badge("ERR", "Invalid choice — pick a number from the list.")


def banner() -> None:
    """SCADA block logo with a warm→cool horizontal gradient."""
    art = [
        "██████╗  ██████╗   █████╗  ██████╗   █████╗",
        "██╔═══╝ ██╔════╝  ██╔══██╗ ██╔══██╗  ██╔══██╗",
        "██████╗  ██║  ███╗ ███████║ ██║  ██║  ███████║",
        "╚════██╗ ██║   ██║ ██╔══██║ ██║  ██║  ██╔══██║",
        "██████╔╝ ╚██████╔╝ ██║  ██║ ██████╔╝  ██║  ██║",
        "╚═════╝   ╚═════╝  ╚═╝  ╚═╝ ╚═════╝   ╚═╝  ╚═╝",
    ]
    pal = [GOLD, AMBER, CORAL, MAGENTA, PURPLE, VIOLET, CYAN, BLUE]
    idx = 0
    for row in art:
        out = []
        for ch in row:
            if ch == " ":
                out.append(" ")
            else:
                out.append(paint(ch, _fg(pal[idx % len(pal)])))
                idx += 1
        print("  " + "".join(out))
    tag = (paint("watergems xlsx export", _fg(CYAN), _DIM)
           + "   " + paint("→", _fg(GOLD), _BOLD) + "   "
           + paint("zones/{zone_id}.kml", _fg(WHITE), _BOLD) + "  +  "
           + paint("{zone_id}_status.json", _fg(WHITE), _BOLD))
    print("  " + tag)


# ── Builder defaults ──────────────────────────────────────────────────────────
DEFAULT_SOURCE_CRS = "EPSG:32645"   # UTM Zone 45N (West Bengal, India)
DEFAULT_TARGET_CRS = "EPSG:4326"    # WGS84
DEFAULT_ZONE_ID    = "zone_ayeshbag"
DEFAULT_ZONE_NAME  = "Ayeshbag Distribution"
DEFAULT_OUTPUT_DIR = "zones"
STATUS_MODES       = ("blank", "basic")


# ── Builder dependencies ──────────────────────────────────────────────────────
def _module_available(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def dependency_report() -> list:
    """Show a numbered status table of every dependency. Returns the checks."""
    checks = [
        ("openpyxl", "reads the WaterGEMS .xlsx", _module_available("openpyxl"), "required"),
        ("pyproj",   "UTM → WGS84 reprojection",   _module_available("pyproj"),   "recommended"),
    ]
    print()
    for i, (name, purpose, present, tag) in enumerate(checks, 1):
        num = paint(f"{i})", _BOLD, _fg(GOLD))
        nm = name.ljust(11)
        mark = (paint("[OK]", _BOLD, _fg(GREEN)) if present
                else paint("[missing]", _BOLD, _fg(AMBER)))
        print(f"    {num}  {nm}{purpose.ljust(30)}{mark}  ({tag})")
    return checks


def setup_dependencies() -> int:
    """Install the Python dependencies the builder needs.

    Always installs: openpyxl (required to read the WaterGEMS export).
    Installs if missing: pyproj (accurate UTM→WGS84 reprojection).

    Returns 0 on success, non-zero on failure.
    """
    targets = []
    if not _module_available("openpyxl"):
        targets.append("openpyxl")
    if not _module_available("pyproj"):
        targets.append("pyproj>=3.0")

    if not targets:
        print("    All Python dependencies already satisfied.")
    else:
        print("    Installing: " + ", ".join(targets))
        result = subprocess.call([sys.executable, "-m", "pip", "install", *targets])
        if result != 0:
            return result
    return 0


# ── Builder pipe-geometry helpers (KML base file) ─────────────────────────────
def _load_kml_paths(geometry_path: str) -> tuple:
    """Load every <LineString> from a KML file.

    Returns (paths, names): paths is a list of [(lat, lng), ...] vertex tuples
    in WGS84 (exactly as stored in the KML); names is a parallel list of the
    owning placemark <name> ('' when absent). Raises FileNotFoundError for a
    bad path; returns ([], []) on parse errors (caller warns). Handles both
    namespaced and bare KML tags.
    """
    if not geometry_path:
        return [], []

    path = Path(geometry_path)
    if not path.exists():
        raise FileNotFoundError(f"Geometry file not found: {geometry_path}")

    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as e:
        warn(f"could not parse geometry file {geometry_path}: {e}")
        return [], []

    def local(end):
        return end.rsplit("}", 1)[-1]

    paths, names = [], []
    for pm in root.iter():
        if local(pm.tag) != "Placemark":
            continue
        name = ""
        for c in pm:
            if local(c.tag) == "name":
                name = (c.text or "").strip()
                break
        for child in pm.iter():
            if local(child.tag) != "LineString":
                continue
            for coord_el in child:
                if local(coord_el.tag) != "coordinates" or not coord_el.text:
                    continue
                pts = []
                for tok in coord_el.text.split():
                    parts = tok.split(",")
                    if len(parts) < 2:
                        continue
                    try:
                        lng, lat = float(parts[0]), float(parts[1])
                    except ValueError:
                        continue
                    pts.append((lat, lng))
                if len(pts) >= 2:
                    paths.append(pts)
                    names.append(name)

    return paths, names


def _euclid(ax, ay, bx, by) -> float:
    return ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5


def _match_pipes_by_endpoints(edges, node_utms, polylines) -> dict:
    """Greedy-match line geometries to pipes by endpoint distance.

    edges:      list of {id, source, target}
    node_utms:  {node_id: (x, y)}
    polylines:  list of [(x, y), ...]

    Returns {edge_id: [(x, y), ...]}. A pipe that gets no match is simply
    absent. Distance is measured between the polyline's first/last vertex and
    the pipe's source/target node coordinates (tried both orientations).
    """
    if not polylines:
        return {}

    src_utm = {}
    tgt_utm = {}
    for e in edges:
        s = node_utms.get(e["source"])
        t = node_utms.get(e["target"])
        if s and t:
            src_utm[e["id"]] = s
            tgt_utm[e["id"]] = t

    candidates = []   # (cost, edge_id, poly_index, poly)
    for idx, pl in enumerate(polylines):
        first = pl[0]
        last  = pl[-1]
        for eid in src_utm:
            s_pos = src_utm[eid]
            t_pos = tgt_utm[eid]
            cost_fwd = _euclid(*first, *s_pos) + _euclid(*last, *t_pos)
            cost_rev = _euclid(*first, *t_pos) + _euclid(*last, *s_pos)
            candidates.append((min(cost_fwd, cost_rev), eid, idx, pl))

    candidates.sort(key=lambda c: c[0])

    matched = {}
    used_polys = set()
    for cost, eid, idx, pl in candidates:
        if eid in matched or idx in used_polys:
            continue
        matched[eid] = pl
        used_polys.add(idx)

    return matched


def _match_pipes(edges, node_utms, polylines, names=None) -> dict:
    """Match polylines to pipes — by placemark <name> first, then (for the
    lines and edges still unmatched) by endpoint proximity.

    edges:      list of {id, source, target}
    node_utms:  {node_id: (x, y)}
    polylines:  list of [(x, y), ...]  (source projected CRS)
    names:      placemark names parallel to polylines ('' when absent)

    Returns {edge_id: [(x, y), ...]}. A pipe that gets no match simply keeps
    a straight line. When a placemark <name> equals a pipe id, that polyline
    is used directly; otherwise the first/last vertices are matched against
    the pipe's source/target node coordinates (both orientations).
    """
    if not polylines:
        return {}

    matched = {}
    used_polys = set()

    if names:
        by_name = {}
        for idx, name in enumerate(names):
            if name and name not in by_name:
                by_name[name] = idx
        for e in edges:
            idx = by_name.get(e["id"])
            if idx is not None and idx not in used_polys:
                matched[e["id"]] = polylines[idx]
                used_polys.add(idx)

    remaining_polys = [pl for i, pl in enumerate(polylines) if i not in used_polys]
    remaining_edges = [e for e in edges if e["id"] not in matched]
    matched.update(_match_pipes_by_endpoints(remaining_edges, node_utms, remaining_polys))

    return matched


# ── Builder sheet reading (header-driven columns) ─────────────────────────────
def _resolve_cols(ws, spec: list) -> dict:
    """Map logical fields to column letters by reading the sheet header row.

    spec: list of (field, [header-synonyms incl. "x"/"easting"], fallback letter).
    A synonym found in row 1 wins; otherwise the legacy fallback letter is used
    (for headerless exports or unfamiliar header names).
    """
    header = next(ws.iter_rows(min_row=1, max_row=1, values_only=True))
    lookup = {}
    for i, h in enumerate(header, 1):
        key = str(h).strip().lower() if h is not None else ""
        if key and key not in lookup:
            lookup[key] = get_column_letter(i)

    cols = {}
    for field, synonyms, fallback in spec:
        found = next((lookup[s] for s in synonyms if s.lower() in lookup), None)
        cols[field] = found or fallback
    return cols


def _rows_since_header(ws):
    """Yield each data row as {column_letter: value} for non-empty cells."""
    for row in ws.iter_rows(min_row=2, values_only=False):
        yield {c.column_letter: c.value for c in row if c.value is not None}


def _read_sheet_nodes(ws, col_spec: list, label: str) -> dict:
    """Read node coordinates from a worksheet. Returns {id: {x, y, elevation}}."""
    nodes = {}
    cols = _resolve_cols(ws, col_spec)
    for d in _rows_since_header(ws):
        elem = d.get(cols["elem"])
        if not elem:
            continue
        x_raw, y_raw = d.get(cols["east"]), d.get(cols["north"])
        if x_raw is not None and y_raw is not None:
            nodes[str(elem)] = {"x": float(x_raw), "y": float(y_raw),
                                "elevation": d.get(cols["elev"])}
    ok(f"{label} with coordinates: {len(nodes)}")
    return nodes


def _write_kml(kml_path: Path, zone_name: str, nodes_latlng: dict,
               edges: list, matched_paths: dict, to_latlng) -> None:
    """Write a KML file with node Points and edge LineStrings."""
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2">',
        '<Document>',
        f'  <name>{zone_name}</name>',
    ]
    for nid, ll in nodes_latlng.items():
        elev = ll.get("elevation")
        elev_str = f',{elev}' if elev is not None else ''
        lines.extend([
            '  <Placemark>',
            f'    <name>{nid}</name>',
            '    <ExtendedData>',
            f'      <Data name="id"><value>{nid}</value></Data>',
            '    </ExtendedData>',
            '    <Point>',
            f'      <coordinates>{ll["lng"]},{ll["lat"]}{elev_str}</coordinates>',
            '    </Point>',
            '  </Placemark>',
        ])
    for e in edges:
        src_ll = nodes_latlng.get(e["source"], {})
        tgt_ll = nodes_latlng.get(e["target"], {})
        if not src_ll or not tgt_ll:
            continue
        path = matched_paths.get(e["id"])
        if path:
            waypoints = [to_latlng(x, y) for x, y in path]
        else:
            waypoints = [(src_ll["lat"], src_ll["lng"]),
                         (tgt_ll["lat"], tgt_ll["lng"])]
        lines.extend([
            '  <Placemark>',
            f'    <name>{e["id"]}</name>',
            '    <ExtendedData>',
            f'      <Data name="id"><value>{e["id"]}</value></Data>',
            f'      <Data name="source"><value>{e["source"]}</value></Data>',
            f'      <Data name="target"><value>{e["target"]}</value></Data>',
            '    </ExtendedData>',
            '    <LineString>',
            '      <coordinates>',
            *[f'        {lng},{lat}' for lat, lng in waypoints],
            '      </coordinates>',
            '    </LineString>',
            '  </Placemark>',
        ])
    lines.extend(['</Document>', '</kml>'])
    kml_path.write_text("\n".join(lines), encoding="utf-8")
    ok(f"Wrote {kml_path}  ({len(nodes_latlng)} points, {len(edges)} linestrings)")


def _write_zone_status(status_path: Path, zone_id: str, status_mode: str,
                       nodes_latlng: dict, node_kind: dict, edges: list) -> None:
    """Write the zone status JSON file (gist-backed status seed)."""
    entries = []
    for nid in nodes_latlng:
        if status_mode == "basic":
            is_reservoir = node_kind.get(nid) == "reservoir"
            entries.append({
                "id": nid,
                "label": nid,
                "type": "zone" if is_reservoir else "",
                "state": "ON" if is_reservoir else "OFF",
                "comment": "",
            })
        else:
            entries.append({
                "id": nid, "label": "", "type": "",
                "state": "", "comment": "",
            })
    for e in edges:
        entries.append({"id": e["id"], "flow": ""})
    status_path.write_text(
        "[\n" + ",\n".join(f"  {json.dumps(s)}" for s in entries) + "\n]",
        encoding="utf-8",
    )
    ok(f"Wrote {status_path}  ({len(entries)} entries, mode={status_mode})")


def _load_pipe_geometry(geometry_path: str, edges: list,
                       all_nodes_raw: dict, source_crs: str) -> tuple:
    """Load a KML base file, reproject to source CRS, and match to pipes.

    Returns (matched_paths, load_failed) where matched_paths is
    {edge_id: [(x, y), ...]} in source CRS coordinates.
    """
    paths, names, load_failed = [], [], False

    if Path(geometry_path).suffix.lower() != ".kml":
        warn("Pipe geometry must be a .kml file — ignoring the path.")
        return {}, True

    try:
        paths, names = _load_kml_paths(geometry_path)
        if paths and not HAS_PYPROJ:
            warn("KML geometry needs pyproj to reproject into the source "
                 "CRS — pipes will use straight lines.")
            return {}, True
        if paths:
            rev = Transformer.from_crs(DEFAULT_TARGET_CRS, source_crs, always_xy=True)
            paths = [[rev.transform(lng, lat) for (lat, lng) in path] for path in paths]
    except FileNotFoundError as e:
        warn(f"{e} — pipes will use straight lines.")
        return {}, True

    if not paths:
        return {}, False

    node_utms = {nid: (n["x"], n["y"]) for nid, n in all_nodes_raw.items()}
    matched = _match_pipes(edges, node_utms, paths, names)
    ok(f"Pipe geometry (KML): {len(paths)} lines loaded, "
       f"{len(matched)} pipes matched to a bent path")
    if len(matched) < len(edges):
        warn(f"{len(edges) - len(matched)} pipes have no "
             "matching geometry — straight lines will be used.")
    if len(matched) < len(paths):
        warn(f"{len(paths) - len(matched)} geometry lines "
             "did not match any pipe and were ignored.")
    return matched, False


# ── Builder core conversion ───────────────────────────────────────────────────
def build_zone_files(
    xlsx_path: str,
    zone_id: str = DEFAULT_ZONE_ID,
    zone_name: str = DEFAULT_ZONE_NAME,
    source_crs: str = DEFAULT_SOURCE_CRS,
    output_dir: str = DEFAULT_OUTPUT_DIR,
    status_mode: str = "blank",
    geometry_path: str = None,
) -> tuple:
    """Main conversion function. Returns (status_path, kml_path)."""
    if status_mode not in STATUS_MODES:
        raise ZoneBuildError(
            f"status mode must be one of {', '.join(STATUS_MODES)} (got {status_mode!r})")

    wb = openpyxl.load_workbook(xlsx_path, data_only=True)

    # ── Set up coordinate transformer ───────────────────────────────────
    transformer = None
    if HAS_PYPROJ:
        transformer = Transformer.from_crs(source_crs, DEFAULT_TARGET_CRS, always_xy=True)
        say(f"Coordinate transform: {source_crs} -> {DEFAULT_TARGET_CRS}")
    else:
        warn("pyproj not installed — coordinates will be raw Easting/Northing.")

    # ── Read junctions ──────────────────────────────────────────────────
    junctions = _read_sheet_nodes(wb["Junction"], [
        ("elem",  ["element", "label"], "A"),
        ("east",  ["x", "easting"],     "AJ"),
        ("north", ["y", "northing"],    "AK"),
        ("elev",  ["elevation"],        "S"),
    ], "Junctions")

    # ── Read reservoirs ─────────────────────────────────────────────────
    reservoirs = _read_sheet_nodes(wb["Reservoir"], [
        ("elem",  ["element", "label"], "A"),
        ("east",  ["x", "easting"],     "N"),
        ("north", ["y", "northing"],    "O"),
        ("elev",  ["elevation"],        "J"),
    ], "Reservoirs")

    # ── Merge all nodes, remembering provenance ─────────────────────────
    node_kind = {}   # nid -> 'junction' | 'reservoir'
    all_nodes_raw = {}
    for nid, coords in junctions.items():
        all_nodes_raw[nid] = coords
        node_kind[nid] = "junction"
    for nid, coords in reservoirs.items():
        all_nodes_raw[nid] = coords
        node_kind[nid] = "reservoir"

    if not all_nodes_raw:
        raise ZoneBuildError("No nodes with coordinates found in the workbook.")

    # ── Convert coordinates to WGS84 ───────────────────────────────────
    def to_latlng(x, y):
        if transformer:
            lng, lat = transformer.transform(x, y)
            return round(lat, 7), round(lng, 7)
        return y, x   # fallback: treat as lat, lng (wrong but preserves data)

    nodes_latlng = {}
    for nid, coords in all_nodes_raw.items():
        lat, lng = to_latlng(coords["x"], coords["y"])
        nodes_latlng[nid] = {"lat": lat, "lng": lng, "elevation": coords.get("elevation")}
    ok(f"Nodes reprojected: {len(nodes_latlng)}")

    # ── Read pipes (edges) ─────────────────────────────────────────────
    ws_pipe = wb["Pipe"]
    pc = _resolve_cols(ws_pipe, [
        ("elem",  ["element", "label"],      "A"),
        ("start", ["start node", "from node", "start junction"], "AU"),
        ("stop",  ["stop node", "to node", "stop junction"],     "AV"),
    ])
    edges = []
    edge_ids_seen = set()
    for d in _rows_since_header(ws_pipe):
        start = d.get(pc["start"])   # Start Node
        stop = d.get(pc["stop"])     # Stop Node
        elem = d.get(pc["elem"])     # Pipe element name
        if not start or not stop:
            continue
        start, stop = str(start), str(stop)
        # Edge ID: use pipe element name if available, else source-target
        edge_id = str(elem) if elem else f"{start}-{stop}"
        if edge_id in edge_ids_seen:
            edge_id = f"{start}-{stop}"   # deduplicate
        edge_ids_seen.add(edge_id)
        edges.append({
            "id": edge_id,
            "source": start,
            "target": stop,
        })

    ok(f"Edges (pipes): {len(edges)}")

    # ── Validate connectivity ───────────────────────────────────────────
    node_ids = set(nodes_latlng.keys())
    orphan_edges = []
    for e in edges:
        if e["source"] not in node_ids:
            orphan_edges.append(f"  {e['id']}: source '{e['source']}' not in nodes")
        if e["target"] not in node_ids:
            orphan_edges.append(f"  {e['id']}: target '{e['target']}' not in nodes")
    if orphan_edges:
        warn(f"{len(orphan_edges)} edges reference missing nodes:")
        for o in orphan_edges[:20]:
            print("  " + paint("· " + o.strip(), _fg(RED)), file=sys.stderr)
        if len(orphan_edges) > 20:
            print("  " + paint(f"  ... and {len(orphan_edges) - 20} more",
                               _fg(RED)), file=sys.stderr)

    # ── Optional pipe geometry (bends) from a KML base file ──────────────
    matched_paths = {}   # edge_id -> [(x, y), ...] in source CRS
    if geometry_path:
        matched_paths, load_failed = _load_pipe_geometry(
            geometry_path, edges, all_nodes_raw, source_crs)
        if not matched_paths and not load_failed:
            warn("geometry file yielded no line features — pipes will use "
                 "straight lines.")
        elif load_failed:
            geometry_path = None

    # ── Output: KML + status JSON ─────────────────────────────────────
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    kml_path = out_dir / f"{zone_id}.kml"
    _write_kml(kml_path, zone_name, nodes_latlng, edges, matched_paths, to_latlng)

    status_path = out_dir / f"{zone_id}_status.json"
    _write_zone_status(status_path, zone_id, status_mode, nodes_latlng, node_kind, edges)

    return status_path, kml_path


# ── Builder wizards ───────────────────────────────────────────────────────────
def wizard_setup() -> None:
    header("Setup / check dependencies")
    checks = dependency_report()
    py_missing = [n for n, _, present, _ in checks if not present]

    if py_missing:
        if ask_yesno("Install the missing Python packages with pip?"):
            result = setup_dependencies()
            if result == 0:
                ok("Dependency setup finished.")
            else:
                warn("pip install failed — check the output above.")
        else:
            say("Skipped. You can still continue; installs are optional.")
    else:
        ok("All dependencies are already in place.")


def _validate_xlsx(path: str) -> Optional[str]:
    p = Path(path)
    if not p.exists():
        return f"Not found: {path}"
    if p.suffix.lower() not in (".xlsx", ".xlsm"):
        return "That does not look like an Excel file (.xlsx expected)."
    return None


def wizard_convert() -> None:
    header("Convert xlsx \u2192  KML + status files")
    if not HAS_OPENPYXL:
        warn("openpyxl is not installed — it is required to read the xlsx.")
        say("Choose 'Setup dependencies' from the main menu first.")
        return

    total = 6

    step(1, total, "WaterGEMS Excel file")
    xlsx_path = ask("Path to the WaterGEMS xlsx export", required=True,
                    validate=_validate_xlsx)

    step(2, total, "Zone identity")
    zone_id = ask("Zone ID", DEFAULT_ZONE_ID)
    zone_name = ask("Zone display name", DEFAULT_ZONE_NAME)

    step(3, total, "Coordinates")
    source_crs = ask("Source CRS", DEFAULT_SOURCE_CRS)
    if HAS_PYPROJ:
        say(f"Target is fixed at {DEFAULT_TARGET_CRS} (WGS84).")
    else:
        warn("pyproj not installed — coordinates will be kept as raw "
             "Easting/Northing. Install pyproj for proper reprojection.")

    step(4, total, "Output location")
    output_dir = ask("Output directory", DEFAULT_OUTPUT_DIR)

    step(5, total, "Status mode")
    mode_idx = pick_option("How should the zone status file be seeded?", [
        "blank  — empty attributes; labels/states filled in later",
        "basic  — seeded from the xlsx (reservoirs \u2192 zone/ON, else OFF)",
    ], default=1)
    status_mode = STATUS_MODES[mode_idx - 1]

    step(6, total, "Optional pipe geometry")
    geometry_path = ask("Path to a base KML with real pipe routes "
                        "(.kml — Enter to skip \u2192 straight lines)",
                        "").strip() or None
    if geometry_path and not Path(geometry_path).exists():
        warn(f"Geometry file not found: {geometry_path} — ignoring it.")
        geometry_path = None

    rule("Summary")
    box([
        f"xlsx        : {xlsx_path}",
        f"zone id     : {zone_id}",
        f"zone name   : {zone_name}",
        f"source CRS  : {source_crs}",
        f"output dir  : {output_dir}",
        f"status mode : {status_mode}",
        "geometry    : " + (geometry_path or "(none \u2014 straight pipe lines)"),
    ])
    if not ask_yesno("Run the conversion now?", default="y"):
        say("Cancelled — back to the main menu.")
        return

    try:
        status_path, kml_path = build_zone_files(
            xlsx_path=xlsx_path,
            zone_id=zone_id,
            zone_name=zone_name,
            source_crs=source_crs,
            output_dir=output_dir,
            status_mode=status_mode,
            geometry_path=geometry_path,
        )
    except ZoneBuildError as e:
        warn(str(e))
        return
    except KeyError as e:
        warn(f"Workbook is missing an expected sheet/column: {e}")
        return

    rule("Done")
    box([f"KML    : {kml_path}", f"Status : {status_path}"])
    input("  " + paint("→", _fg(GOLD), _BOLD)
          + "  press Enter to return to the main menu.")


def wizard_help() -> None:
    header("Help — how this tool works")
    help_sections = [
        ("1 · Setup dependencies",
         ["Installs / verifies what the tool needs:",
          "openpyxl  (required)       reads the WaterGEMS .xlsx",
          "pyproj    (recommended)    accurate UTM → WGS84 reprojection"]),
        ("2 · Convert xlsx → zones",
         ["A guided 6-step conversion that ends in two files per zone:",
          "zones/{zone_id}.kml          points for nodes, lines for pipes",
          "zones/{zone_id}_status.json  initial status (gist seed)",
          "Coordinates are UTM Zone 45N (Easting/Northing) by default and",
          "are reprojected to WGS84 lat/lng for KML."]),
        ("3 · Status modes",
         ["blank — every label/type/state starts empty; you fill in later.",
          "basic — seeded from the workbook: reservoirs become type \"zone\"",
          "        with state ON; junctions/pipe lines start blank/OFF."]),
        ("4 · Pipe geometry",
         ["WaterGEMS only knows the straight start→end line per pipe. Give a",
          "base .kml file with the real routes. Each line is matched to a pipe",
          "— by placemark <name> first, then by endpoint distance — and",
          "matched pipes are drawn with their full bent path."]),
    ]
    for head, body in help_sections:
        print()
        say_head = paint("  " + head, _fg(GOLD), _BOLD)
        print(say_head)
        for line in body:
            print(dim("    " + line))
    print()
    tip = paint("tip: press Ctrl+C at any prompt to cancel.", _fg(CYAN), _DIM)
    print("  " + tip)
    input("  " + paint("→", _fg(GOLD), _BOLD)
          + "  press Enter to return to the main menu.")


def zone_builder_main() -> None:
    while True:
        banner()
        rule()
        choice = pick_option("What would you like to do?", [
            "Setup dependencies",
            "Convert xlsx \u2192 KML + status files",
            "Help",
            "Exit",
        ], default=1)
        if choice == 1:
            wizard_setup()
        elif choice == 2:
            wizard_convert()
        elif choice == 3:
            wizard_help()
        else:
            print()
            print("  " + paint("bye — see you, operator.", _fg(VIOLET), _DIM))
            break


# ── Console UX ────────────────────────────────────────────────────────────────
def confirm(msg: str) -> bool:
    try:
        raw = input("  " + paint(str(msg), _fg(CYAN), _BOLD) + " ["
                    + paint("y", _fg(GOLD), _BOLD) + "/"
                    + paint("N", _fg(SILVER), _DIM) + "] "
                    + paint("→ ", _fg(GOLD), _BOLD)).strip().lower()
    except EOFError:
        raise SystemExit()
    return raw in ("y", "yes")

def ask_push_targets() -> Optional[list]:
    """Show every pushable file and let the operator pick specific ones.
    Returns the chosen file-name list, or None to cancel."""
    files = pushable_files()
    print("\n  " + paint("Files to push:", _fg(CYAN), _BOLD))
    for i, name in enumerate(files, 1):
        if os.path.exists(local_path(name)):
            mark = paint("✓ present", _fg(GREEN), _BOLD)
        else:
            mark = paint("· missing", _fg(AMBER), _DIM)
        num = paint(f"{i:>2})", _BOLD, _fg(GOLD))
        print(f"    {num} {paint(name.ljust(20), _fg(SILVER))} {mark}")
    print("     a) all      x) cancel")
    raw = input("  Push which? (numbers e.g. '1,3', 'a', or 'x') [a] ").strip().lower()
    if raw in ("x", "cancel", "q"):
        return None
    if raw in ("", "a", "all"):
        return files
    sel = []
    for tok in re.split(r"[\s,]+", raw):
        if not tok:
            continue
        if tok.isdigit() and 1 <= int(tok) <= len(files):
            sel.append(files[int(tok) - 1])
        elif tok in files:
            sel.append(tok)
        else:
            badge("ERR", f"invalid selection: {tok}")
            return None
    seen = set()
    return [n for n in sel if not (n in seen or seen.add(n))] or None

ACTIONS = {"pull": pull, "verify": verify, "deploy": deploy}   # push is dispatched separately (takes file args)

_MENU_ITEMS = [
    ("Pull",   "download D1 → seed/ files"),
    ("Push",   "upload seed/ files → D1 (pick individual files)"),
    ("Verify", "show D1 row / blob sizes"),
    ("Deploy", "wrangler deploy (upsert worker)"),
    ("Build",  "WaterGEMS xlsx → zones (KML + status)"),
]


def menu() -> str:
    print()
    box(["   SCADA D1 SEED TOOL   ",
         "  seed/config.json  ·  status/  ·  records/"])
    print("  " + paint("worker ", _fg(VIOLET), _BOLD) + paint(WORKER_URL, _fg(SILVER)))
    print("  " + paint("files  ", _fg(VIOLET), _BOLD)
          + paint(rel(SCRIPT_DIR) + "/", _fg(SILVER)))
    print()
    for i, (label, desc) in enumerate(_MENU_ITEMS, 1):
        num = paint(f"{i})", _BOLD, _fg(GOLD))
        print("    " + num + "  " + paint(label.ljust(7), _fg(CYAN), _BOLD)
              + paint(desc, _fg(SILVER)))
    print("    0)  " + paint("Exit", _fg(CYAN), _BOLD))
    print("    c)  " + paint("Clear console", _fg(CYAN), _BOLD))
    try:
        return input("  " + paint("→", _fg(GOLD), _BOLD) + " : ").strip().lower()
    except EOFError:
        raise SystemExit()

def main() -> None:
    # Non-interactive:
    #   seed_d1.py pull|verify|deploy|build
    #   seed_d1.py push [config|status|output]   (no target → all)
    if len(sys.argv) > 1:
        action = sys.argv[1].lower()
        if action == "push":
            names = resolve_push_args(sys.argv[2:])
            if names is None:
                print("Unknown push target. Groups: " + ", ".join(push_groups()) +
                      " | files: " + ", ".join(pushable_files()))
                sys.exit(1)
            push(names)
        elif action == "build":
            zone_builder_main()
        elif action in ACTIONS:
            ACTIONS[action]()
        else:
            print(f"Unknown action '{action}'. Use: push, build, {', '.join(ACTIONS)}")
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
                    badge("WARN", "records/leakbursts are mirrored — this DELETES "
                          "remote rows missing locally")
                if confirm("Upload to the live D1 database?"):
                    push(names)
        elif choice in ("3", "verify"):
            verify()
        elif choice in ("4", "deploy"):
            if confirm("Deploy the worker to Cloudflare?"):
                deploy()
        elif choice in ("5", "build"):
            zone_builder_main()
        elif choice in ("c", "clear"):
            clear_screen()
        elif choice in ("0", "q", "quit", "exit"):
            print("  " + paint("bye — see you, operator.", _fg(VIOLET), _DIM))
            break
        elif choice == "":
            continue   # empty Enter → redraw the menu instead of quitting
        else:
            print("  Invalid choice — pick 1, 2, 3, 4, 5, c=clear or 0.")

if __name__ == "__main__":
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        main()
    except KeyboardInterrupt:
        print("\n  Cancelled.")
