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

// ── Default (fallback) node ────────────────────────────────────────────────
{
    selector: 'node',
    style: {
        'label': 'data(label)',

        'shape': 'diamond',
        'width': 44,
        'height': 44,

        'background-color': COLOR.valveOff,
        'border-width': 2,
        'border-color': COLOR.valveOffBorder,

        'font-size': '11px',
        'font-weight': 'bold',
        'text-wrap': 'wrap',
        'text-max-width': '120px',
        'text-valign': 'bottom',
        'text-margin-y': 8,
        'color': '#2c3e50',
        'min-zoomed-font-size': 8
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

        'label': 'data(label)',
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

// Fault: base style — blink class toggles highlight
{
    selector: 'edge[flow="fault"]',
    style: {
        'line-color': '#e74c3c',
        'target-arrow-color': '#e74c3c',
        'width': 4,
        'line-style': 'dashed'
    }
},

// Fault blink-ON state (toggled by JS every 500 ms)
{
    selector: 'edge[flow="fault"].faultBlink',
    style: {
        'line-color': '#ff8c00',
        'target-arrow-color': '#ff8c00',
        'width': 6,
        'line-style': 'solid'
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

        if (item.type !== undefined)
            el.data('type', item.type.toString().toLowerCase());

        if (item.flow !== undefined)
            el.data('flow', item.flow.toString().toLowerCase());

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
// Walks the directed graph from every running pump (type=pump, state=ON).
// An edge is "reachable" if there is a continuous upstream path that is NOT
// blocked by a closed valve (type=valve, state=OFF).
//
// Rules:
//   reachable  + flow="fault"  → keep "fault"  (explicit faults always win)
//   reachable  + anything else → set  "active"
//   unreachable                → clear flow    (empty string = idle pipe colour)
//
// If the diagram has no pump nodes at all, the function is a no-op so that
// simple layouts without pumps still work as before.

function propagateFlow(cy) {

    const hasPumps = cy.nodes('[type="pump"]').length > 0;
    if (!hasPumps) return;

    // ── First pass: determine which zones are reachable ──────────────────────
    const reachableEdges = new Set();
    const visitedNodes   = new Set();

    const queue = cy.nodes('[type="pump"][state="ON"]').toArray();

    while (queue.length > 0) {

        const node = queue.shift();
        const nid  = node.id();

        if (visitedNodes.has(nid)) continue;
        visitedNodes.add(nid);

        // Closed valve: water reaches the valve body but does NOT pass through.
        // Mark incoming edge reachable (water is there), stop outgoing traversal.
        if (node.data('type') === 'valve' && node.data('state') === 'OFF') continue;

        node.outgoers('edge').forEach(edge => {
            reachableEdges.add(edge.id());
            queue.push(edge.target());
        });
    }

    // ── Update zone states based on reachable pipes ─────────────────────────
    cy.batch(() => {
        cy.nodes('[type="zone"]').forEach(zone => {
            const currentState = zone.data('state');
            
            // If zone is already manually OFF, keep it OFF
            if (currentState === 'OFF') return;
            
            // Otherwise, set based on reachability
            const incoming = zone.incomers('edge');
            let reachable = false;

            incoming.forEach(edge => {
                if (reachableEdges.has(edge.id()))
                    reachable = true;
            });

            zone.data('state', reachable ? 'ON' : 'OFF');
        });
    });

    // ── Second pass: update pipe flow states ───────────────────────────────
    // Pipes carry flow only if they are reachable from a pump (faults excluded)
    cy.batch(() => {
        cy.edges().forEach(edge => {
            const current = edge.data('flow');

            if (reachableEdges.has(edge.id())) {
                if (current !== 'fault') edge.data('flow', 'active');
            } else {
                if (current !== 'fault') edge.data('flow', '');
            }
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

    // ── 4. Fault blink (class toggle every 500 ms) ────────────────────────────
    const faultTimer = setInterval(() => {
        if (!running) return;
        cy.edges('[flow="fault"]').toggleClass('faultBlink');
    }, 500);

    // ── Expose a clean teardown for zone switches ─────────────────────────────
    return function stop() {
        running = false;
        clearInterval(faultTimer);
    };
}
