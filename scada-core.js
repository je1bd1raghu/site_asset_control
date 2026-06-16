// ─── COLOUR PALETTE ───────────────────────────────────────────────────────────
// All node rendering uses Cytoscape native shapes — no SVG background images.
// Native shapes are drawn by the canvas renderer so they stay crisp at any zoom.
//
//  Valve  → diamond         (rotated square — standard P&ID valve symbol)
//  Pump   → ellipse         (circle — standard pump symbol)
//  Zone   → round-rectangle
//
//  Valve ON  → green fill,   Valve OFF → red fill
//  Pump  ON  → purple fill,  Pump  OFF → grey fill
//  Zone  ON  → blue fill,    Zone  OFF → grey fill

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
    zoneOffBorder:  '#95a5a6'
};

// ─── CYTOSCAPE STYLE ──────────────────────────────────────────────────────────
const CY_STYLE = [

// ── Default (fallback) — untyped nodes are passive junction dots ────────────
// No label mapping here — avoids Cytoscape's "no mapping for property label"
// warning on every animation frame for nodes without the field set.
{
    selector: 'node',
    style: {
        'label': '',
        'shape': 'ellipse',
        'width': 4,
        'height': 4,
        'background-color': '#b0bec5',
        'border-width': 0,
        'font-size': '0px',
        'font-weight': 'bold',
        'color': '#555e68',
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'min-zoomed-font-size': 0,
        'overlay-padding': 6,
        'events': 'yes'
    }
},

// ── Untyped node with a label — show it when explicitly set ───────────────
{
    selector: 'node[type][label]',
    style: {
        'label': 'data(label)'
    }
},

// ── Typed nodes share label + text style ──────────────────────────────────
// Scoped to nodes that actually have a label field to avoid mapping warnings.
{
    selector: 'node[type]',
    style: {
        'font-size': '11px',
        'font-weight': 'bold',
        'text-wrap': 'wrap',
        'text-max-width': '120px',
        'text-valign': 'bottom',
        'text-margin-y': 8,
        'color': '#2c3e50',
        'min-zoomed-font-size': 6,
        'events': 'yes'
    }
},

// ── Valves — diamond shape ─────────────────────────────────────────────────
{
    selector: 'node[type="valve"]',
    style: {
        'shape': 'diamond',
        'width': 44,
        'height': 44
    }
},
{
    selector: 'node[type="valve"][state="ON"]',
    style: {
        'background-color': COLOR.on,
        'border-color':     COLOR.onBorder,
        'border-width': 3
    }
},
{
    selector: 'node[type="valve"][state="OFF"]',
    style: {
        'background-color': COLOR.valveOff,
        'border-color':     COLOR.valveOffBorder,
        'border-width': 2
    }
},

// ── Pumps — circle (ellipse) ───────────────────────────────────────────────
{
    selector: 'node[type="pump"]',
    style: {
        'shape': 'ellipse',
        'width': 48,
        'height': 48
    }
},
{
    selector: 'node[type="pump"][state="ON"]',
    style: {
        'background-color': COLOR.pump,
        'border-color':     COLOR.on,
        'border-width': 3
    }
},
{
    selector: 'node[type="pump"][state="OFF"]',
    style: {
        'background-color': COLOR.pumpOff,
        'border-color':     COLOR.pumpOffBorder,
        'border-width': 2
    }
},

// ── Zones — rounded rectangle ─────────────────────────────────────────────
{
    selector: 'node[type="zone"]',
    style: {
        'shape': 'round-rectangle',
        'width': 56,
        'height': 44,
        'background-color': COLOR.zoneOff,
        'border-color': COLOR.zoneOffBorder,
        'border-width': 2
    }
},
{
    selector: 'node[type="zone"][state="ON"]',
    style: {
        'background-color': COLOR.zone,
        'border-color':     COLOR.zoneBorder,
        'border-width': 3
    }
},
{
    selector: 'node[type="zone"][state="OFF"]',
    style: {
        'background-color': COLOR.zoneOff,
        'border-color':     COLOR.zoneOffBorder,
        'border-width': 2
    }
},

// ── Pipes / Edges ──────────────────────────────────────────────────────────
{
    selector: 'edge',
    style: {
        'width': 4,
        'line-color': '#3498db',

        'target-arrow-shape': 'triangle',
        'target-arrow-color': '#3498db',

        'curve-style': 'bezier',

        'label': '',
        'font-size': '9px',
        'edge-text-rotation': 'autorotate',

        'text-background-opacity': 1,
        'text-background-color': '#f0f4f8',
        'text-background-padding': '3px',

        'text-border-opacity': 1,
        'text-border-color': '#d0d7de',
        'text-border-width': 1
    }
},

// Only map label data field on edges that actually have a label set —
// avoids Cytoscape's "no mapping for property label" warning on every
// animation frame for edges where the field is absent.
{
    selector: 'edge[label]',
    style: { 'label': 'data(label)' }
},

// Inactive pipe
{
    selector: 'edge[flow=""]',
    style: {
        'line-color': '#a9b0b8',
        'target-arrow-color': '#a9b0b8',
        'line-style': 'solid',
        'width': 3
    }
},

// Active flow: dashed green line (offset animated in JS)
{
    selector: 'edge[flow="active"]',
    style: {
        'line-color': '#2ecc71',
        'target-arrow-color': '#2ecc71',
        'width': 5,
        'line-style': 'dashed',
        'line-dash-pattern': [10, 10],
        'line-dash-offset': 0
    }
},

// Leak/Burst: base style — blink class toggles highlight
{
    selector: 'edge[flow="leakburst"]',
    style: {
        'line-color': '#e74c3c',
        'target-arrow-color': '#e74c3c',
        'width': 4,
        'line-style': 'dashed'
    }
},

// Leak/Burst blink-ON state (toggled by JS every 500 ms)
{
    selector: 'edge[flow="leakburst"].leakburstBlink',
    style: {
        'line-color': '#ff8c00',
        'target-arrow-color': '#ff8c00',
        'width': 6,
        'line-style': 'solid'
    }
},

// ── Nodes with a comment — yellow highlight ring ───────────────────────────
{
    selector: 'node[comment]',
    style: {
        'border-width': 3,
        'border-color': '#f1c40f',
        'border-style': 'solid'
    }
},

// ── Search-highlighted edge ─────────────────────────────────────────────────
// Keep the edge's own colour; add a yellow halo/border via underlay instead.
{
    selector: 'edge.highlight',
    style: {
        'underlay-color':   '#ffeb3b',
        'underlay-padding':  5,
        'underlay-opacity':  0.9,
        'z-index': 999
    }
}
];

