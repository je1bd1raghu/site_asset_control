#!/usr/bin/env python3
"""
SCADA Zone Builder — interactive WaterGEMS (.xlsx) → SCADA zone KML + status.

Fully interactive and menu-driven — there are NO command-line flags. Run:

    python build_zone_files.py

and the tool walks you through everything with numbered prompts:

    1)  Setup dependencies   (install / verify openpyxl, pyproj)
    2)  Convert xlsx → zones (guided step-by-step conversion)
    3)  Help                 (how it works, status modes, pipe geometry)
    4)  Exit

Reads the Junction, Reservoir, and Pipe sheets from the Excel file, converts
projected coordinates (Easting/Northing in UTM Zone 45N) to WGS84 lat/lng, and
writes:
    zones/{zone_id}.kml           — KML with Point + LineString features
    zones/{zone_id}_status.json   — initial status (gist seed)

Requirements
    openpyxl   required     — reads the WaterGEMS Excel export
    pyproj     recommended  — accurate UTM (Zone 45N) → WGS84 reprojection

Status modes (chosen during conversion)
    blank   — empty attributes (label/type/state all blank)          [default]
    basic   — populated from the xlsx: reservoirs → type "zone", state ON;
              junctions → type blank, state OFF; pipes → flow blank.
              Labels come from the WaterGEMS element names.

Optional pipe geometry
    WaterGEMS only knows the straight start→end line per pipe. If you have a
    base KML file showing the real pipe routes with bends, pass it (an
    unpacked .kml — LineStrings only — or a .geojson) during the conversion.
    KML lines are reprojected from WGS84 into the source CRS, then each line
    is matched to a pipe — first by the placemark <name> matching the pipe id,
    then by endpoint proximity against the xlsx pipe start/stop node
    Easting/Northing. Matched pipes keep their full vertex path; everything
    else falls back to a straight start→end line.
"""

import importlib.util
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    import openpyxl
    HAS_OPENPYXL = True
except ImportError:
    HAS_OPENPYXL = False

try:
    from pyproj import Transformer
    HAS_PYPROJ = True
except ImportError:
    HAS_PYPROJ = False


# ── Defaults (used as prompt defaults, not flags) ────────────────────────────
DEFAULT_SOURCE_CRS = "EPSG:32645"   # UTM Zone 45N (West Bengal, India)
DEFAULT_TARGET_CRS = "EPSG:4326"    # WGS84
DEFAULT_ZONE_ID    = "zone_ayeshbag"
DEFAULT_ZONE_NAME  = "Ayeshbag Distribution"
DEFAULT_OUTPUT_DIR = "zones"
STATUS_MODES       = ("blank", "basic")


class ZoneBuildError(Exception):
    """A recoverable problem with the conversion — lets the menu continue."""


# ── Terminal UX helpers ───────────────────────────────────────────────────────
def clear_screen():
    """Clear the console so each screen starts fresh."""
    if os.name == "nt":
        os.system("cls")
    else:
        os.system("clear")


def box(lines, width=None):
    """Print a bordered box of one or more centered-left lines."""
    text = [str(l) for l in lines]
    w = width or max(len(l) for l in text)
    print("  ┌" + "─" * (w + 2) + "┐")
    for l in text:
        print("  │ " + l.ljust(w) + " │")
    print("  └" + "─" * (w + 2) + "┘")


def rule(title=""):
    if title:
        print(f"\n  ── {title} " + "─" * max(1, 40 - len(title)))
    else:
        print("  " + "─" * 46)


def step(num, total, title):
    print(f"\n  · Step {num} of {total}: {title}")


def say(msg):
    print(f"  · {msg}")


def ok(msg):
    print(f"  [OK]   {msg}")


def warn(msg):
    print(f"  [WARN] {msg}", file=sys.stderr)


def ask(label, default="", required=False, validate=None):
    """Prompt for a value; Enter uses the default. validate(value) -> error str."""
    while True:
        prompt = f"  {label}"
        if default:
            prompt += f" [{default}]"
        try:
            raw = input(prompt + ": ").strip()
        except EOFError:
            raise SystemExit("\n  Aborted.")
        value = raw or default
        if required and not value:
            print("    Required — please enter a value.")
            continue
        if validate:
            err = validate(value)
            if err:
                print(f"    {err}")
                continue
        return value


def ask_yesno(prompt, default="n"):
    hint = "Y/n" if default.lower().startswith("y") else "y/N"
    while True:
        try:
            raw = input(f"  {prompt} [{hint}] ").strip().lower()
        except EOFError:
            raise SystemExit("\n  Aborted.")
        if not raw:
            return default.lower().startswith("y")
        if raw in ("y", "yes"):
            return True
        if raw in ("n", "no"):
            return False
        print("    Please answer y or n.")


