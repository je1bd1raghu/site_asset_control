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

Or non-interactively (every flag optional, all have defaults):
    python build_zone_files.py excel/ayeshbag.xlsx
      --zone-id zone_ayeshbag --zone-name "Ayeshbag Distribution"
      --status-mode basic
"""

import argparse
import json
import sys
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


def build_zone_files(
    xlsx_path: str,
    zone_id: str = DEFAULT_ZONE_ID,
    zone_name: str = DEFAULT_ZONE_NAME,
    source_crs: str = DEFAULT_SOURCE_CRS,
    output_dir: str = DEFAULT_OUTPUT_DIR,
    status_mode: str = "blank",
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
    # Edges → LineStrings
    for e in edges:
        src_ll = nodes_latlng.get(e["source"], {})
        tgt_ll = nodes_latlng.get(e["target"], {})
        if not src_ll or not tgt_ll:
            continue
        kml_lines.append('  <Placemark>')
        kml_lines.append(f'    <name>{e["id"]}</name>')
        kml_lines.append('    <ExtendedData>')
        kml_lines.append(f'      <Data name="id"><value>{e["id"]}</value></Data>')
        kml_lines.append(f'      <Data name="source"><value>{e["source"]}</value></Data>')
        kml_lines.append(f'      <Data name="target"><value>{e["target"]}</value></Data>')
        kml_lines.append('    </ExtendedData>')
        kml_lines.append('    <LineString>')
        kml_lines.append('      <coordinates>')
        kml_lines.append(f'        {src_ll["lng"]},{src_ll["lat"]}')
        kml_lines.append(f'        {tgt_ll["lng"]},{tgt_ll["lat"]}')
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

    print("\n  ── Summary ────────────────────────────────────────")
    print(f"    xlsx       : {xlsx_path}")
    print(f"    zone id    : {zone_id}")
    print(f"    zone name  : {zone_name}")
    print(f"    source CRS : {source_crs}")
    print(f"    output dir : {output_dir}")
    print(f"    status mode: {status_mode}")
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
    args = parser.parse_args()

    if args.xlsx:
        build_zone_files(
            xlsx_path=args.xlsx,
            zone_id=args.zone_id,
            zone_name=args.zone_name,
            source_crs=args.source_crs,
            output_dir=args.output_dir,
            status_mode=args.status_mode,
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