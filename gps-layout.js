// ─── GPS POLAR PROJECTION ─────────────────────────────────────────────────────
// Standalone module — no dependencies.
// Converts node lat/lng into canvas x/y positions using a polar projection
// centred on an origin node (first pump with GPS, or first GPS node).
//
// Input  `nodes`  — array of zone.json node objects:
//   { data: { id, lat, lng, type? }, position: { x, y } }
//   Nodes whose lat/lng are null/undefined keep their existing position unchanged.
//
// Input  `canvasW`, `canvasH`  — pixel dimensions of the target canvas.
//
// Input  `options`  (optional):
//   padding     {number}  px margin kept clear at canvas edges  (default 80)
//   minDist     {number}  minimum px gap between any two nodes  (default 80)
//   minPasses   {number}  max cascade-resolution passes         (default 4)
//
// Returns  true  if the projection was applied (≥2 nodes had GPS coords).
// Returns  false if fewer than 2 GPS nodes were found (caller falls back to
//          its own layout).
//
// Projection rules:
//   • Bearing from origin → node gives the canvas angle (N = up, E = right).
//   • Distance is normalised 0–1 across all GPS nodes then mapped to maxRadius.
//   • The origin node itself lands at (canvasW/2, canvasH/2).
//   • Latitude correction (cosLat) is applied to longitude deltas so east-west
//     distances are geographically correct at the diagram's latitude.
//   • After projection, any pair of nodes closer than minDist px is pushed apart
//     along their existing bearing to exactly minDist (direction preserved).
//     Up to `minPasses` outer passes handle cascades.

function applyGpsLayout(nodes, canvasW, canvasH, options) {
    const opts      = options || {};
    const PADDING   = opts.padding  !== undefined ? opts.padding  : 80;
    const MIN_DIST  = opts.minDist  !== undefined ? opts.minDist  : 80;
    const MAX_PASS  = opts.minPasses !== undefined ? opts.minPasses : 4;

    const maxRadius = Math.min(canvasW, canvasH) / 2 - PADDING;
    const cx        = canvasW / 2;
    const cy        = canvasH / 2;
    const DEG2RAD   = Math.PI / 180;

    // ── Collect nodes that carry numeric GPS data ─────────────────────────────
    const gpsNodes = nodes.filter(n => {
        const d = n.data || n;
        return typeof d.lat === 'number' && typeof d.lng === 'number';
    });

    if (gpsNodes.length < 2) return false;   // not enough data — skip

    // ── Pick origin: first pump node with GPS, else first GPS node ────────────
    const origin = gpsNodes.find(n => (n.data || n).type === 'pump') || gpsNodes[0];
    const oLat   = (origin.data || origin).lat;
    const oLng   = (origin.data || origin).lng;

    // Latitude correction factor for longitude distances at this latitude
    const cosLat = Math.cos(oLat * DEG2RAD);

    // ── Compute polar coords (bearing + raw distance) for every GPS node ──────
    const polars = gpsNodes.map(n => {
        const d    = n.data || n;
        const dLat = d.lat - oLat;
        const dLng = (d.lng - oLng) * cosLat;   // corrected for latitude
        const dist = Math.sqrt(dLat * dLat + dLng * dLng);
        // atan2 bearing: 0 = north (up), clockwise positive → east = right
        const bearing = Math.atan2(dLng, dLat);
        return { node: n, dist, bearing };
    });

    // ── Normalise distances → map to canvas radius ────────────────────────────
    const maxDist = Math.max(...polars.map(p => p.dist));

    polars.forEach(({ node, dist, bearing }) => {
        const r  = maxDist > 0 ? (dist / maxDist) * maxRadius : 0;
        const px = cx + r * Math.sin(bearing);   // sin for x (east)
        const py = cy - r * Math.cos(bearing);   // −cos for y (north = up)

        if (node.position) {
            node.position.x = px;
            node.position.y = py;
        } else {
            node.position = { x: px, y: py };
        }
    });

    // ── Minimum-distance enforcement ──────────────────────────────────────────
    // Any pair closer than MIN_DIST px is snapped to exactly MIN_DIST,
    // anchored at their midpoint so bearing is preserved.
    // Multiple passes resolve cascades (fixing A↔B may push A into C).
    for (let pass = 0; pass < MAX_PASS; pass++) {
        let anyFixed = false;

        for (let i = 0; i < gpsNodes.length; i++) {
            for (let j = i + 1; j < gpsNodes.length; j++) {
                const a  = gpsNodes[i].position;
                const b  = gpsNodes[j].position;
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const d  = Math.sqrt(dx * dx + dy * dy);

                if (d < MIN_DIST && d > 0.01) {
                    const mx = (a.x + b.x) / 2;
                    const my = (a.y + b.y) / 2;
                    const nx = dx / d;
                    const ny = dy / d;
                    gpsNodes[i].position.x = mx - nx * MIN_DIST / 2;
                    gpsNodes[i].position.y = my - ny * MIN_DIST / 2;
                    gpsNodes[j].position.x = mx + nx * MIN_DIST / 2;
                    gpsNodes[j].position.y = my + ny * MIN_DIST / 2;
                    anyFixed = true;
                }
            }
        }

        if (!anyFixed) break;   // converged — no more passes needed
    }

    return true;
}
