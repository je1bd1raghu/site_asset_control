// ─── SHARED HELPERS ───────────────────────────────────────────────────────────
// updateClock, esc, showToast come from common.js (loaded before this file).

// ─── STATE ────────────────────────────────────────────────────────────────────

let cy           = null;
let latestReport = {};

// ─── NODE SIZE SCALE ──────────────────────────────────────────────────────────
// Tracks a discrete step (-5 … +5) that scales node size and label font size
// relative to the defaults defined in CY_BASE_STYLE.

let _nodeSizeStep = 0;   // current step; 0 = default

// Base values (must match CY_BASE_STYLE mapData min/max)
const NSC_BASE_MIN = 40;   // mapData min node size
const NSC_BASE_MAX = 100;  // mapData max node size
const NSC_BASE_FONT = 10;  // default font-size in px
const NSC_STEP_PX = 8;     // px added/removed per step for node sizes
const NSC_STEP_FONT = 2;   // px added/removed per step for font

function adjustNodeSize(delta) {
    _nodeSizeStep = Math.max(-4, Math.min(5, _nodeSizeStep + delta));
    _applyNodeSizeStyle();
}

function _applyNodeSizeStyle() {
    if (!cy) return;
    const s = _nodeSizeStep;
    const minSz = Math.max(10, NSC_BASE_MIN  + s * NSC_STEP_PX);
    const maxSz = Math.max(20, NSC_BASE_MAX  + s * NSC_STEP_PX);
    const font  = Math.max(6,  NSC_BASE_FONT + s * NSC_STEP_FONT) + 'px';

    // Scale edge width and arrowhead proportionally with node size.
    // Baseline edge width = 2px at step 0; clamp to [1, 8].
    const edgeW       = Math.min(8, Math.max(1, 2 + s * 0.5));
    // arrow-scale: 1.0 at step 0, scales ±0.15 per step, clamped [0.4, 2.5]
    const arrowScale  = Math.min(2.5, Math.max(0.4, 1.0 + s * 0.15));

    cy.style()
      .selector('node')
      .style({
          'width':  'mapData(nameCount, 1, 5, ' + minSz + ', ' + maxSz + ')',
          'height': 'mapData(nameCount, 1, 5, ' + minSz + ', ' + maxSz + ')',
          'font-size': font,
          'min-zoomed-font-size': 0
      })
      .selector('edge')
      .style({
          'width':       edgeW,
          'arrow-scale': arrowScale
      })
      .update();
}

// Reset scale whenever a new graph is drawn
function _resetNodeSizeStep() { _nodeSizeStep = 0; }


const nodeNameMap        = new Map();  // internalName → Set of original raw tokens
const originalNodeLookup = new Map();  // rawToken     → internalName

// ─── CYTOSCAPE STYLE (single source of truth) ─────────────────────────────────
// Shared by initCy() — used by loadFromZoneJSON(), drawGraph(), and
// compareAndRenderGraphs(). Compare mode extends this array with its own
// class-specific overrides passed as extraStyles.

