// ─── COLOUR PALETTE ───────────────────────────────────────────────────────────
// Node rendering uses Leaflet markers/circleMarkers with status-based colors.
//
//  Valve ON  → green fill,   Valve OFF → red fill
//  Pump  ON  → purple fill,  Pump  OFF → grey fill
//  Zone  ON  → blue fill,    Zone  OFF → grey fill
//  Pipe active → green,      Pipe idle → grey,        Pipe leakburst → red

const COLOR = {
    on:             '#2ecc71',
    onBorder:       '#27ae60',
    valveOff:       '#e74c3c',
    valveOffBorder: '#c0392b',
    pump:           '#8e44ad',
    pumpBorder:     '#6c3483',
    pumpOff:        '#95a5a6',
    pumpOffBorder:  '#7f8c8d',
    zone:           '#3498db',
    zoneBorder:     '#2980b9',
    zoneOff:        '#bdc3c7',
    zoneOffBorder:  '#95a5a6',
    lineActive:     '#2ecc71',
    lineIdle:       '#a9b0b8',
    lineLeakburst:  '#e74c3c'
};

// ─── STATUS MAP: type → { on: color, off: color } ────────────────────────────
const STATUS_COLORS = {
    pump:  { on: COLOR.pump,  off: COLOR.pumpOff,  onBorder: COLOR.on, offBorder: COLOR.pumpOffBorder },
    valve: { on: COLOR.on,    off: COLOR.valveOff,  onBorder: COLOR.onBorder, offBorder: COLOR.valveOffBorder },
    zone:  { on: COLOR.zone,  off: COLOR.zoneOff,  onBorder: COLOR.zoneBorder, offBorder: COLOR.zoneOffBorder }
};

// ─── APPLY STATUS UPDATE FROM DATA ───────────────────────────────────────────
// Maps zone_status.json entries onto KML Leaflet layers by id.
// Returns count of updated elements.
function applyStatus(kmlLayer, data) {
    let updated = 0;

    // Build a lookup of status entries by id
    const statusMap = {};
    data.forEach(item => {
        if (item.id) statusMap[item.id] = item;
    });

    // Iterate KML layers and apply status
    kmlLayer.eachLayer(function(layer) {
        const feat = layer.feature;
        if (!feat || !feat.id) return;
        const st = statusMap[feat.id];
        if (!st) return;

        // Store status on the feature for later reference
        feat.status = st;

        if (feat.type === 'point') {
            _stylePointFeature(layer, feat, st);
            updated++;
        } else if (feat.type === 'line') {
            _styleLineFeature(layer, feat, st);
            updated++;
        }
    });

    return updated;
}

// ─── STYLE A POINT FEATURE (marker / circleMarker) ──────────────────────────
function _stylePointFeature(layer, feat, st) {
    const nodeType = (st.type || feat.properties.type || '').toLowerCase();
    const state    = (st.state || '').toUpperCase();
    const colors   = STATUS_COLORS[nodeType];

    if (layer instanceof L.CircleMarker) {
        if (colors) {
            layer.setStyle({
                fillColor: state === 'ON' ? colors.on : colors.off,
                color:     state === 'ON' ? colors.onBorder : colors.offBorder,
                weight:    state === 'ON' ? 3 : 2
            });
        }
    }
}

// ─── STYLE A LINE FEATURE (polyline) ────────────────────────────────────────
function _styleLineFeature(layer, feat, st) {
    const flow = (st.flow || feat.properties.flow || '').toLowerCase();
    const el   = layer._path;
    if (el) el.classList.remove('pipe-flow-active');

    if (flow === 'active') {
        layer.setStyle({ color: COLOR.lineActive, weight: 5, dashArray: '10, 10' });
        if (el) el.classList.add('pipe-flow-active');
    } else if (flow === 'leakburst') {
        layer.setStyle({ color: COLOR.lineLeakburst, weight: 5, dashArray: '6, 6' });
    } else {
        layer.setStyle({ color: COLOR.lineIdle, weight: 3, dashArray: null });
    }
}

// ─── LEAK LOCATION MARKERS ───────────────────────────────────────────────────
// Draws a red dot with an orange ring at the midpoint of each leaked/burst pipe.
// Leaks are never animated; the static dot pinpoints the location.
let _leakGroup = null;

function updateLeakMarkers(kmlLayer, map) {
    if (!_leakGroup) {
        _leakGroup = L.layerGroup().addTo(map);
    } else {
        _leakGroup.clearLayers();
    }

    kmlLayer.eachLayer(function(layer) {
        const feat = layer.feature;
        if (!feat || feat.type !== 'line') return;

        const flow = (feat.status && feat.status.flow) ||
                     (feat.properties && feat.properties.flow) || '';
        if (String(flow).toLowerCase() !== 'leakburst') return;

        const mid = _midpointOfLine(layer.getLatLngs());
        if (!mid) return;

        _leakGroup.addLayer(L.circleMarker(mid, {
            radius: 7,
            fillColor: COLOR.lineLeakburst,
            fillOpacity: 0.95,
            color: '#F5821F',
            weight: 3,
            interactive: false
        }));
    });
}

// Point at the half-distance along a polyline (approximates the leak position).
function _midpointOfLine(latlngs) {
    if (!latlngs || !latlngs.length) return null;
    let pts = latlngs;
    if (Array.isArray(pts[0])) pts = pts[0];
    if (!pts || pts.length < 2) {
        const p = pts && pts[0];
        return p ? [p.lat, p.lng] : null;
    }

    let total = 0;
    for (let i = 1; i < pts.length; i++) total += pts[i - 1].distanceTo(pts[i]);
    if (total === 0) {
        const p = pts[0];
        return [p.lat, p.lng];
    }

    let target = total / 2;
    for (let i = 1; i < pts.length; i++) {
        const seg = pts[i - 1].distanceTo(pts[i]);
        if (target <= seg) {
            const t = seg === 0 ? 0 : target / seg;
            const a = pts[i - 1];
            const b = pts[i];
            return [a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t];
        }
        target -= seg;
    }
    const last = pts[pts.length - 1];
    return [last.lat, last.lng];
}

