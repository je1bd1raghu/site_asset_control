// ─── SHARED HELPERS ───────────────────────────────────────────────────────────

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function updateClock() {
    const now    = new Date();
    const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const hd = document.getElementById('headerDate');
    if (hd) hd.textContent =
        DAYS[now.getDay()] + ', ' + MONTHS[now.getMonth()] + ' ' +
        now.getDate() + ', ' + now.getFullYear();
}

function esc(s) {
    return String(s).replace(/[<>&"]/g, c =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

let _toastTmr;
function showToast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className   = 'toast ' + (type || '');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(_toastTmr);
    _toastTmr = setTimeout(() => el.classList.remove('show'), 3400);

    // Mirror to the screen-reader live region so AT users hear status messages
    const sr = document.getElementById('sr-announcer');
    if (sr) { sr.textContent = ''; requestAnimationFrame(() => { sr.textContent = msg; }); }
}

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
        wheelSensitivity: 0.2
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

// ─── PREPROCESS MODE UI SWITCH ────────────────────────────────────────────────

function onPreprocessModeChange() {
    const mode   = document.getElementById('preprocessMode').value;
    const ta     = document.getElementById('inputData');
    const llPanel = document.getElementById('latlngPanel');

    if (mode === 'from_zone_json') {
        ta.placeholder = 'Paste zone.json content here…\n{\n  "nodes": […],\n  "edges": […]\n}';
        ta.style.fontFamily = 'monospace';
        ta.style.fontSize   = '12px';
        if (llPanel) llPanel.style.display = 'none';
        document.body.classList.remove('mode-latlng');
    } else if (mode === 'latlng') {
        ta.placeholder  = 'Paste your node pairs here — one edge per line:\nWTP       V-E1-300\nV-E1-300  V-CDFG-500';
        ta.style.fontFamily = '';
        ta.style.fontSize   = '';
        if (llPanel) { llPanel.style.display = 'block'; onLatlngModeActive(); }
        document.body.classList.add('mode-latlng');
    } else {
        ta.placeholder  = 'Paste your node pairs here — one edge per line:\nWTP       V-E1-300\nV-E1-300  V-CDFG-500';
        ta.style.fontFamily = '';
        ta.style.fontSize   = '';
        if (llPanel) llPanel.style.display = 'none';
        window._latlngCoords = null;
        document.body.classList.remove('mode-latlng');
    }
    if (cy) cy.nodes().removeClass('search-highlight');
}

// ─── ZONE.JSON REVERSE IMPORT ─────────────────────────────────────────────────
// Called by analyzeGraph() when mode is from_zone_json.
// Parses the zone.json from the textarea, applies GPS layout via gps-layout.js
// if ≥2 nodes carry coordinates, then renders directly — bypassing the edge-pair
// pipeline so canonical IDs, positions, and lat/lng all round-trip correctly.

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

    // ── Build Cytoscape elements directly from zone.json ──────────────────────
    // Nodes: carry id, label, lat, lng so exports round-trip faithfully.
    // Edges: carry source + target directly — no name-cleaning needed.
    const elements = [];

    diagram.nodes.forEach(n => {
        const d   = n.data || n;
        const pos = n.position || {};
        elements.push({
            data: {
                id:        d.id || d.label || crypto.randomUUID(),
                label:     d.label || d.id || null,
                nameCount: 1,
                lat:       typeof d.lat === 'number' ? d.lat : null,
                lng:       typeof d.lng === 'number' ? d.lng : null
            },
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

    // ── Apply GPS layout (overwrites positions when ≥2 GPS nodes found) ───────
    const { applied: gpsApplied, canvasW, canvasH } = applyGpsToElements(elements, 'graph');

    // ── Init Cytoscape ────────────────────────────────────────────────────────
    initCy('graph', elements, gpsApplied ? { name: 'preset' } : { name: 'cose' });
    _resetNodeSizeStep();

    if (gpsApplied) {
        cy.fit(undefined, 40);
        if (cy.zoom() < 0.9) cy.zoom({ level: 0.9, renderedPosition: { x: canvasW / 2, y: canvasH / 2 } });
    }

    // ── Also run the text-based analysis pipeline for the sidebar report ──────
    // Populate inputData so parseInput() can derive the graph structure.
    const lines = diagram.edges.map(e => {
        const d = e.data || e;
        return (d.source || '') + '\t' + (d.target || '');
    });
    document.getElementById('preprocessMode').value = 'none';
    document.getElementById('inputData').value = lines.join('\n');

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
        return typeof d.lat === 'number' && typeof d.lng === 'number';
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
        elements.push({
            data: {
                id:        node,
                label:     originalNames.join('\n'),
                nameCount: originalNames.length,
                lat:       typeof coord.lat === 'number' ? coord.lat : null,
                lng:       typeof coord.lng === 'number' ? coord.lng : null
            },
            classes: overbranchedSet.has(node) ? 'overbranched' : ''
        });
    }

    // Apply GPS layout when any node has coordinates (latlng mode)
    const hasCoords = Object.values(coordMap).some(c => typeof c.lat === 'number');
    if (hasCoords) {
        applyGpsToElements(elements, 'graph');
    }

    const newCy = initCy('graph', elements, hasCoords ? { name: 'preset' } : { name: 'cose' });
    _resetNodeSizeStep();

    if (hasCoords) {
        const container = document.getElementById('graph');
        const canvasW = container.offsetWidth  || 800;
        const canvasH = container.offsetHeight || 600;
        newCy.fit(undefined, 40);
        if (newCy.zoom() < 0.9) newCy.zoom({ level: 0.9, renderedPosition: { x: canvasW / 2, y: canvasH / 2 } });
    }
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
        const coords = {};
        document.querySelectorAll('#latlngBody tr').forEach(tr => {
            const id  = tr.dataset.nodeId;
            const lat = parseFloat(tr.querySelector('.ll-lat')?.value ?? '');
            const lng = parseFloat(tr.querySelector('.ll-lng')?.value ?? '');
            if (id) coords[id] = {
                lat: isFinite(lat) ? lat : null,
                lng: isFinite(lng) ? lng : null
            };
        });
        window._latlngCoords = coords;
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

function highlightNode(name) {
    if (!cy) return;
    cy.nodes().removeClass('search-highlight');
    const node = cy.getElementById(cleanNodeName(name));
    if (node && node.length) { node.addClass('search-highlight'); cy.fit(node, 50); }
}

function highlightNodes(nodeList) {
    if (!cy) return;
    cy.nodes().removeClass('search-highlight');
    const coll = cy.collection();
    for (const name of nodeList) {
        const node = cy.getElementById(cleanNodeName(name));
        if (node && node.length) { node.addClass('search-highlight'); coll.merge(node); }
    }
    if (coll.length) cy.fit(coll, 50);
}

// ─── FILE DOWNLOAD & CLIPBOARD HELPERS ───────────────────────────────────────

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
}

function copyToClipboard(text, successMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
            .then(() => showToast(successMsg, 'success'))
            .catch(() => _fallbackCopy(text, successMsg));
    } else {
        _fallbackCopy(text, successMsg);
    }
}

function _fallbackCopy(text, successMsg) {
    const ta = Object.assign(document.createElement('textarea'),
        { value: text, style: 'position:fixed;opacity:0' });
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try   { document.execCommand('copy'); showToast(successMsg, 'success'); }
    catch (e) { showToast('Could not copy — check console.', 'error'); console.error(e); }
    document.body.removeChild(ta);
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

/**
 * Export  zone_x.json  ── repo / static topology file
 * ────────────────────────────────────────────────────
 * Contains ONLY structural data so the repo file and the gist status file
 * own completely separate fields and never overwrite each other.
 *
 * Schema:
 *   {
 *     nodes: [ { data: { id, lat, lng }, position: { x, y } } ],
 *     edges: [ { data: { id, source, target } } ]
 *   }
 *
 * type / state / label / flow are intentionally absent — those are
 * set at runtime by applyStatus() reading the status file.
 */
function exportZoneJSON() {
    if (!cy) { showToast('⚠️ No graph rendered yet.', 'warning'); return; }

    // Node id is the topology string (e.g. "J-1") set at render time.
    // Edges use the same id as source/target so the files are self-consistent.
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

/**
 * Export  zone_x_status.json  ── gist / live operational file
 * ────────────────────────────────────────────────────────────
 * Flat array consumed by applyStatus() in scada-core.js.
 * Nodes carry type, label, state.  Edges carry flow.
 * Positions and topology are intentionally absent — those live in zone.json.
 *
 * Schema:
 *   [
 *     { id, type, label, state },   ← one entry per node
 *     { id, flow },                  ← one entry per edge
 *     …
 *   ]
 */
function exportStatusJSON() {
    if (!cy) { showToast('⚠️ No graph rendered yet.', 'warning'); return; }

    const entries = [];

    cy.nodes().forEach(n => {
        // id — topology string (e.g. "J-1"), matches node id in zone.json exactly.
        // label — human-readable node name from the graph
        // type, state, comment — always present; "" when not yet assigned
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
    const rows = [['Section', 'Details']];
    const fmt  = n => getOriginalNames(n);

    (latestReport.duplicates   || []).forEach(({ a, b, type }) =>
        rows.push(['Duplicate Edge',    `${fmt(a)} <-> ${fmt(b)} [${type}]`]));
    (latestReport.midpoints    || []).forEach(trio =>
        rows.push(['Triangle',          trio.map(fmt).join(' - ')]));
    (latestReport.cycles       || []).forEach(cycle =>
        rows.push(['Cycle',             cycle.map(fmt).join(' -> ')]));
    (latestReport.selfLoops    || []).forEach(n =>
        rows.push(['Self-Loop',         fmt(n)]));
    (latestReport.overbranches || []).forEach(n =>
        rows.push(['Overbranched Node', fmt(n)]));
    (latestReport.orphans      || []).forEach(line =>
        rows.push(['Malformed Line',    line]));

    downloadFile(
        rows.map(r => `"${r[0]}","${r[1]}"`).join('\n'),
        'graph_analysis_report.csv',
        'text/csv;charset=utf-8;'
    );
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

    // Compare-specific styles extend the shared base
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

function openHelp()  { document.getElementById('helpModal').classList.add('open'); }
function closeHelp() { document.getElementById('helpModal').classList.remove('open'); }

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

    // Close help modal on backdrop click
    document.getElementById('helpModal').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeHelp();
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
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const seen  = new Set();
    const order = [];

    lines.forEach(line => {
        const parts = line.split(/\s+/);
        if (parts.length === 2) {
            [parts[0], parts[1]].forEach(id => {
                if (!seen.has(id)) { seen.add(id); order.push(id); }
            });
        }
    });

    // Preserve existing values so edits survive a rebuild
    const existing = {};
    document.querySelectorAll('#latlngBody tr').forEach(tr => {
        const id  = tr.dataset.nodeId;
        const lat = tr.querySelector('.ll-lat') ? tr.querySelector('.ll-lat').value.trim() : '';
        const lng = tr.querySelector('.ll-lng') ? tr.querySelector('.ll-lng').value.trim() : '';
        if (id) existing[id] = { lat, lng };
    });

    const tbody = document.getElementById('latlngBody');
    tbody.innerHTML = '';

    if (!order.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:12px;color:var(--text3)">Paste edges in the textarea above first, then click Rebuild.</td></tr>';
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

        tr.append(tdNum, tdId, tdLat, tdLng);
        tbody.appendChild(tr);
    });
}

// Read table coords → store on window → trigger analysis pipeline.
function applyLatlngAndRender() {
    const coords = {};
    document.querySelectorAll('#latlngBody tr').forEach(tr => {
        const id  = tr.dataset.nodeId;
        const lat = parseFloat(tr.querySelector('.ll-lat') ? tr.querySelector('.ll-lat').value : '');
        const lng = parseFloat(tr.querySelector('.ll-lng') ? tr.querySelector('.ll-lng').value : '');
        if (id) coords[id] = {
            lat: isFinite(lat) ? lat : null,
            lng: isFinite(lng) ? lng : null
        };
    });
    window._latlngCoords = coords;
    analyzeGraph();
}

// ─── EXCEL PASTE HANDLER FOR LAT-LNG TABLE ────────────────────────────────────
// Excel copies cells as tab-separated columns, newline-separated rows.
// When the user pastes into any lat or lng cell, this handler checks if the
// clipboard contains multiple rows/columns and distributes them across the
// table starting from the pasted cell's row.
//
// Supported paste shapes from Excel:
//   • Single column (lat only):   one value per row → fills lat column only
//   • Two columns (lat + lng):    two tab-separated values → fills lat and lng
//   • Three+ columns (id,lat,lng) → skips first column, fills lat and lng
//     (handles copy from a spreadsheet that includes the node ID column)

(function attachLatlngPasteHandler() {
    document.addEventListener('paste', function(e) {
        const active = document.activeElement;
        if (!active || (!active.classList.contains('ll-lat') && !active.classList.contains('ll-lng'))) return;

        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (!text) return;

        // Only intercept if it looks like multi-cell data (contains tab or newline)
        if (!text.includes('\t') && !text.includes('\n')) return;

        e.preventDefault();

        // Parse into rows × cols
        const rows = text.trim().split(/\r?\n/).map(r => r.split('\t').map(v => v.trim()));

        // Find the starting row in the tbody
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
                // Single column — fill whichever input was targeted
                const target = isLat ? latInput : lngInput;
                if (target) target.value = cols[0];

            } else if (cols.length === 2) {
                // Two columns — lat, lng
                if (latInput) latInput.value = cols[0];
                if (lngInput) lngInput.value = cols[1];

            } else {
                // Three+ columns — assume rightmost two are lat, lng
                // (handles id | lat | lng or any extra leading columns)
                const lat = cols[cols.length - 2];
                const lng = cols[cols.length - 1];
                if (latInput) latInput.value = lat;
                if (lngInput) lngInput.value = lng;
            }
        });

        showToast(`✅ Pasted ${rows.length} row${rows.length > 1 ? 's' : ''}`, 'success');
    });
})();