const CY_BASE_STYLE = [
    {
        selector: 'node',
        style: {
            'background-color': '#0074D9',
            'label': '',
            'color': '#ffffff',
            'text-valign': 'center',
            'text-halign': 'center',
            'text-wrap': 'wrap',
            'shape': 'ellipse',
            'width':  'mapData(nameCount, 1, 5, 40, 100)',
            'height': 'mapData(nameCount, 1, 5, 40, 100)',
            'font-size': '10px',
            'min-zoomed-font-size': 6,
            'overlay-padding': 4
        }
    },
    // Only map label data field on nodes that actually have a label set —
    // avoids Cytoscape's "no mapping for property label" warning on edges.
    {
        selector: 'node[label]',
        style: { 'label': 'data(label)' }
    },
    { selector: 'node.overbranched', style: { 'background-color': 'red' } },
    {
        selector: 'node.search-highlight',
        style: {
            'border-color': '#FFD700', 'border-width': '8px', 'border-style': 'double',
            'background-color': '#FFA500', 'background-opacity': 0.7
        }
    },
    {
        selector: 'edge',
        style: { 'line-color': '#888', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier' }
    },
    { selector: 'edge.duplicate', style: { 'line-color': 'orange', 'width': 3, 'line-style': 'dashed' } }
];

// ─── CYTOSCAPE INIT HELPER ────────────────────────────────────────────────────
// Single place for cy.destroy() + cytoscape({…}).
// - containerId : DOM id of the graph container
// - elements    : Cytoscape element array
// - layout      : Cytoscape layout descriptor  { name: 'preset' } | { name: 'cose' }
// - extraStyles : optional array of additional style rules appended after CY_BASE_STYLE
// Returns the new cy instance (also assigned to the global `cy`).

function initCy(containerId, elements, layout, extraStyles) {
    if (cy) cy.destroy();
    cy = cytoscape({
        container: document.getElementById(containerId),
        elements,
        layout,
        style: extraStyles ? CY_BASE_STYLE.concat(extraStyles) : CY_BASE_STYLE,
        minZoom: 0.05,
        maxZoom: 6,

    });
    return cy;
}

// ─── GPS LAYOUT HELPER ────────────────────────────────────────────────────────
// Shared by loadFromZoneJSON() and drawGraph().
// Accepts the *elements array* already assembled for Cytoscape.
// Nodes are identified by the absence of a source field (i.e. not edges).
//
// The contract for applyGpsLayout() (from gps-layout.js) requires objects with:
//   { data: { id, lat, lng, type? }, position: { x, y } }
// This wrapper builds that shape, runs the projection, then writes the
// computed positions back into the original elements array so Cytoscape
// receives them directly.
//
// Returns true when GPS layout was applied (≥2 nodes had coordinates).

function applyGpsToElements(elements, containerId) {

    const containerEl =
        document.getElementById(containerId);

    const canvasW =
        containerEl.offsetWidth || 800;

    const canvasH =
        containerEl.offsetHeight || 600;

    const nodeWrappers = elements
        .filter(e => !e.data.source)
        .map(e => ({
            data: e.data,
            position: e.position || { x: 0, y: 0 }
        }));

    // REAL GPS preserved
    // only viewport magnification increased
    const applied = applyGpsLayout(
        nodeWrappers,
        canvasW,
        canvasH,
        {
            padding: 80,

            // enlarges visual spacing
            // without changing geometry
            viewScale: 2.8,

            // IMPORTANT:
            // keep disabled to preserve true coordinates
            minDist: 0,
            collisionPasses: 0
        }
    );

    if (applied) {

        nodeWrappers.forEach(w => {

            const el =
                elements.find(
                    e => e.data.id === w.data.id
                );

            if (el) {
                el.position = {
                    x: w.position.x,
                    y: w.position.y
                };
            }
        });
    }

    return {
        applied,
        canvasW,
        canvasH
    };
}

// ─── GRAPH LAYOUT & INITIALIZATION Shared Helper ──────────────────────────────
function setupGraphLayout(elements, containerId) {
    const { applied } = applyGpsToElements(elements, containerId);
    initCy(containerId, elements, applied ? { name: 'preset' } : { name: 'cose', fit: false });
    // For GPS (preset) layouts the projected coordinates can span well beyond
    // the canvas (the projection magnifies for spacing), so cy.center() alone
    // leaves most nodes off-screen. cy.fit() frames the whole network while
    // preserving the exact geographic geometry — only the zoom/pan changes,
    // never the relative node positions. For auto (cose) layouts, fit too so
    // the result is consistently framed.
    if (applied) {
        cy.fit(undefined, 40);   // 40px padding around the geographic extent
    } else {
        cy.center();
    }
    _resetNodeSizeStep();
    return applied;
}

// ─── PREPROCESS MODE UI SWITCH ────────────────────────────────────────────────

function onPreprocessModeChange() {
    const mode   = document.getElementById('preprocessMode').value;
    const ta     = document.getElementById('inputData');
    const llPanel = document.getElementById('latlngPanel');
    const statusField = document.getElementById('statusJsonField');
    const edgesLabel  = document.querySelector('label[for="inputData"]');

    if (mode === 'from_zone_json') {
        ta.placeholder = 'Paste zone.json content here (geometry — required)…\n{\n  "nodes": […],\n  "edges": […]\n}';
        ta.style.fontFamily = 'monospace';
        ta.style.fontSize   = '12px';
        if (edgesLabel) edgesLabel.innerHTML = 'zone.json <span style="font-weight:600;color:var(--text3)">(geometry — required)</span>';
        if (statusField) statusField.style.display = '';
        if (llPanel) llPanel.style.display = 'none';
        document.body.classList.remove('mode-latlng');
    } else if (mode === 'latlng') {
        ta.placeholder  = 'Paste your node pairs here — one edge per line:\nWTP       V-E1-300\nV-E1-300  V-CDFG-500';
        ta.style.fontFamily = '';
        ta.style.fontSize   = '';
        if (edgesLabel) edgesLabel.textContent = 'Edge list';
        if (statusField) statusField.style.display = 'none';
        if (llPanel) { llPanel.style.display = 'block'; onLatlngModeActive(); }
        document.body.classList.add('mode-latlng');
    } else {
        ta.placeholder  = 'Paste your node pairs here — one edge per line:\nWTP       V-E1-300\nV-E1-300  V-CDFG-500';
        ta.style.fontFamily = '';
        ta.style.fontSize   = '';
        if (edgesLabel) edgesLabel.textContent = 'Edge list';
        if (statusField) statusField.style.display = 'none';
        if (llPanel) llPanel.style.display = 'none';
        // Note: we intentionally do NOT clear window._latlngCoords here. Keeping
        // it lets coordinates survive a round-trip through other modes (e.g.
        // latlng → none → latlng) so the table can re-seed them. The coords are
        // only ever *applied* while in latlng mode, so retaining them is inert
        // elsewhere.
        document.body.classList.remove('mode-latlng');
    }
    if (cy) cy.nodes().removeClass('search-highlight');
}

// ─── ZONE.JSON REVERSE IMPORT ─────────────────────────────────────────────────
// Called by analyzeGraph() when mode is from_zone_json.
// Parses the zone.json from the textarea, applies GPS layout via gps-layout.js
// if ≥2 nodes carry coordinates, then renders directly — bypassing the edge-pair
// pipeline so canonical IDs, positions, and lat/lng all round-trip correctly.

// Coerce a coordinate that may be a number OR a numeric string ("24.169")
// into a finite number, or null if it isn't usable. This makes JSON import
// tolerant of zone files that store lat/lng as strings.
function coerceCoord(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = parseFloat(v);
        return isFinite(n) ? n : null;
    }
    return null;
}

