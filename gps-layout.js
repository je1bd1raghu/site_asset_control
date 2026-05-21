// ─── REAL-WORLD GPS LAYOUT PROJECTION ────────────────────────────────────────
// Accurate local geographic projection for SCADA / GIS layouts.

function applyGpsLayout(nodes, canvasW, canvasH, options = {}) {

// ─────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────

const PADDING        = options.padding ?? 100;

// Engineering/site north correction
// Example:
//   +15 => rotate clockwise 15°
//   -10 => rotate counter-clockwise 10°
const ROTATION_DEG   = options.rotationDeg ?? 0;

// Optional collision spreading
const MIN_DIST       = options.minDist ?? 0;
const COLLISION_PASS = options.collisionPasses ?? 3;

const DEG2RAD        = Math.PI / 180;
const EARTH_RADIUS   = 6378137;

// ─────────────────────────────────────────────────────────────────────────
// FILTER GPS NODES
// ─────────────────────────────────────────────────────────────────────────

const gpsNodes = nodes.filter(n => {
    const d = n.data || n;

    return (
        typeof d.lat === 'number' &&
        typeof d.lng === 'number' &&
        !isNaN(d.lat) &&
        !isNaN(d.lng)
    );
});

if (gpsNodes.length < 2) {
    return false;
}

// ─────────────────────────────────────────────────────────────────────────
// PICK ORIGIN
// ─────────────────────────────────────────────────────────────────────────

const origin =
    gpsNodes.find(n => (n.data || n).type === 'pump') ||
    gpsNodes[0];

const originData = origin.data || origin;

const oLat = originData.lat;
const oLng = originData.lng;

const cosLat = Math.cos(oLat * DEG2RAD);

// ─────────────────────────────────────────────────────────────────────────
// CONVERT GPS → LOCAL METERS
// ─────────────────────────────────────────────────────────────────────────

const projected = [];

let minX = Infinity;
let maxX = -Infinity;
let minY = Infinity;
let maxY = -Infinity;

gpsNodes.forEach(node => {

    const d = node.data || node;

    // East-West meters
    const xMeters =
        (d.lng - oLng) *
        DEG2RAD *
        EARTH_RADIUS *
        cosLat;

    // North-South meters
    const yMeters =
        (d.lat - oLat) *
        DEG2RAD *
        EARTH_RADIUS;

    projected.push({
        node,
        xMeters,
        yMeters
    });

    minX = Math.min(minX, xMeters);
    maxX = Math.max(maxX, xMeters);

    minY = Math.min(minY, yMeters);
    maxY = Math.max(maxY, yMeters);
});

// ─────────────────────────────────────────────────────────────────────────
// APPLY OPTIONAL ENGINEERING ROTATION
// ─────────────────────────────────────────────────────────────────────────

const theta = ROTATION_DEG * DEG2RAD;

const cosT = Math.cos(theta);
const sinT = Math.sin(theta);

projected.forEach(p => {

    const rx =
        p.xMeters * cosT -
        p.yMeters * sinT;

    const ry =
        p.xMeters * sinT +
        p.yMeters * cosT;

    p.xMeters = rx;
    p.yMeters = ry;
});

// Recompute bounds after rotation
minX = Infinity;
maxX = -Infinity;
minY = Infinity;
maxY = -Infinity;

projected.forEach(p => {
    minX = Math.min(minX, p.xMeters);
    maxX = Math.max(maxX, p.xMeters);

    minY = Math.min(minY, p.yMeters);
    maxY = Math.max(maxY, p.yMeters);
});

// ─────────────────────────────────────────────────────────────────────────
// AUTO SCALE TO VIEWPORT
// ─────────────────────────────────────────────────────────────────────────

const worldWidth  = Math.max(1, maxX - minX);
const worldHeight = Math.max(1, maxY - minY);

const usableW = canvasW - PADDING * 2;
const usableH = canvasH - PADDING * 2;

const scaleX = usableW / worldWidth;
const scaleY = usableH / worldHeight;

// Preserve aspect ratio
const VIEW_SCALE =
    options.viewScale ?? 2.5;

const SCALE =
    Math.min(scaleX, scaleY) *
    VIEW_SCALE;

// Centering offsets
const offsetX =
    (canvasW - worldWidth * SCALE) / 2;

const offsetY =
    (canvasH - worldHeight * SCALE) / 2;

// ─────────────────────────────────────────────────────────────────────────
// PROJECT TO SCREEN
// ─────────────────────────────────────────────────────────────────────────

projected.forEach(p => {

    const px =
        offsetX +
        (p.xMeters - minX) * SCALE;

    // Invert Y because screen coordinates grow downward
    const py =
        canvasH -
        (
            offsetY +
            (p.yMeters - minY) * SCALE
        );

    if (!p.node.position) {
        p.node.position = {};
    }

    p.node.position.x = px;
    p.node.position.y = py;
});

// ─────────────────────────────────────────────────────────────────────────
// OPTIONAL COLLISION SPREADING
// ─────────────────────────────────────────────────────────────────────────

if (MIN_DIST > 0) {

    for (let pass = 0; pass < COLLISION_PASS; pass++) {

        let changed = false;

        for (let i = 0; i < gpsNodes.length; i++) {

            for (let j = i + 1; j < gpsNodes.length; j++) {

                const a = gpsNodes[i].position;
                const b = gpsNodes[j].position;

                const dx = b.x - a.x;
                const dy = b.y - a.y;

                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < MIN_DIST && dist > 0.01) {

                    const nx = dx / dist;
                    const ny = dy / dist;

                    const overlap =
                        (MIN_DIST - dist) / 2;

                    a.x -= nx * overlap;
                    a.y -= ny * overlap;

                    b.x += nx * overlap;
                    b.y += ny * overlap;

                    changed = true;
                }
            }
        }

        if (!changed) {
            break;
        }
    }
}

return true;

}
