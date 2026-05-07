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
}

// ─── STATE ────────────────────────────────────────────────────────────────────

let cy           = null;
let latestReport = {};

const nodeNameMap        = new Map();  // internalName → Set of original raw tokens
const originalNodeLookup = new Map();  // rawToken     → internalName

// ─── INPUT PREPROCESSING ──────────────────────────────────────────────────────

function cleanNodeName(rawName) {
    const mode = document.getElementById('preprocessMode').value;
    let name = rawName;

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
    if (cy) cy.destroy();

    const elements      = [];
    const nodeSet       = new Set();
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

    for (const node of nodeSet) {
        const originalNames = Array.from(nodeNameMap.get(node) || [node]);
        elements.push({
            data:    { id: node, label: originalNames.join('\n'), nameCount: originalNames.length },
            classes: overbranchedSet.has(node) ? 'overbranched' : ''
        });
    }

    cy = cytoscape({
        container: document.getElementById('graph'),
        elements,
        layout: { name: 'cose' },
        style: [
            {
                selector: 'node',
                style: {
                    'background-color': '#0074D9',
                    'label': 'data(label)',
                    'color': '#ffffff',
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'text-wrap': 'wrap',
                    'shape': 'ellipse',
                    'width':  'mapData(nameCount, 1, 5, 40, 100)',
                    'height': 'mapData(nameCount, 1, 5, 40, 100)',
                    'font-size': '10px'
                }
            },
            { selector: 'node.overbranched',     style: { 'background-color': 'red' } },
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
        ]
    });
}

// ─── ANALYSE & REPORT ─────────────────────────────────────────────────────────

function analyzeGraph() {
    const { graph, rawPairs, orphans, selfLoops } = parseInput();

    const duplicates    = findDuplicates(rawPairs);
    const midpoints     = findMidpoints(graph);
    const cycles        = findCycles(graph);
    const overbranches  = findOverbranched(graph);

    latestReport = { duplicates, midpoints, cycles, overbranches, orphans, selfLoops };

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

    drawGraph(rawPairs, duplicates, new Set(overbranches));
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

    const nodes = cy.nodes().map(n => ({
        data: {
            id:  n.data('id'),
            lat: typeof n.data('lat') === 'number' ? n.data('lat') : null,
            lng: typeof n.data('lng') === 'number' ? n.data('lng') : null
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

    downloadFile(JSON.stringify({ nodes, edges }, null, 2), 'zone.json', 'application/json');
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

    cy.nodes().forEach(n => entries.push({
        id:    n.data('id'),
        type:  n.data('type')  || 'valve',
        label: n.data('label') || n.data('id'),
        state: n.data('state') || 'OFF'
    }));

    cy.edges().forEach(e => entries.push({
        id:   e.data('id') || (e.data('source') + '_' + e.data('target')),
        flow: e.data('flow') || ''
    }));

    downloadFile(JSON.stringify(entries, null, 2), 'zone_status.json', 'application/json');
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
        elements.push({ data: { id: node, label: node }, classes: cls });
    }

    for (const edgeKey of new Set([...edges1, ...edges2])) {
        const [source, target] = edgeKey.split('-');
        const cls = (edges1.has(edgeKey) && edges2.has(edgeKey)) ? 'common-edge'
                  :  edges1.has(edgeKey) ? 'graph1-unique-edge' : 'graph2-unique-edge';
        elements.push({ data: { id: edgeKey, source, target }, classes: cls });
    }

    if (cy) cy.destroy();

    cy = cytoscape({
        container: document.getElementById('compareGraph'),
        elements,
        layout: { name: 'cose' },
        style: [
            {
                selector: 'node',
                style: {
                    'background-color': '#0074D9', 'label': 'data(label)',
                    'color': '#ffffff', 'text-valign': 'center', 'text-halign': 'center',
                    'text-wrap': 'wrap', 'shape': 'ellipse',
                    'width': '40px', 'height': '40px', 'font-size': '10px'
                }
            },
            { selector: '.common-node',        style: { 'background-color': 'blue' } },
            { selector: '.graph1-unique-node',  style: { 'background-color': 'red'  } },
            { selector: '.graph2-unique-node',  style: { 'background-color': 'red'  } },
            {
                selector: 'edge',
                style: { 'line-color': '#888', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier' }
            },
            { selector: '.common-edge',        style: { 'line-color': 'blue', 'width': 3 } },
            { selector: '.graph1-unique-edge', style: { 'line-color': 'red',  'width': 3, 'line-style': 'dashed' } },
            { selector: '.graph2-unique-edge', style: { 'line-color': 'red',  'width': 3, 'line-style': 'dashed' } }
        ]
    });
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