function loadFromZoneJSON() {
    const raw = document.getElementById('inputData').value.trim();
    if (!raw) { showToast('⚠️ Paste a zone.json first.', 'warning'); return false; }

    let diagram;
    try {
        diagram = JSON.parse(raw);
    } catch (e) {
        showToast('❌ Invalid JSON — ' + e.message, 'error'); return false;
    }

    if (!diagram.nodes || !diagram.edges) {
        showToast('❌ Expected { nodes, edges } at top level.', 'error'); return false;
    }

    if (!diagram.edges.length) {
        showToast('⚠️ No edges found in zone.json.', 'warning'); return false;
    }

    // ── Parse the OPTIONAL zone_status.json (label / state / type by id). ─────
    // zone.json carries only geometry; attributes live in a separate status
    // file. If the user pasted one in the second box, build a lookup by id;
    // otherwise every node defaults to label = id, state = "", type = "".
    const statusRaw = (document.getElementById('inputStatus')?.value || '').trim();
    const statusById = {};
    if (statusRaw) {
        try {
            const statusArr = JSON.parse(statusRaw);
            const arr = Array.isArray(statusArr) ? statusArr : (statusArr.nodes || []);
            arr.forEach(s => {
                const sd = s.data || s;
                if (sd && sd.id != null) {
                    statusById[sd.id] = {
                        label: (sd.label != null) ? String(sd.label) : undefined,
                        state: (sd.state != null) ? String(sd.state) : undefined,
                        type:  (sd.type  != null) ? String(sd.type)  : undefined
                    };
                }
            });
        } catch (e) {
            showToast('❌ Invalid zone_status.json — ' + e.message, 'error');
            return false;
        }
    }

    // ── Build Cytoscape elements directly from zone.json ──────────────────────
    // Nodes: carry id, label, lat, lng so exports round-trip faithfully.
    // Edges: carry source + target directly — no name-cleaning needed.
    const elements = [];

    diagram.nodes.forEach(n => {
        const d   = n.data || n;
        const pos = n.position || {};
        const id  = d.id || d.label || crypto.randomUUID();
        const st  = statusById[id] || {};
        // Merge precedence: status file → zone.json's own field → default.
        const label = (st.label != null) ? st.label : (d.label || id);
        const state = (st.state != null) ? st.state : (d.state != null ? String(d.state) : '');
        const type  = (st.type  != null) ? st.type  : (d.type  != null ? String(d.type)  : '');
        const data = {
            id:        id,
            label:     label,
            nameCount: 1,
            lat:       coerceCoord(d.lat),
            lng:       coerceCoord(d.lng)
        };
        if (type)  data.type  = type;
        if (state) data.state = state;
        elements.push({
            data,
            // Preserve any existing position from the JSON so a round-trip
            // doesn't discard manually edited positions.
            ...(pos.x !== undefined ? { position: { x: pos.x, y: pos.y } } : {})
        });
    });

    diagram.edges.forEach(e => {
        const d = e.data || e;
        elements.push({
            data: {
                id:     d.id || (d.source + '-' + d.target),
                source: d.source,
                target: d.target
            }
        });
    });

    // ── Capture coordinates + attributes so they flow into the table. ─────────
    const importedCoords = {};
    diagram.nodes.forEach(n => {
        const d = n.data || n;
        const id = d.id || d.label;
        if (!id) return;
        const st = statusById[id] || {};
        importedCoords[id] = {
            lat:   coerceCoord(d.lat),
            lng:   coerceCoord(d.lng),
            // Default label = id when no status label supplied; state/type = "".
            label: (st.label != null) ? st.label : (d.label != null ? String(d.label) : id),
            state: (st.state != null) ? st.state : (d.state != null ? String(d.state) : ''),
            type:  (st.type  != null) ? st.type  : (d.type  != null ? String(d.type)  : '')
        };
    });
    window._latlngCoords = importedCoords;

    // ── Apply Layout and Init Cytoscape ───────────────────────────────────────
    const gpsApplied = setupGraphLayout(elements, 'graph');

    // ── Also run the text-based analysis pipeline for the sidebar report ──────
    // Populate inputData so parseInput() can derive the graph structure.
    const lines = diagram.edges.map(e => {
        const d = e.data || e;
        return (d.source || '') + '\t' + (d.target || '');
    });
    // Switch to lat-long mode and surface the imported coordinates in the table,
    // so the user can see/edit them and re-render. IDs from JSON are canonical,
    // so cleanNodeName() already treats latlng mode as a no-op.
    document.getElementById('preprocessMode').value = 'latlng';
    document.getElementById('inputData').value = lines.join('\n');
    document.body.classList.add('mode-latlng');
    const llPanel = document.getElementById('latlngPanel');
    if (llPanel) llPanel.style.display = 'block';
    // Clear any rows from a previous import so the freshly-parsed JSON +
    // status data seed cleanly (stale rows would otherwise be preserved and
    // block the new label/state/type values).
    document.getElementById('latlngBody').innerHTML = '';
    buildLatlngTable();   // reads edge list + seeds from window._latlngCoords

    // Re-run analysis only (skip drawGraph — cy is already initialised above)
    const { graph, rawPairs, orphans, selfLoops } = parseInput();
    const duplicates   = findDuplicates(rawPairs);
    const midpoints    = findMidpoints(graph);
    const cycles       = findCycles(graph);
    const overbranches = findOverbranched(graph);
    latestReport = { duplicates, midpoints, cycles, overbranches, orphans, selfLoops };
    renderReport(duplicates, midpoints, selfLoops, overbranches, orphans);

    // Mark overbranched nodes on the already-rendered cy instance
    overbranches.forEach(id => {
        const n = cy.getElementById(id);
        if (n && n.length) n.addClass('overbranched');
    });

    const gpsCount = diagram.nodes.filter(n => {
        const d = n.data || n;
        return coerceCoord(d.lat) != null && coerceCoord(d.lng) != null;
    }).length;
    const layoutMsg = gpsApplied ? ` · 📡 GPS layout (${gpsCount} nodes)` : ' · 🔀 Auto layout';
    showToast(`✅ ${diagram.nodes.length} nodes, ${diagram.edges.length} edges${layoutMsg}`, 'success');
    return true;
}