def menu(prompt, options, default=None):
    """Numbered menu with an input prompt; returns the 1-based index chosen."""
    print(f"  {prompt}")
    for i, opt in enumerate(options, 1):
        mark = "  (default)" if default == i else ""
        print(f"    {i})  {opt}{mark}")
    hint = str(default) if default else "1-" + str(len(options))
    while True:
        try:
            raw = input(f"  -> [{hint}]: ").strip()
        except EOFError:
            raise SystemExit("\n  Aborted.")
        if not raw and default:
            return default
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return int(raw)
        print("    Invalid choice — pick a number from the list.")


# ── Dependencies ──────────────────────────────────────────────────────────────
def _module_available(name):
    return importlib.util.find_spec(name) is not None


def dependency_report():
    """Show a numbered status table of every dependency. Returns the checks."""
    checks = [
        ("openpyxl", "reads the WaterGEMS .xlsx", _module_available("openpyxl"), "required"),
        ("pyproj",   "UTM → WGS84 reprojection",   _module_available("pyproj"),   "recommended"),
    ]
    print()
    for i, (name, purpose, present, tag) in enumerate(checks, 1):
        mark = "[OK]" if present else "[missing]"
        print(f"    {i})  {name:<9} {purpose:<28} {mark:<9} ({tag})")
    return checks


def setup_dependencies():
    """Install the Python dependencies this script needs.

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


# ── Pipe geometry helpers (KML / GeoJSON) ─────────────────────────────────────
def _load_geojson_polylines(geometry_path: str):
    """Load every line geometry from a GeoJSON file.

    Returns a list of polylines, each a list of (x, y) vertex tuples in the
    same projected CRS as the xlsx Easting/Northing. For MultiLineString /
    GeometryCollection parts only the longest LineString is kept. Raises
    FileNotFoundError for a bad path; returns [] on parse errors (caller warns).
    """
    if not geometry_path:
        return []

    path = Path(geometry_path)
    if not path.exists():
        raise FileNotFoundError(f"Geometry file not found: {geometry_path}")

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        warn(f"could not parse geometry file {geometry_path}: {e}")
        return []

    polylines = []

    def add_linestring(coords):
        pts = [(float(c[0]), float(c[1])) for c in coords]
        if len(pts) >= 2:
            polylines.append(pts)

    features = data.get("features") if isinstance(data, dict) else None
    if features is not None:
        for feat in features:
            geom = feat.get("geometry") if isinstance(feat, dict) else None
            if not geom:
                continue
            gtype = geom.get("type")
            coords = geom.get("coordinates")
            if gtype == "LineString" and coords:
                add_linestring(coords)
            elif gtype == "MultiLineString" and coords:
                best = max(coords, key=len, default=None)
                if best:
                    add_linestring(best)
            elif gtype == "GeometryCollection":
                for sub in geom.get("geometries", []):
                    if sub.get("type") == "LineString":
                        add_linestring(sub.get("coordinates", []))
                    elif sub.get("type") == "MultiLineString":
                        best = max(sub.get("coordinates", []), key=len, default=None)
                        if best:
                            add_linestring(best)
    else:
        # Bare geometry object (no FeatureCollection wrapper)
        gtype = data.get("type")
        coords = data.get("coordinates")
        if gtype == "LineString" and coords:
            add_linestring(coords)
        elif gtype == "MultiLineString" and coords:
            best = max(coords, key=len, default=None)
            if best:
                add_linestring(best)

    return polylines


def _load_kml_paths(geometry_path: str):
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


def _euclid(ax, ay, bx, by):
    return ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5


def _match_pipes_by_endpoints(edges, node_utms, polylines):
    """Greedy-match GeoJSON polylines to pipes by endpoint distance.

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


def _match_pipes(edges, node_utms, polylines, names=None):
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


