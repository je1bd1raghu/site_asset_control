#!/usr/bin/env python3
"""
Convert a WaterGEMS Excel export (.xlsx) to SCADA zone KML + status files.

Reads Junction, Reservoir, and Pipe sheets from the Excel file, converts
projected coordinates (Easting/Northing in UTM Zone 45N) to WGS84 lat/lng,
and writes:
  - zones/{zone_id}.kml           — KML with Point + LineString features
  - zones/{zone_id}_status.json   — initial status (gist seed)

Status modes:
  blank   — empty attributes (label/type/state all blank)          [default]
  basic   — populated from the xlsx: reservoirs → type "zone", state ON;
            junctions → type blank, state OFF; pipes → flow blank.
            Labels come from the WaterGEMS element names.

Run interactively (no flags needed, everything is prompted):
    python build_zone_files.py

Install dependencies (openpyxl required, pyproj recommended):
    python build_zone_files.py --setup

Or non-interactively (every flag optional, all have defaults):
    python build_zone_files.py excel/ayeshbag.xlsx
      --zone-id zone_ayeshbag --zone-name "Ayeshbag Distribution"
      --status-mode basic

Optional pipe geometry:
  WaterGEMS only knows the straight start→end line per pipe. If you have a
  DXF layout showing the real pipe routes with bends, pass it with --geometry
  (either .geojson or .dxf):
    python build_zone_files.py excel/ayeshbag.xlsx --geometry layout.dxf
  A .dxf is first converted to GeoJSON with GDAL's ogr2ogr (which must be on
  your PATH), then each line is matched to a pipe by endpoint proximity against
  the xlsx pipe start/stop node Easting/Northing (same projected CRS). Matched
  pipes are written with their full vertex path. If you don't have GDAL, export
  the DXF to a .geojson yourself and pass that instead.
"""

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import openpyxl

try:
    from pyproj import Transformer
    HAS_PYPROJ = True
except ImportError:
    HAS_PYPROJ = False


# ── Defaults ────────────────────────────────────────────────────────────────
DEFAULT_SOURCE_CRS = "EPSG:32645"   # UTM Zone 45N (West Bengal, India)
DEFAULT_TARGET_CRS = "EPSG:4326"    # WGS84
DEFAULT_ZONE_ID    = "zone_ayeshbag"
DEFAULT_ZONE_NAME  = "Ayeshbag Distribution"
DEFAULT_OUTPUT_DIR = "zones"
STATUS_MODES       = ("blank", "basic")


# ── Small interactive helpers ───────────────────────────────────────────────
def _module_available(name):
    return importlib.util.find_spec(name) is not None


def setup_dependencies(with_gdal=False):
    """Install the Python dependencies this script needs (merged from setup.py).

    Always installs: openpyxl (required to read the WaterGEMS export).
    Installs if missing: pyproj (accurate UTM→WGS84 reprojection).
    Optional: with_gdal=True also pip-installs the GDAL Python bindings, but
    note ogr2ogr itself is an external binary (OSGeo4W etc.) that pip cannot
    provide.

    Returns 0 on success, non-zero on failure.
    """
    targets = []
    if not _module_available("openpyxl"):
        targets.append("openpyxl")
    if not _module_available("pyproj"):
        targets.append("pyproj>=3.0")
    if with_gdal and not shutil.which("ogr2ogr"):
        targets.append("gdal>=3.4")

    if not targets:
        print("All Python dependencies already satisfied.")
    else:
        print("Installing: " + ", ".join(targets))
        result = subprocess.call([sys.executable, "-m", "pip", "install", *targets])
        if result != 0:
            return result

    if not shutil.which("ogr2ogr"):
        print("NOTE: ogr2ogr (GDAL) not found on PATH. DXF pipe layouts "
              "(--geometry *.dxf) need it; install the OSGeo4W/GISInternals "
              "GDAL or export the DXF to .geojson instead.")
    elif with_gdal:
        print("ogr2ogr found on PATH.")
    return 0


def ask(label, default=""):
    """Prompt for a value, returning the default when the user presses Enter."""
    try:
        if default:
            value = input(f"{label} [{default}]: ").strip()
            return value or default
        return input(f"{label}: ").strip()
    except EOFError:
        raise SystemExit("\n  Aborted.")


def ask_choice(label, options, default):
    """Prompt for one of options (by number); returns the chosen value."""
    print(f"  {label} — pick one:")
    for i, opt in enumerate(options, 1):
        mark = "[default]" if opt == default else ""
        print(f"    {i})  {opt} {mark}".rstrip())
    while True:
        try:
            raw = input(f"  -> [{'/'.join(str(options.index(default)+1)) if default else '1'}]: ").strip()
        except EOFError:
            raise SystemExit("\n  Aborted.")
        if not raw:
            return default
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return options[int(raw) - 1]
        if raw in options:
            return raw
        print("    Invalid choice.")