function cleanNodeName(rawName) {
    let mode = document.getElementById('preprocessMode').value;
    let name = rawName;

    if (mode === 'from_zone_json' || mode === 'latlng') mode = 'none';   // zone/latlng IDs are canonical

    if (mode === 'ignore_prefix_and_symbols') {
        name = name.replace(/[^A-Za-z0-9]/g, '');
        name = name.replace(/^[A-Za-z]+/, '');
        name = name.toUpperCase();
    } else if (mode === 'ignore_symbols_only') {
        name = name.replace(/[^A-Za-z0-9]/g, '');
        name = name.toUpperCase();
    } else {
        name = name.trim();   // 'none' — preserve as-is
    }

    return name;
}

function getOriginalNames(internalName) {
    return Array.from(nodeNameMap.get(internalName) || [internalName]).join(' / ');
}

// Tokenises one line and registers raw→internal mappings into the given maps.
// Shared by both the main analyser and the comparison parser.
function preprocessLine(line, nameMap, origLookup) {
    const tokens = [];
    for (const rawToken of line.trim().split(/\s+/)) {
        const id = cleanNodeName(rawToken);
        if (!id) continue;
        tokens.push(id);
        if (!nameMap.has(id)) nameMap.set(id, new Set());
        nameMap.get(id).add(rawToken);
        origLookup.set(rawToken, id);
    }
    return tokens;
}

// ─── PARSE ────────────────────────────────────────────────────────────────────

function parseInput() {
    nodeNameMap.clear();
    originalNodeLookup.clear();

    const lines     = document.getElementById('inputData').value.trim().split(/\n+/);
    const graph     = {};
    const rawPairs  = [];
    const orphans   = [];
    const selfLoops = [];

    for (const line of lines) {
        const tokens = preprocessLine(line, nodeNameMap, originalNodeLookup);
        if (tokens.length !== 2) { orphans.push(line); continue; }

        const [a, b] = tokens;
        if (a === b) { selfLoops.push(a); continue; }

        rawPairs.push([a, b]);
        graph[a] = graph[a] || new Set();
        graph[b] = graph[b] || new Set();
        graph[a].add(b);
        graph[b].add(a);
    }

    return { graph, rawPairs, orphans, selfLoops };
}

// Parse a comparison textarea using isolated maps so comparison state
// does not pollute the global analyser maps.
function parseInputForComparison(inputElementId) {
    const localNameMap    = new Map();
    const localOrigLookup = new Map();

    const lines    = document.getElementById(inputElementId).value.trim().split(/\n+/);
    const graph    = {};
    const rawPairs = [];

    for (const line of lines) {
        const tokens = preprocessLine(line, localNameMap, localOrigLookup);
        if (tokens.length !== 2) continue;
        const [a, b] = tokens;
        if (a === b) continue;

        rawPairs.push([a, b]);
        graph[a] = graph[a] || new Set();
        graph[b] = graph[b] || new Set();
        graph[a].add(b);
        graph[b].add(a);
    }

    return { graph, rawPairs, localNameMap, localOrigLookup };
}

// ─── ANALYSIS ─────────────────────────────────────────────────────────────────

function findDuplicates(pairs) {
    const seen   = new Map();
    const report = [];

    for (const [a, b] of pairs) {
        const directKey  = `${a}|${b}`;
        const reverseKey = `${b}|${a}`;

        seen.set(directKey, (seen.get(directKey) || 0) + 1);
        if (seen.get(directKey) > 1)
            report.push({ type: 'Repeated', a, b });
        if (seen.has(reverseKey) && directKey !== reverseKey)
            report.push({ type: 'Bidirectional', a, b });
    }

    return report;
}

function findMidpoints(graph) {
    const result = new Map();

    for (const node in graph) {
        const neighbors = Array.from(graph[node]);
        for (let i = 0; i < neighbors.length; i++) {
            for (let j = i + 1; j < neighbors.length; j++) {
                const ni = neighbors[i], nj = neighbors[j];
                if (graph[ni] && graph[ni].has(nj)) {
                    const key = [node, ni, nj].sort().join('|');
                    result.set(key, [node, ni, nj].sort());
                }
            }
        }
    }

    return Array.from(result.values());
}

function findCycles(graph) {
    const cycles  = new Set();
    const visited = new Set();

    function dfs(node, path, parent) {
        visited.add(node);
        path.push(node);
        for (const neighbor of graph[node] || []) {
            if (neighbor === parent) continue;
            if (path.includes(neighbor)) {
                const cycle = path.slice(path.indexOf(neighbor)).concat(neighbor);
                cycles.add([...new Set(cycle)].sort().join('|'));
            } else if (!visited.has(neighbor)) {
                dfs(neighbor, path, node);
            }
        }
        path.pop();
    }

    for (const node in graph) {
        if (!visited.has(node)) dfs(node, [], null);
    }

    return Array.from(cycles).map(c => c.split('|'));
}

function findOverbranched(graph) {
    return Object.entries(graph)
        .filter(([, edges]) => edges.size >= 4)
        .map(([node]) => node);
}