// ─── APPLY STATUS UPDATE FROM DATA ───────────────────────────────────────────
function applyStatus(cy, data) {

    let updated = 0;

    data.forEach(item => {

        const el = cy.getElementById(item.id);
        if (el.length === 0) return;

        if (item.state !== undefined)
            el.data('state', item.state.toString().toUpperCase());

        if (item.label !== undefined)
            el.data('label', item.label.toString());

        // Only set type when explicitly present in the status JSON.
        // Nodes without a type entry remain untyped junction dots — they
        // render as small grey circles and are skipped in tap/click handlers.
        if (item.type !== undefined)
            el.data('type', item.type.toString().toLowerCase());

        if (item.flow !== undefined)
            el.data('flow', item.flow.toString().toLowerCase());

        // comment — free-text annotation shown in the info panel on click.
        // An empty string clears any previously set comment so the yellow
        // highlight ring also clears when the status update removes it.
        if (item.comment !== undefined) {
            const c = item.comment.toString().trim();
            if (c) {
                el.data('comment', c);
            } else {
                el.removeData('comment');
            }
        }

        updated++;
    });

    // Auto-derive which pipes carry flow based on valve/pump states.
    // Runs after every status sync — the backend only needs to set valve/pump
    // states; edge flow states are computed automatically from the graph.
    propagateFlow(cy);

    cy.style().update();

    return updated;
}