// ─── FLOW PROPAGATION ────────────────────────────────────────────────────────
// Computes line flow states by walking the directed graph from every running
// pump (type=pump, state=ON).
//
// Graph structure comes from KML ExtendedData:
//   - Line features have properties.source and properties.target
//   - Point features are nodes
//
// Edge flow rules:
//   reachable  + flow="leakburst"  → keep "leakburst"
//   reachable  + anything else    → set "active"
//   unreachable                   → set "" (idle)
//
// Traversal rules:
//   - BFS starts from all point features with type=pump, state=ON
//   - A closed valve (state=OFF) stops traversal
//   - Zone nodes and open valves are transparent
//
// If no pump features exist, the function is a no-op.

function propagateFlow(kmlLayer) {
    // Build node lookup and adjacency list from KML features
    const nodes = {};   // id → { type, state, feature }
    const edges = [];   // { id, source, target, feature }

    kmlLayer.eachLayer(function(layer) {
        const feat = layer.feature;
        if (!feat || !feat.id) return;

        if (feat.type === 'point') {
            const nodeType = (feat.properties.type || '').toLowerCase();
            const state    = feat.status ? (feat.status.state || '').toUpperCase() : '';
            nodes[feat.id] = { type: nodeType, state: state, feature: feat };
        } else if (feat.type === 'line') {
            const src = feat.properties.source || '';
            const tgt = feat.properties.target || '';
            if (src && tgt) {
                edges.push({ id: feat.id, source: src, target: tgt, feature: feat });
            }
        }
    });

    // Check if any pumps exist
    const hasPumps = Object.values(nodes).some(n => n.type === 'pump');
    if (!hasPumps) return;

    // BFS from running pumps
    const reachableEdges = new Set();
    const visitedNodes   = new Set();
    const queue          = [];

    Object.entries(nodes).forEach(([id, node]) => {
        if (node.type === 'pump' && node.state === 'ON') queue.push(id);
    });

    while (queue.length > 0) {
        const nid = queue.shift();
        if (visitedNodes.has(nid)) continue;
        visitedNodes.add(nid);

        const node = nodes[nid];
        // Closed valve: stop traversal
        if (node && node.type === 'valve' && node.state === 'OFF') continue;

        edges.forEach(edge => {
            if (edge.source === nid) {
                reachableEdges.add(edge.id);
                queue.push(edge.target);
            }
        });
    }

    // Update edge flow on the KML layers
    kmlLayer.eachLayer(function(layer) {
        const feat = layer.feature;
        if (!feat || feat.type !== 'line') return;

        // Leaks/bursts always win
        if (feat.status && feat.status.flow === 'leakburst') return;

        const flow = reachableEdges.has(feat.id) ? 'active' : '';
        if (feat.status) feat.status.flow = flow;
        feat.properties.flow = flow;

        _styleLineFeature(layer, feat, { flow: flow });
    });
}

// ─── LEAFLET POPUP HELPER ────────────────────────────────────────────────────
// Build an HTML popup content string from feature data.
function featurePopupHtml(feat, status) {
    if (!feat) return '';
    const name = feat.name || feat.id || 'Unknown';
    const desc = feat.description || '';
    const id   = feat.id || '';
    const props = feat.properties || {};
    const st   = status || feat.status || {};
    const nodeType = st.type || props.type || '';
    const state    = st.state || '';
    const flow     = st.flow || props.flow || '';
    const comment  = st.comment || '';

    let html = '<div style="font-family:Nunito,sans-serif;min-width:160px;max-width:280px">';
    html += '<div style="font-weight:800;font-size:14px;margin-bottom:6px;color:#212529">' + esc(name) + '</div>';

    if (id) html += '<div style="font-size:12px;color:#6C757D;margin-bottom:4px">ID: ' + esc(id) + '</div>';
    if (nodeType) html += '<div style="font-size:12px;color:#6C757D;margin-bottom:4px">Type: ' + esc(nodeType) + '</div>';
    if (state) {
        const stateColor = state === 'ON' ? '#16A34A' : '#DC2626';
        html += '<div style="font-size:12px;font-weight:700;color:' + stateColor + ';margin-bottom:4px">State: ' + esc(state) + '</div>';
    }
    if (flow) {
        const flowColor = flow === 'active' ? '#16A34A' : flow === 'leakburst' ? '#DC2626' : '#6C757D';
        const flowLabel = flow === 'active' ? '▶ Active' : flow === 'leakburst' ? '⚠ LEAK/BURST' : 'Idle';
        html += '<div style="font-size:12px;font-weight:700;color:' + flowColor + ';margin-bottom:4px">Flow: ' + flowLabel + '</div>';
    }
    if (comment) {
        html += '<div style="font-size:12px;background:#FFF0E0;border-left:3px solid #F5821F;padding:4px 8px;border-radius:0 4px 4px 0;margin-top:4px;color:#92400E">' + esc(comment) + '</div>';
    }
    if (desc) {
        html += '<div style="font-size:11px;color:#6C757D;margin-top:6px;border-top:1px solid #DEE2E6;padding-top:6px">' + esc(desc) + '</div>';
    }

    html += '</div>';
    return html;
}