# ── Pipe geometry helpers (GeoJSON) ──────────────────────────────────────────
def _dxf_to_geojson(dxf_path: str):
    """Convert a DXF file to a temporary GeoJSON using GDAL's ogr2ogr.

    Returns the path to the generated .geojson (caller must clean it up), or
    raises RuntimeError if ogr2ogr is missing or the conversion fails.
    DXF files carry no CRS, so the coordinates are passed through unchanged.
    """
    ogr2ogr = shutil.which("ogr2ogr")
    if not ogr2ogr:
        raise RuntimeError(
            "ogr2ogr (GDAL) not found on PATH — install GDAL or convert the "
            "DXF to GeoJSON yourself and pass the .geojson to --geometry")

    tmp_fd, tmp_geojson = tempfile.mkstemp(suffix=".geojson", prefix="zone_geom_")
    os.close(tmp_fd)
    try:
        result = subprocess.run(
            [ogr2ogr, "-f", "GeoJSON", tmp_geojson, dxf_path],
            capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(
                f"ogr2ogr failed for {dxf_path}:\n{result.stderr.strip()}")
    except Exception as e:
        os.unlink(tmp_geojson)
        raise RuntimeError(f"DXF conversion failed: {e}") from e
    return tmp_geojson


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
        print(f"WARNING: could not parse geometry file {geometry_path}: {e}", file=sys.stderr)
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
        print(f"ERROR: --status-mode must be one of {', '.join(STATUS_MODES)}", file=sys.stderr)
        sys.exit(1)

    wb = openpyxl.load_workbook(xlsx_path, data_only=True)

    # ── Set up coordinate transformer ───────────────────────────────────
    transformer = None
    if HAS_PYPROJ:
        transformer = Transformer.from_crs(source_crs, DEFAULT_TARGET_CRS, always_xy=True)
        print(f"Coordinate transform: {source_crs} -> {DEFAULT_TARGET_CRS}")
    else:
        print("WARNING: pyproj not installed. Coordinates will be raw Easting/Northing.", file=sys.stderr)

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

    print(f"Junctions with coordinates: {len(junctions)}")

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

    print(f"Reservoirs with coordinates: {len(reservoirs)}")

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
        print("ERROR: No nodes with coordinates found.", file=sys.stderr)
        sys.exit(1)

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

    print(f"Edges (pipes): {len(edges)}")

    # ── Validate connectivity ───────────────────────────────────────────
    node_ids = set(nodes_latlng.keys())
    orphan_edges = []
    for e in edges:
        if e["source"] not in node_ids:
            orphan_edges.append(f"  {e['id']}: source '{e['source']}' not in nodes")
        if e["target"] not in node_ids:
            orphan_edges.append(f"  {e['id']}: target '{e['target']}' not in nodes")
    if orphan_edges:
        print(f"WARNING: {len(orphan_edges)} edges reference missing nodes:", file=sys.stderr)
        for o in orphan_edges[:20]:
            print(o, file=sys.stderr)
        if len(orphan_edges) > 20:
            print(f"  ... and {len(orphan_edges) - 20} more", file=sys.stderr)

    # ── Optional pipe geometry (bends) from GeoJSON or DXF ──────────────
    matched_paths = {}   # edge_id -> [(x, y), ...] in source CRS
    if geometry_path:
        geom_source = geometry_path
        tmp_geojson = None
        load_failed = False
        is_dxf = Path(geometry_path).suffix.lower() == ".dxf"
        try:
            if is_dxf:
                tmp_geojson = _dxf_to_geojson(geometry_path)
                geom_source = tmp_geojson
            polylines = _load_geojson_polylines(geom_source)
        except (FileNotFoundError, RuntimeError) as e:
            print(f"WARNING: {e} — pipes will use straight lines.", file=sys.stderr)
            polylines = []
            load_failed = True
        finally:
            if tmp_geojson:
                os.unlink(tmp_geojson)

        if polylines:
            node_utms = {nid: (n["x"], n["y"])
                         for nid, n in all_nodes_raw.items()}
            matched_paths = _match_pipes_by_endpoints(edges, node_utms, polylines)
            print(f"Pipe geometry: {len(polylines)} lines loaded, "
                  f"{len(matched_paths)} pipes matched to a bent path")
            if len(matched_paths) < len(edges):
                print(f"WARNING: {len(edges) - len(matched_paths)} pipes have no "
                      "matching geometry — straight lines will be used.",
                      file=sys.stderr)
            if len(matched_paths) < len(polylines):
                print(f"WARNING: {len(polylines) - len(matched_paths)} geometry "
                      "lines did not match any pipe and were ignored.",
                      file=sys.stderr)
        elif geometry_path and not load_failed:
            print("WARNING: geometry file yielded no line features — pipes will "
                  "use straight lines.", file=sys.stderr)

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
    print(f"Wrote {kml_path}  ({len(nodes_latlng)} points, {len(edges)} linestrings)")

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
    print(f"Wrote {status_path}  ({len(status_entries)} entries, mode={status_mode})")

    return status_path, kml_path


# ── Wizard / CLI entry ───────────────────────────────────────────────────────
def interactive_wizard(args):
    """Prompt for every setting (used when no args are given)."""
    print("\n  ┌──────────────────────────────────────────────┐")
    print("  │            SCADA Zone Builder (xlsx)           │")
    print("  └──────────────────────────────────────────────┘")
    print("  WaterGEMS export  →  zones/{zone_id}.kml + _status.json\n")

    xlsx_path = ask("WaterGEMS xlsx path")
    while not xlsx_path or not Path(xlsx_path).exists():
        if xlsx_path:
            print(f"    Not found: {xlsx_path}")
        xlsx_path = ask("WaterGEMS xlsx path")
        if not xlsx_path:
            print("  Aborted.")
            return

    zone_id   = ask("Zone ID", args.zone_id or DEFAULT_ZONE_ID)
    zone_name = ask("Zone name", args.zone_name or DEFAULT_ZONE_NAME)
    #
    source_crs = ask("Source CRS", args.source_crs or DEFAULT_SOURCE_CRS) or DEFAULT_SOURCE_CRS
    output_dir = ask("Output directory", args.output_dir or DEFAULT_OUTPUT_DIR)
    status_mode = ask_choice("Status mode", list(STATUS_MODES), args.status_mode or "blank")
    geometry_default = getattr(args, "geometry", None) or ""
    geometry_path = ask("Pipe layout path  (.geojson or .dxf, optional)", geometry_default) or None

    print("\n  ── Summary ────────────────────────────────────────")
    print(f"    xlsx       : {xlsx_path}")
    print(f"    zone id    : {zone_id}")
    print(f"    zone name  : {zone_name}")
    print(f"    source CRS : {source_crs}")
    print(f"    output dir : {output_dir}")
    print(f"    status mode: {status_mode}")
    print(f"    geometry   : {geometry_path or '(none — straight pipes)'}")
    if input("  Continue? [Y/n]: ").strip().lower() in ("n", "no"):
        print("  Aborted.")
        return

    build_zone_files(
        xlsx_path=xlsx_path,
        zone_id=zone_id,
        zone_name=zone_name,
        source_crs=source_crs,
        output_dir=output_dir,
        status_mode=status_mode,
        geometry_path=geometry_path,
    )


def main():
    parser = argparse.ArgumentParser(
        description="Convert WaterGEMS .xlsx to SCADA zone KML + status files "
                    "(run with no args for the interactive wizard)"
    )
    parser.add_argument("xlsx", nargs="?", help="Path to the WaterGEMS Excel export (prompted if omitted)")
    parser.add_argument("--zone-id", default=DEFAULT_ZONE_ID, help="Zone ID (default: %(default)s)")
    parser.add_argument("--zone-name", default=DEFAULT_ZONE_NAME, help="Zone display name (default: %(default)s)")
    parser.add_argument("--source-crs", default=DEFAULT_SOURCE_CRS,
                        help="Source CRS (default: %(default)s)")
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR,
                        help="Output directory (default: %(default)s)")
    parser.add_argument("--status-mode", choices=STATUS_MODES, default="blank",
                        help="Status output mode: blank or basic (default: %(default)s)")
    parser.add_argument("--geometry", default=None,
                        help="Optional pipe layout with real routes: a .geojson, "
                             "or a .dxf converted via GDAL ogr2ogr. Lines are "
                             "matched to pipes by endpoints; matched pipes draw "
                             "their full bent path instead of a straight line")
    parser.add_argument("--setup", action="store_true",
                        help="Install the Python dependencies (openpyxl, pyproj) "
                             "and exit. Add --with-gdal to also try pip-installing "
                             "the GDAL Python bindings.")
    parser.add_argument("--with-gdal", action="store_true",
                        help="With --setup, also pip-install GDAL (ogr2ogr still "
                             "needs the external OSGeo4W/GISInternals binaries)")
    args = parser.parse_args()

    if args.setup:
        raise SystemExit(setup_dependencies(with_gdal=args.with_gdal))

    if args.xlsx:
        build_zone_files(
            xlsx_path=args.xlsx,
            zone_id=args.zone_id,
            zone_name=args.zone_name,
            source_crs=args.source_crs,
            output_dir=args.output_dir,
            status_mode=args.status_mode,
            geometry_path=args.geometry,
        )
    else:
        interactive_wizard(args)


if __name__ == "__main__":
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        main()
    except KeyboardInterrupt:
        print("\n  Cancelled.")