// ─── RENDER ───────────────────────────────────────────────────────────────────

function drawGraph(pairs, duplicates, overbranchedSet) {
    const elements       = [];
    const nodeSet        = new Set();
    const duplicateEdges = new Set();

    duplicates.forEach(({ a, b }) => {
        duplicateEdges.add(`${a}-${b}`);
        duplicateEdges.add(`${b}-${a}`);
    });

    for (const [a, b] of pairs) {
        nodeSet.add(a);
        nodeSet.add(b);
        elements.push({
            data:    { id: `${a}-${b}`, source: a, target: b },
            classes: duplicateEdges.has(`${a}-${b}`) ? 'duplicate' : ''
        });
    }

    // Collect lat/lng from the preprocess table when in latlng mode
    const coordMap = (document.getElementById('preprocessMode').value === 'latlng' && window._latlngCoords)
        ? window._latlngCoords : {};

    for (const node of nodeSet) {
        const originalNames = Array.from(nodeNameMap.get(node) || [node]);
        const coord = coordMap[node] || {};
        const data = {
            id:        node,
            // Prefer a label typed in the table; otherwise use the derived names.
            label:     (coord.label && coord.label.trim()) ? coord.label : originalNames.join('\n'),
            nameCount: originalNames.length,
            lat:       typeof coord.lat === 'number' ? coord.lat : null,
            lng:       typeof coord.lng === 'number' ? coord.lng : null
        };
        // Only attach type/state when provided, so untyped nodes keep the
        // default dot styling (Cytoscape selectors key off node[type]).
        if (coord.type)  data.type  = coord.type;
        if (coord.state) data.state = coord.state;
        elements.push({
            data,
            classes: overbranchedSet.has(node) ? 'overbranched' : ''
        });
    }

    // ── Apply Layout and Init Cytoscape ───────────────────────────────────────
    setupGraphLayout(elements, 'graph');
}

// ─── ANALYSE & REPORT ─────────────────────────────────────────────────────────

function analyzeGraph() {
    // JSON import mode: delegate to loader
    if (document.getElementById('preprocessMode').value === 'from_zone_json') {
        loadFromZoneJSON();
        return;
    }
    // lat-lng mode: rebuild the table first, collect coordinates,
    // then fall through to the normal analysis pipeline.
    if (document.getElementById('preprocessMode').value === 'latlng') {
        buildLatlngTable();
        window._latlngCoords = collectLatlngTable();
    }

    const { graph, rawPairs, orphans, selfLoops } = parseInput();

    const duplicates    = findDuplicates(rawPairs);
    const midpoints     = findMidpoints(graph);
    const cycles        = findCycles(graph);
    const overbranches  = findOverbranched(graph);

    latestReport = { duplicates, midpoints, cycles, overbranches, orphans, selfLoops };
    renderReport(duplicates, midpoints, selfLoops, overbranches, orphans);
    drawGraph(rawPairs, duplicates, new Set(overbranches));
}

// ─── SIDEBAR REPORT RENDERER ──────────────────────────────────────────────────
// Shared by analyzeGraph() and loadFromZoneJSON() so the sidebar is always
// populated regardless of which pipeline produced the graph.

function renderReport(duplicates, midpoints, selfLoops, overbranches, orphans) {
    const repeated      = duplicates.filter(d => d.type === 'Repeated');
    const bidirectional = duplicates.filter(d => d.type === 'Bidirectional');

    let dupHtml = '';
    if (repeated.length) {
        dupHtml += '<h4>Repeated Edges:</h4>' +
            repeated.map((d, i) =>
                `${i+1}. <a href="#" onclick="highlightNodes(['${d.a}','${d.b}']); return false;">` +
                `${getOriginalNames(d.a)} &lt;-&gt; ${getOriginalNames(d.b)}</a>`
            ).join(', ');
    }
    if (bidirectional.length) {
        if (repeated.length) dupHtml += '<br><br>';
        dupHtml += '<h4>Bidirectional Edges:</h4>' +
            bidirectional.map((d, i) =>
                `${i+1}. <a href="#" onclick="highlightNodes(['${d.a}','${d.b}']); return false;">` +
                `${getOriginalNames(d.a)} &lt;-&gt; ${getOriginalNames(d.b)}</a>`
            ).join(', ');
    }
    document.getElementById('duplicates').innerHTML = dupHtml || 'None';

    document.getElementById('midpoints').innerHTML = midpoints.length
        ? midpoints.map((trio, i) =>
            `${i+1}. <a href="#" onclick='highlightNodes(${JSON.stringify(trio)}); return false;'>` +
            `${trio.map(n => getOriginalNames(n)).join(' - ')}</a>`
          ).join(', ')
        : 'None';

    document.getElementById('loops').innerHTML = selfLoops.length
        ? selfLoops.map((n, i) =>
            `${i+1}. <a href="#" onclick="highlightNode('${n}'); return false;">` +
            `${getOriginalNames(n)} (self-loop)</a>`
          ).join(', ')
        : 'None';

    document.getElementById('branches').innerHTML = overbranches.length
        ? overbranches.map((n, i) =>
            `${i+1}. <a href="#" onclick="highlightNode('${n}'); return false;">` +
            `${getOriginalNames(n)}</a>`
          ).join(', ')
        : 'None';

    document.getElementById('orphans').innerHTML = orphans.length
        ? orphans.map((line, i) => `${i+1}. ${esc(line)}`).join(', ')
        : 'None';
}