# ── Core conversion ───────────────────────────────────────────────────────────
def build_zone_files(
    xlsx_path: str,
    zone_id: str = DEFAULT_ZONE_ID,
    zone_name: str = DEFAULT_ZONE_NAME,
    source_crs: str = DEFAULT_SOURCE_CRS,
    output_dir: str = DEFAULT_OUTPUT_DIR,
    status_mode: str = "blank",
    geometry_path: str = None,
):
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
    junctions = {}   # id -> {x, y, elevation}
    ws_junc = wb["Junction"]
    for row in ws_junc.iter_rows(min_row=2, values_only=False):
        d = {c.column_letter: c.value for c in row if c.value is not None}
        elem = d.get("A")
        if not elem:
            continue
        x_raw = d.get("AJ")   # Easting
        y_raw = d.get("AK")   # Northing
        elev = d.get("S")     # Elevation
        if x_raw is not None and y_raw is not None:
            junctions[elem] = {"x": float(x_raw), "y": float(y_raw), "elevation": elev}

    ok(f"Junctions with coordinates: {len(junctions)}")

    # ── Read reservoirs ─────────────────────────────────────────────────
    reservoirs = {}   # id -> {x, y, elevation}
    ws_res = wb["Reservoir"]
    for row in ws_res.iter_rows(min_row=2, values_only=False):
        d = {c.column_letter: c.value for c in row if c.value is not None}
        elem = d.get("A")
        if not elem:
            continue
        x_raw = d.get("N")    # Easting (Reservoir uses N/O, not AJ/AK)
        y_raw = d.get("O")    # Northing
        elev = d.get("J")     # Elevation
        if x_raw is not None and y_raw is not None:
            reservoirs[elem] = {"x": float(x_raw), "y": float(y_raw), "elevation": elev}

    ok(f"Reservoirs with coordinates: {len(reservoirs)}")

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
    edges = []
    edge_ids_seen = set()
    for row in ws_pipe.iter_rows(min_row=2, values_only=False):
        d = {c.column_letter: c.value for c in row if c.value is not None}
        start = d.get("AU")   # Start Node
        stop = d.get("AV")    # Stop Node
        elem = d.get("A")     # Pipe element name
        if not start or not stop:
            continue
        # Edge ID: use pipe element name if available, else source-target
        edge_id = elem if elem else f"{start}-{stop}"
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
            print(o, file=sys.stderr)
        if len(orphan_edges) > 20:
            print(f"  ... and {len(orphan_edges) - 20} more", file=sys.stderr)

    # ── Optional pipe geometry (bends) from KML or GeoJSON ─────────────
    matched_paths = {}   # edge_id -> [(x, y), ...] in source CRS
    if geometry_path:
        load_failed = False
        suffix = Path(geometry_path).suffix.lower()
        paths = []
        names = []
        try:
            if suffix == ".kml":
                paths, names = _load_kml_paths(geometry_path)
                if paths and not HAS_PYPROJ:
                    warn("KML geometry needs pyproj to reproject into the source "
                         "CRS — pipes will use straight lines.")
                    paths, names = [], []
                    load_failed = True
                elif paths:
                    rev = Transformer.from_crs(DEFAULT_TARGET_CRS, source_crs,
                                               always_xy=True)
                    paths = [
                        [rev.transform(lng, lat) for (lat, lng) in path]
                        for path in paths
                    ]
            else:
                paths = _load_geojson_polylines(geometry_path)
        except FileNotFoundError as e:
            warn(f"{e} — pipes will use straight lines.")
            paths = []
            names = []
            load_failed = True

        polylines = paths
        if polylines:
            node_utms = {nid: (n["x"], n["y"])
                         for nid, n in all_nodes_raw.items()}
            geom_kind = "KML" if suffix == ".kml" else "GeoJSON"
            matched_paths = _match_pipes(edges, node_utms, polylines, names)
            ok(f"Pipe geometry ({geom_kind}): {len(polylines)} lines loaded, "
               f"{len(matched_paths)} pipes matched to a bent path")
            if len(matched_paths) < len(edges):
                warn(f"{len(edges) - len(matched_paths)} pipes have no "
                     "matching geometry — straight lines will be used.")
            if len(matched_paths) < len(polylines):
                warn(f"{len(polylines) - len(matched_paths)} geometry lines "
                     "did not match any pipe and were ignored.")
        elif geometry_path and not load_failed:
            warn("geometry file yielded no line features — pipes will use "
                 "straight lines.")

    # ── Output: KML + status JSON ─────────────────────────────────────
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── Write KML file ────────────────────────────────────────────────
    kml_path = out_dir / f"{zone_id}.kml"
    kml_lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2">',
        '<Document>',
        f'  <name>{zone_name}</name>',
    ]
    # Nodes → Points
    for nid, ll in nodes_latlng.items():
        elev = ll.get("elevation")
        kml_lines.append('  <Placemark>')
        kml_lines.append(f'    <name>{nid}</name>')
        kml_lines.append('    <ExtendedData>')
        kml_lines.append(f'      <Data name="id"><value>{nid}</value></Data>')
        kml_lines.append('    </ExtendedData>')
        kml_lines.append('    <Point>')
        elev_str = f',{elev}' if elev is not None else ''
        kml_lines.append(f'      <coordinates>{ll["lng"]},{ll["lat"]}{elev_str}</coordinates>')
        kml_lines.append('    </Point>')
        kml_lines.append('  </Placemark>')
    # Edges → LineStrings (bent path if geometry matched, else straight)
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

        kml_lines.append('  <Placemark>')
        kml_lines.append(f'    <name>{e["id"]}</name>')
        kml_lines.append('    <ExtendedData>')
        kml_lines.append(f'      <Data name="id"><value>{e["id"]}</value></Data>')
        kml_lines.append(f'      <Data name="source"><value>{e["source"]}</value></Data>')
        kml_lines.append(f'      <Data name="target"><value>{e["target"]}</value></Data>')
        kml_lines.append('    </ExtendedData>')
        kml_lines.append('    <LineString>')
        kml_lines.append('      <coordinates>')
        for lat, lng in waypoints:
            kml_lines.append(f'        {lng},{lat}')
        kml_lines.append('      </coordinates>')
        kml_lines.append('    </LineString>')
        kml_lines.append('  </Placemark>')
    kml_lines.extend([
        '</Document>',
        '</kml>',
    ])
    kml_path.write_text("\n".join(kml_lines), encoding="utf-8")
    ok(f"Wrote {kml_path}  ({len(nodes_latlng)} points, {len(edges)} linestrings)")

    # ── Write zone status JSON (seeds the gist-backed status file) ─────
    status_entries = []
    for nid in nodes_latlng:
        if status_mode == "basic":
            is_reservoir = node_kind.get(nid) == "reservoir"
            status_entries.append({
                "id": nid,
                "label": nid,
                "type": "zone" if is_reservoir else "",
                "state": "ON" if is_reservoir else "OFF",
                "comment": "",
            })
        else:   # blank
            status_entries.append({
                "id": nid,
                "label": "",
                "type": "",
                "state": "",
                "comment": "",
            })
    for e in edges:
        status_entries.append({
            "id": e["id"],
            "flow": "",
        })

    status_path = out_dir / f"{zone_id}_status.json"
    status_path.write_text(
        "[\n" + ",\n".join(f"  {json.dumps(s)}" for s in status_entries) + "\n]",
        encoding="utf-8",
    )
    ok(f"Wrote {status_path}  ({len(status_entries)} entries, mode={status_mode})")

    return status_path, kml_path