// ─── FLOW PROPAGATION ────────────────────────────────────────────────────────
// Computes edge flow states by walking the directed graph from every running
// pump (type=pump, state=ON).
//
// IMPORTANT — single responsibility:
//   This function sets edge `flow` values ONLY.
//   Node `state` (valve ON/OFF, zone ON/OFF) is authoritative data owned by
//   the gist status file and written by applyStatus(). propagateFlow() never
//   reads or writes node state — doing so would cause the gist and the
//   propagation logic to overwrite each other on every sync.
//
// Edge flow rules:
//   reachable  + flow="leakburst"  → keep "leakburst"   (explicit leaks/bursts always win)
//   reachable  + anything else → set  "active"
//   unreachable                → set  ""         (idle pipe colour)
//
// Traversal rules:
//   - BFS starts from all pump nodes with state=ON.
//   - A closed valve (state=OFF) stops traversal: water reaches it but does
//     not pass through. Its incoming edges are still marked active.
//   - Zone nodes (type=zone) and open valves are transparent — traversal
//     continues through them regardless of their state.
//
// If the diagram has no pump nodes the function is a no-op so layouts without
// pumps (e.g. gravity-fed or source-zone diagrams) still render correctly.

function propagateFlow(cy) {

    const hasPumps = cy.nodes('[type="pump"]').length > 0;
    if (!hasPumps) return;

    // BFS — collect every edge reachable from a running pump
    const reachableEdges = new Set();
    const visitedNodes   = new Set();
    const queue          = cy.nodes('[type="pump"][state="ON"]').toArray();

    while (queue.length > 0) {

        const node = queue.shift();
        const nid  = node.id();
        if (visitedNodes.has(nid)) continue;
        visitedNodes.add(nid);

        // Closed valve: mark incoming edges active, do not traverse outgoing.
        if (node.data('type') === 'valve' && node.data('state') === 'OFF') continue;

        node.outgoers('edge').forEach(edge => {
            reachableEdges.add(edge.id());
            const target = edge.target();
            // Untyped junction dots are transparent — water flows through them
            // but they are not hydraulic assets, so always traverse.
            // Typed nodes are handled by the closed-valve guard above.
            queue.push(target);
        });
    }

    // Update edge flow — node states are never touched here
    cy.batch(() => {
        cy.edges().forEach(edge => {
            if (edge.data('flow') === 'leakburst') return;   // leaks/bursts always win
            edge.data('flow', reachableEdges.has(edge.id()) ? 'active' : '');
        });
    });
}

// ─── ANIMATIONS ──────────────────────────────────────────────────────────────
// Call startAnimations(cy) once after Cytoscape is initialised.
// Returns a stop() function you can call when tearing down the instance.

function startAnimations(cy) {

    let running = true;

    // ── 1. Flow: animated dashed-line offset on active pipes ─────────────────
    let flowOffset = 0;
    function animateFlow() {
        if (!running) return;
        flowOffset = (flowOffset + 1.2) % 20;
        cy.style()
            .selector('edge[flow="active"]')
            .style('line-dash-offset', -flowOffset)   // negative = forward motion
            .update();
        requestAnimationFrame(animateFlow);
    }
    animateFlow();

    // ── 2. Pump ON: border-width pulse (replaces old SVG rotation) ────────────
    // Pumps are native circles so there's nothing to spin.
    // A green border pulse communicates "running" clearly.
    let pumpPhase = 0;
    function animatePumps() {
        if (!running) return;
        pumpPhase = (pumpPhase + 0.07) % (Math.PI * 2);
        const bw = 3 + Math.sin(pumpPhase) * 2.5;    // oscillates ~0.5 → 5.5 px
        cy.batch(() => {
            cy.nodes('[type="pump"][state="ON"]').forEach(n => {
                n.style('border-width', bw);
            });
        });
        requestAnimationFrame(animatePumps);
    }
    animatePumps();

    // ── 3. Valve ON: border-width pulse ───────────────────────────────────────
    let valvePhase = 0;
    function animateValves() {
        if (!running) return;
        valvePhase = (valvePhase + 0.05) % (Math.PI * 2);
        const bw = 2.5 + Math.sin(valvePhase) * 1.5;  // oscillates 1 → 4 px
        cy.batch(() => {
            cy.nodes('[type="valve"][state="ON"]').forEach(n => {
                n.style('border-width', bw);
            });
        });
        requestAnimationFrame(animateValves);
    }
    animateValves();

    // ── 4. Leak/Burst blink (class toggle every 500 ms) ────────────────────────────
    const leakBurstTimer = setInterval(() => {
        if (!running) return;
        cy.edges('[flow="leakburst"]').toggleClass('leakburstBlink');
    }, 500);

    // ── Expose a clean teardown for zone switches ─────────────────────────────
    return function stop() {
        running = false;
        clearInterval(leakBurstTimer);
    };
}