// ─── SEARCH & HIGHLIGHT ───────────────────────────────────────────────────────

function searchNode() {
    const query = document.getElementById('searchBox').value.trim().toUpperCase();
    if (!cy) return;
    cy.nodes().removeClass('search-highlight');
    if (!query) return;
    const matched = cy.nodes().filter(n => n.data('label').toUpperCase().includes(query));
    matched.addClass('search-highlight');
    if (matched.length) cy.fit(matched, 50);
}

// ─── FILE DOWNLOAD & CLIPBOARD HELPERS ───────────────────────────────────────

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

function exportZoneJSON() {
    if (!cy) { showToast('⚠️ No graph rendered yet.', 'warning'); return; }

    const nodes = cy.nodes().map(n => ({
        data: {
            id:  n.data('id'),
            lat: typeof n.data('lat') === 'number' ? n.data('lat') : '',
            lng: typeof n.data('lng') === 'number' ? n.data('lng') : ''
        },
        position: { x: Math.round(n.position('x')), y: Math.round(n.position('y')) }
    }));

    const edges = cy.edges().map(e => ({
        data: {
            id:     e.data('id') || (e.data('source') + '_' + e.data('target')),
            source: e.data('source'),
            target: e.data('target')
        }
    }));

    const zoneJson = '{\n  "nodes": [\n'
        + nodes.map(n => '    ' + JSON.stringify(n)).join(',\n')
        + '\n  ],\n  "edges": [\n'
        + edges.map(e => '    ' + JSON.stringify(e)).join(',\n')
        + '\n  ]\n}';
    downloadFile(zoneJson, 'zone.json', 'application/json');
    showToast('✅ zone.json downloaded!', 'success');
}

function exportStatusJSON() {
    if (!cy) { showToast('⚠️ No graph rendered yet.', 'warning'); return; }

    const entries = [];

    cy.nodes().forEach(n => {
        entries.push({
            id:      n.data('id'),
            label:   n.data('label') || '',
            type:    n.data('type')  || '',
            state:   n.data('state') || '',
            comment: ''
        });
    });

    cy.edges().forEach(e => entries.push({
        id:   e.data('id') || (e.data('source') + '_' + e.data('target')),
        flow: e.data('flow') || ''
    }));

    const statusJson = '[\n'
        + entries.map(e => '  ' + JSON.stringify(e)).join(',\n')
        + '\n]';
    downloadFile(statusJson, 'zone_status.json', 'application/json');
    showToast('✅ zone_status.json downloaded!', 'success');
}

// CSV analysis report
function downloadCSV() {
    const fmt = n => getOriginalNames(n);
    const rows = [];

    (latestReport.duplicates   || []).forEach(({ a, b, type }) =>
        rows.push({ Section: 'Duplicate Edge',    Details: `${fmt(a)} <-> ${fmt(b)} [${type}]` }));
    (latestReport.midpoints    || []).forEach(trio =>
        rows.push({ Section: 'Triangle',          Details: trio.map(fmt).join(' - ') }));
    (latestReport.cycles       || []).forEach(cycle =>
        rows.push({ Section: 'Cycle',             Details: cycle.map(fmt).join(' -> ') }));
    (latestReport.selfLoops    || []).forEach(n =>
        rows.push({ Section: 'Self-Loop',         Details: fmt(n) }));
    (latestReport.overbranches || []).forEach(n =>
        rows.push({ Section: 'Overbranched Node', Details: fmt(n) }));
    (latestReport.orphans      || []).forEach(line =>
        rows.push({ Section: 'Malformed Line',    Details: line }));

    const csv = '\uFEFF' + Papa.unparse(rows, { columns: ['Section', 'Details'] });
    downloadFile(csv, 'graph_analysis_report.csv', 'text/csv;charset=utf-8;');
}

// ─── COMPARE GRAPHS ───────────────────────────────────────────────────────────

function compareAndRenderGraphs() {
    const g1 = parseInputForComparison('inputData1');
    const g2 = parseInputForComparison('inputData2');

    const nodes1 = new Set(Object.keys(g1.graph));
    const nodes2 = new Set(Object.keys(g2.graph));
    const edges1 = new Set(g1.rawPairs.map(p => [...p].sort().join('-')));
    const edges2 = new Set(g2.rawPairs.map(p => [...p].sort().join('-')));

    const elements = [];

    for (const node of new Set([...nodes1, ...nodes2])) {
        const cls = (nodes1.has(node) && nodes2.has(node)) ? 'common-node'
                  :  nodes1.has(node) ? 'graph1-unique-node' : 'graph2-unique-node';
        elements.push({ data: { id: node, label: node, nameCount: 1 }, classes: cls });
    }

    for (const edgeKey of new Set([...edges1, ...edges2])) {
        const [source, target] = edgeKey.split('-');
        const cls = (edges1.has(edgeKey) && edges2.has(edgeKey)) ? 'common-edge'
                  :  edges1.has(edgeKey) ? 'graph1-unique-edge' : 'graph2-unique-edge';
        elements.push({ data: { id: edgeKey, source, target }, classes: cls });
    }

    const compareStyles = [
        { selector: '.common-node',        style: { 'background-color': 'blue' } },
        { selector: '.graph1-unique-node', style: { 'background-color': 'red'  } },
        { selector: '.graph2-unique-node', style: { 'background-color': 'red'  } },
        { selector: '.common-edge',        style: { 'line-color': 'blue', 'width': 3 } },
        { selector: '.graph1-unique-edge', style: { 'line-color': 'red',  'width': 3, 'line-style': 'dashed' } },
        { selector: '.graph2-unique-edge', style: { 'line-color': 'red',  'width': 3, 'line-style': 'dashed' } }
    ];

    initCy('compareGraph', elements, { name: 'cose' }, compareStyles);
}