# ── Wizards (menu actions) ────────────────────────────────────────────────────
def wizard_setup():
    clear_screen()
    box(["Setup / check dependencies"])
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


def _validate_xlsx(path):
    p = Path(path)
    if not p.exists():
        return f"Not found: {path}"
    if p.suffix.lower() not in (".xlsx", ".xlsm"):
        return "That does not look like an Excel file (.xlsx expected)."
    return None


def wizard_convert():
    clear_screen()
    box(["Convert xlsx \u2192  KML + status files"])
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
    mode_idx = menu("How should the zone status file be seeded?", [
        "blank  — empty attributes; labels/states filled in later",
        "basic  — seeded from the xlsx (reservoirs \u2192 zone/ON, else OFF)",
    ], default=1)
    status_mode = STATUS_MODES[mode_idx - 1]

    step(6, total, "Optional pipe geometry")
    geometry_path = ask("Path to a base KML with real pipe routes "
                        "(.kml; .geojson also works — Enter to skip "
                        "\u2192 straight lines)", "").strip() or None
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
    input("  Press Enter to return to the main menu.")


def wizard_help():
    clear_screen()
    box(["Help — how this tool works"])
    print(
        """

  1)  Setup dependencies
      Installs / verifies what the tool needs:
        - openpyxl  (required)    reads the WaterGEMS .xlsx
        - pyproj    (recommended) accurate UTM \u2192 WGS84 reprojection

  2)  Convert xlsx \u2192 zones
      A guided 6-step conversion that ends in two files per zone:
        - zones/{zone_id}.kml          points for nodes, lines for pipes
        - zones/{zone_id}_status.json  initial status (gist seed)
      Coordinates are UTM Zone 45N (Easting/Northing) by default and are
      reprojected to WGS84 lat/lng for KML.

  3)  Status modes
        blank  — every label/type/state starts empty; you fill in later.
        basic  — seeded from the workbook: reservoirs become type "zone"
                 with state ON; junctions/pipe lines start blank/OFF.

  4)  Pipe geometry
      WaterGEMS only knows the straight start\u2192end line per pipe. Give a
      base KML file (.kml, .geojson also works) with the real routes. Each
      line is matched to a pipe — by placemark <name> first, then by endpoint
      distance — and matched pipes are drawn with their full bent path.

  Tip: press Ctrl+C at any prompt to cancel.
""")
    input("  Press Enter to return to the main menu.")


def main():
    first = True
    while True:
        if first:
            clear_screen()
            first = False
        print()
        box([
            "    SCADA ZONE BUILDER    ",
            " WaterGEMS xlsx export \u2192 zones/{id}.kml + _status.json",
        ])
        choice = menu("What would you like to do?", [
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
            print("\n  Bye.")
            break


if __name__ == "__main__":
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        main()
    except KeyboardInterrupt:
        print("\n  Cancelled.")