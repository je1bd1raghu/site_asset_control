#!/usr/bin/env python3
"""
Convert a WaterGEMS Excel export (.xlsx) to SCADA zone geometry and status JSON files.

Reads Junction, Reservoir, and Pipe sheets from the Excel file, converts
projected coordinates (Easting/Northing in UTM Zone 45N) to WGS84 lat/lng,
and writes:
  - zones/{zone_id}.json          — Cytoscape geometry (nodes + edges)
  - zones/{zone_id}_status.json   — initial status (empty attributes)

Usage:
    python xlsx_to_zone_json.py excel/ayeshbag.xlsx --zone-id zone_ayeshbag --zone-name "Ayeshbag Distribution"
"""

import argparse
import json
import math
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
EARTH_RADIUS = 6378137              # metres, for equirectangular projection


def xlsx_to_zone_json(
    xlsx_path: str,
    zone_id: str = "zone_ayeshbag",
    zone_name: str = "Ayeshbag Distribution",
    source_crs: str = DEFAULT_SOURCE_CRS,
    output_dir: str = "zones",
):
    """Main conversion function."""
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

    # ── Merge all nodes ─────────────────────────────────────────────────
    all_nodes_raw = {}
    all_nodes_raw.update(junctions)
    all_nodes_raw.update(reservoirs)

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

    # ── Compute equirectangular positions from lat/lng ──────────────────
    # Centre on the first node (matches gps-layout.js behaviour)
    first_lat = next(iter(nodes_latlng.values()))["lat"]
    first_lng = next(iter(nodes_latlng.values()))["lng"]

    def to_position(lat, lng):
        x = (lng - first_lng) * math.cos(math.radians(first_lat)) * EARTH_RADIUS
        y = (lat - first_lat) * EARTH_RADIUS
        # Scale to fit a reasonable canvas (match existing zone files ~200-600px range)
        return {"x": round(x), "y": round(-y)}   # flip y so north is up

    # ── Build Cytoscape nodes ───────────────────────────────────────────
    cy_nodes = []
    for nid, ll in nodes_latlng.items():
        cy_nodes.append({
            "data": {"id": nid, "lat": ll["lat"], "lng": ll["lng"]},
            "position": to_position(ll["lat"], ll["lng"]),
        })

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
            "data": {
                "id": edge_id,
                "source": start,
                "target": stop,
            }
        })

    print(f"Edges (pipes): {len(edges)}")

    # ── Validate connectivity ───────────────────────────────────────────
    node_ids = {n["data"]["id"] for n in cy_nodes}
    orphan_edges = []
    for e in edges:
        d = e["data"]
        if d["source"] not in node_ids:
            orphan_edges.append(f"  {d['id']}: source '{d['source']}' not in nodes")
        if d["target"] not in node_ids:
            orphan_edges.append(f"  {d['id']}: target '{d['target']}' not in nodes")
    if orphan_edges:
        print(f"WARNING: {len(orphan_edges)} edges reference missing nodes:", file=sys.stderr)
        for o in orphan_edges[:20]:
            print(o, file=sys.stderr)
        if len(orphan_edges) > 20:
            print(f"  ... and {len(orphan_edges) - 20} more", file=sys.stderr)

    # ── Write zone geometry JSON ────────────────────────────────────────
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    geo_path = out_dir / f"{zone_id}.json"
    geo_data = {"nodes": cy_nodes, "edges": edges}
    geo_path.write_text(json.dumps(geo_data, indent=2), encoding="utf-8")
    print(f"Wrote {geo_path}  ({len(cy_nodes)} nodes, {len(edges)} edges)")

    # ── Write zone status JSON ──────────────────────────────────────────
    status_entries = []
    for n in cy_nodes:
        status_entries.append({
            "id": n["data"]["id"],
            "label": "",
            "type": "",
            "state": "",
            "comment": "",
        })
    for e in edges:
        status_entries.append({
            "id": e["data"]["id"],
            "flow": "",
        })

    status_path = out_dir / f"{zone_id}_status.json"
    status_path.write_text(
        "[\n" + ",\n".join(f"  {json.dumps(s)}" for s in status_entries) + "\n]",
        encoding="utf-8",
    )
    print(f"Wrote {status_path}  ({len(status_entries)} entries)")

    return geo_path, status_path


def main():
    parser = argparse.ArgumentParser(description="Convert WaterGEMS .xlsx to SCADA zone JSON files")
    parser.add_argument("xlsx", help="Path to the WaterGEMS Excel export")
    parser.add_argument("--zone-id", default="zone_ayeshbag", help="Zone ID (default: zone_ayeshbag)")
    parser.add_argument("--zone-name", default="Ayeshbag Distribution", help="Zone display name")
    parser.add_argument("--source-crs", default=DEFAULT_SOURCE_CRS, help=f"Source CRS (default: {DEFAULT_SOURCE_CRS})")
    parser.add_argument("--output-dir", default="zones", help="Output directory (default: zones/)")
    args = parser.parse_args()

    xlsx_to_zone_json(
        xlsx_path=args.xlsx,
        zone_id=args.zone_id,
        zone_name=args.zone_name,
        source_crs=args.source_crs,
        output_dir=args.output_dir,
    )


if __name__ == "__main__":
    main()