// ─── HELP MODAL ───────────────────────────────────────────────────────────────
// openHelp()/closeHelp() and the backdrop-click handler live in graph-analyzer.html
// (they include focus-trapping); defining them here too would just shadow those.

// ─── BOOT ─────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {

    updateClock();
    setInterval(updateClock, 1000);

    // Tab-key indent in all textareas
    document.querySelectorAll('textarea').forEach(ta => {
        ta.addEventListener('keydown', e => {
            if (e.key !== 'Tab') return;
            e.preventDefault();
            const s = ta.selectionStart, end = ta.selectionEnd;
            ta.value = ta.value.slice(0, s) + '\t' + ta.value.slice(end);
            ta.selectionStart = ta.selectionEnd = s + 1;
        });
    });

    // Loading screen
    const bar = document.getElementById('loadingBar');
    const txt = document.getElementById('loadingText');
    txt.textContent = 'Loading graph tools…';
    bar.style.width = '60%';
    setTimeout(() => {
        bar.style.width = '100%';
        txt.textContent = 'Ready!';
        setTimeout(() => {
            const ls = document.getElementById('loadingScreen');
            ls.classList.add('hide');
            setTimeout(() => { ls.style.display = 'none'; }, 450);
        }, 300);
    }, 400);
});


// ─── LAT-LNG PREPROCESS MODE ──────────────────────────────────────────────────

function onLatlngModeActive() {
    document.getElementById('latlngPanel').style.display = 'block';
    buildLatlngTable();
}

// Parse edge textarea → unique node IDs, preserving any lat/lng already typed.
function buildLatlngTable() {
    const raw   = document.getElementById('inputData').value;
    const seen  = new Set();
    const order = [];

    // The textarea may hold either an edge list OR pasted zone.json (when the
    // user pastes JSON then switches straight to lat-long mode without first
    // clicking Analyze). Detect JSON and pull node IDs + coordinates from it so
    // the table populates correctly in both cases.
    const jsonCoords = {};
    let parsedJson = false;
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const obj = JSON.parse(trimmed);
            const nodeArr = Array.isArray(obj) ? obj : (obj.nodes || []);
            if (Array.isArray(nodeArr) && nodeArr.length) {
                nodeArr.forEach(n => {
                    const d  = n.data || n;
                    const id = d.id || d.label;
                    if (id && !seen.has(id)) { seen.add(id); order.push(id); }
                    if (id) jsonCoords[id] = {
                        lat:   coerceCoord(d.lat),
                        lng:   coerceCoord(d.lng),
                        label: (d.label != null) ? String(d.label) : '',
                        state: (d.state != null) ? String(d.state) : '',
                        type:  (d.type  != null) ? String(d.type)  : ''
                    };
                });
                parsedJson = true;
            }
        } catch (_) { /* not valid JSON → fall through to edge-list parsing */ }
    }

    if (!parsedJson) {
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        lines.forEach(line => {
            const parts = line.split(/\s+/);
            if (parts.length === 2) {
                [parts[0], parts[1]].forEach(id => {
                    if (!seen.has(id)) { seen.add(id); order.push(id); }
                });
            }
        });
    }

    // Sort node IDs A–Z for the coordinate table (natural/numeric-aware).
    order.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    // Preserve existing values so edits survive a rebuild
    const existing = {};
    document.querySelectorAll('#latlngBody tr').forEach(tr => {
        const id  = tr.dataset.nodeId;
        const lat = tr.querySelector('.ll-lat') ? tr.querySelector('.ll-lat').value.trim() : '';
        const lng = tr.querySelector('.ll-lng') ? tr.querySelector('.ll-lng').value.trim() : '';
        const label = tr.querySelector('.ll-label') ? tr.querySelector('.ll-label').value.trim() : '';
        const state = tr.querySelector('.ll-state') ? tr.querySelector('.ll-state').value : '';
        const type  = tr.querySelector('.ll-type')  ? tr.querySelector('.ll-type').value  : '';
        if (id) existing[id] = { lat, lng, label, state, type };
    });

    // Seed from coordinates/attributes parsed out of pasted JSON (above) and
    // from any externally-supplied data (e.g. a prior zone.json import), but
    // only where the user hasn't already typed/selected a value in the table.
    const seed = Object.assign({}, window._latlngCoords || {}, parsedJson ? jsonCoords : {});
    Object.keys(seed).forEach(id => {
        const s = seed[id] || {};
        const sLat   = (s.lat   != null) ? String(s.lat)   : '';
        const sLng   = (s.lng   != null) ? String(s.lng)   : '';
        const sLabel = (s.label != null) ? String(s.label) : '';
        const sState = (s.state != null) ? String(s.state) : '';
        const sType  = (s.type  != null) ? String(s.type)  : '';
        const cur = existing[id];
        if (!cur) {
            existing[id] = { lat: sLat, lng: sLng, label: sLabel, state: sState, type: sType };
        } else {
            if (!cur.lat)   cur.lat   = sLat;
            if (!cur.lng)   cur.lng   = sLng;
            if (!cur.label) cur.label = sLabel;
            if (!cur.state) cur.state = sState;
            if (!cur.type)  cur.type  = sType;
        }
    });

    const tbody = document.getElementById('latlngBody');
    tbody.innerHTML = '';

    if (!order.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:12px;color:var(--text3)">Paste edges in the textarea above first, then click Rebuild.</td></tr>';
        return;
    }

    order.forEach((id, i) => {
        const prev = existing[id] || {};
        const tr   = document.createElement('tr');
        tr.dataset.nodeId = id;

        const tdNum  = document.createElement('td');
        tdNum.style.cssText = 'color:var(--text3);font-size:12px;text-align:center';
        tdNum.textContent   = i + 1;

        const tdId  = document.createElement('td');
        tdId.style.cssText  = 'font-weight:700;color:var(--text)';
        tdId.textContent    = id;

        const tdLat = document.createElement('td');
        const inLat = document.createElement('input');
        inLat.className   = 'll-lat';
        inLat.type        = 'number';
        inLat.step        = 'any';
        inLat.placeholder = 'e.g. 24.1693';
        inLat.value       = prev.lat || '';
        tdLat.appendChild(inLat);

        const tdLng = document.createElement('td');
        const inLng = document.createElement('input');
        inLng.className   = 'll-lng';
        inLng.type        = 'number';
        inLng.step        = 'any';
        inLng.placeholder = 'e.g. 88.2790';
        inLng.value       = prev.lng || '';
        tdLng.appendChild(inLng);

        // Label — free text (defaults to the node id if none given)
        const tdLabel = document.createElement('td');
        const inLabel = document.createElement('input');
        inLabel.className   = 'll-label';
        inLabel.type        = 'text';
        inLabel.placeholder = id;
        inLabel.value       = prev.label || '';
        tdLabel.appendChild(inLabel);

        // State — dropdown (blank / ON / OFF)
        const tdState = document.createElement('td');
        const selState = document.createElement('select');
        selState.className = 'll-state';
        ['', 'ON', 'OFF'].forEach(v => {
            const o = document.createElement('option');
            o.value = v; o.textContent = v || '—';
            if ((prev.state || '') === v) o.selected = true;
            selState.appendChild(o);
        });
        tdState.appendChild(selState);

        // Type — dropdown (blank / valve / pump / zone)
        const tdType = document.createElement('td');
        const selType = document.createElement('select');
        selType.className = 'll-type';
        ['', 'valve', 'pump', 'zone'].forEach(v => {
            const o = document.createElement('option');
            o.value = v; o.textContent = v || '—';
            if ((prev.type || '') === v) o.selected = true;
            selType.appendChild(o);
        });
        tdType.appendChild(selType);

        tr.append(tdNum, tdId, tdLabel, tdType, tdState, tdLat, tdLng);
        tbody.appendChild(tr);
    });
}

// Read every field from the lat-long table into a coords map keyed by node id.
// Used by applyLatlngAndRender() and analyzeGraph() so collection stays in sync.
function collectLatlngTable() {
    const coords = {};
    document.querySelectorAll('#latlngBody tr').forEach(tr => {
        const id = tr.dataset.nodeId;
        if (!id) return;
        const lat   = parseFloat(tr.querySelector('.ll-lat')   ? tr.querySelector('.ll-lat').value   : '');
        const lng   = parseFloat(tr.querySelector('.ll-lng')   ? tr.querySelector('.ll-lng').value   : '');
        const label = tr.querySelector('.ll-label') ? tr.querySelector('.ll-label').value.trim() : '';
        const state = tr.querySelector('.ll-state') ? tr.querySelector('.ll-state').value : '';
        const type  = tr.querySelector('.ll-type')  ? tr.querySelector('.ll-type').value  : '';
        coords[id] = {
            lat: isFinite(lat) ? lat : null,
            lng: isFinite(lng) ? lng : null,
            label, state, type
        };
    });
    return coords;
}

// Read table coords → store on window → trigger analysis pipeline.
function applyLatlngAndRender() {
    window._latlngCoords = collectLatlngTable();
    analyzeGraph();
}

// ─── EXCEL PASTE HANDLER FOR LAT-LNG TABLE ────────────────────────────────────
(function attachLatlngPasteHandler() {
    document.addEventListener('paste', function(e) {
        const active = document.activeElement;
        if (!active || (!active.classList.contains('ll-lat') && !active.classList.contains('ll-lng'))) return;

        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (!text) return;

        if (!text.includes('\t') && !text.includes('\n')) return;

        e.preventDefault();

        const rows = text.trim().split(/\r?\n/).map(r => r.split('\t').map(v => v.trim()));

        const tbody    = document.getElementById('latlngBody');
        if (!tbody) return;
        const allRows  = Array.from(tbody.querySelectorAll('tr'));
        const startRow = allRows.indexOf(active.closest('tr'));
        if (startRow === -1) return;

        const isLat    = active.classList.contains('ll-lat');

        rows.forEach((cols, i) => {
            const tr = allRows[startRow + i];
            if (!tr) return;

            const latInput = tr.querySelector('.ll-lat');
            const lngInput = tr.querySelector('.ll-lng');

            if (cols.length === 1) {
                const target = isLat ? latInput : lngInput;
                if (target) target.value = cols[0];

            } else if (cols.length === 2) {
                if (latInput) latInput.value = cols[0];
                if (lngInput) lngInput.value = cols[1];

            } else {
                const lat = cols[cols.length - 2];
                const lng = cols[cols.length - 1];
                if (latInput) latInput.value = lat;
                if (lngInput) lngInput.value = lng;
            }
        });

        showToast(`✅ Pasted ${rows.length} row${rows.length > 1 ? 's' : ''}`, 'success');
    });
})();