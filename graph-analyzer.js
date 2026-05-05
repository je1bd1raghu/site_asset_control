let cy = null;
let latestReport = {};
const nodeNameMap = new Map();
const originalNodeLookup = new Map();

function cleanNodeName(rawName) {
  const mode = document.getElementById("preprocessMode").value;
  let name = rawName;

  if (mode === "ignore_prefix_and_symbols") {
    name = name.replace(/[^A-Za-z0-9]/g, '');
    name = name.replace(/^[A-Za-z]+/, '');
    name = name.toUpperCase();
  } else if (mode === "ignore_symbols_only") {
    name = name.replace(/[^A-Za-z0-9]/g, '');
    name = name.toUpperCase();
  } else if (mode === "none") {
    name = name.trim();
  }

  return name;
}

function getOriginalNames(internalName) {
  return Array.from(nodeNameMap.get(internalName) || [internalName]).join(' / ');
}

function preprocessLine(line) {
  const rawTokens = line.trim().split(/\s+/);
  const tokens = [];

  for (let rawToken of rawTokens) {
    const internalName = cleanNodeName(rawToken);
    if (internalName) {
      tokens.push(internalName);

      if (!nodeNameMap.has(internalName)) nodeNameMap.set(internalName, new Set());
      nodeNameMap.get(internalName).add(rawToken);

      originalNodeLookup.set(rawToken, internalName);
    }
  }

  return tokens;
}

function parseInput() {
  nodeNameMap.clear();
  originalNodeLookup.clear();

  const lines = document.getElementById("inputData").value.trim().split(/\n+/);
  const graph = {};
  const rawPairs = [];
  const orphans = [];
  const selfLoops = [];

  for (let line of lines) {
    const tokens = preprocessLine(line);
    if (tokens.length !== 2) {
      orphans.push(line);
      continue;
    }

    const [a, b] = tokens;

    if (a === b) {
      selfLoops.push(a);
      continue;
    }

    rawPairs.push([a, b]);
    graph[a] = graph[a] || new Set();
    graph[b] = graph[b] || new Set();
    graph[a].add(b);
    graph[b].add(a);
  }

  return { graph, rawPairs, orphans, selfLoops };
}

function parseInputForComparison(inputElementId) {
  const localNodeNameMap = new Map();
  const localOriginalNodeLookup = new Map();

  function localCleanNodeName(rawName) {
    const mode = document.getElementById("preprocessMode").value;
    let name = rawName;

    if (mode === "ignore_prefix_and_symbols") {
      name = name.replace(/[^A-Za-z0-9]/g, '');
      name = name.replace(/^[A-Za-z]+/, '');
      name = name.toUpperCase();
    } else if (mode === "ignore_symbols_only") {
      name = name.replace(/[^A-Za-z0-9]/g, '');
      name = name.toUpperCase();
    } else if (mode === "none") {
      name = name.trim();
    }
    return name;
  }

  function localPreprocessLine(line) {
    const rawTokens = line.trim().split(/\s+/);
    const tokens = [];

    for (let rawToken of rawTokens) {
      const internalName = localCleanNodeName(rawToken);
      if (internalName) {
        tokens.push(internalName);

        if (!localNodeNameMap.has(internalName)) localNodeNameMap.set(internalName, new Set());
        localNodeNameMap.get(internalName).add(rawToken);

        localOriginalNodeLookup.set(rawToken, internalName);
      }
    }
    return tokens;
  }

  const lines = document.getElementById(inputElementId).value.trim().split(/\n+/);
  const graph = {};
  const rawPairs = [];

  for (let line of lines) {
    const tokens = localPreprocessLine(line);
    if (tokens.length !== 2) {
      continue;
    }

    const [a, b] = tokens;

    if (a === b) {
      continue;
    }

    rawPairs.push([a, b]);
    graph[a] = graph[a] || new Set();
    graph[b] = graph[b] || new Set();
    graph[a].add(b);
    graph[b].add(a);
  }

  return { graph, rawPairs, localNodeNameMap, localOriginalNodeLookup };
}

function findDuplicates(pairs) {
  const seen = new Map(); // direct edges
  const report = [];

  for (const [a, b] of pairs) {
    const directKey = `${a}|${b}`;
    const reverseKey = `${b}|${a}`;

    if (!seen.has(directKey)) seen.set(directKey, 0);
    seen.set(directKey, seen.get(directKey) + 1);

    if (seen.get(directKey) > 1) {
      report.push({ type: "Repeated", a, b });
    }

    if (seen.has(reverseKey) && directKey !== reverseKey) {
      report.push({ type: "Bidirectional", a, b });
    }
  }

  return report;
}

function findMidpoints(graph) {
  const result = new Map();

  for (let node in graph) {
    const neighbors = Array.from(graph[node]);
    for (let i = 0; i < neighbors.length; i++) {
      for (let j = i + 1; j < neighbors.length; j++) {
        const ni = neighbors[i], nj = neighbors[j];
        if (graph[ni] && graph[ni].has(nj)) {
          const triangle = [node, ni, nj].sort();
          const key = triangle.join('|');
          result.set(key, triangle);
        }
      }
    }
  }

  return Array.from(result.values()); // each is [node1, node2, node3]
}

function findCycles(graph) {
  const cycles = new Set();
  const visited = new Set();

  function dfs(node, path, parent) {
    visited.add(node);
    path.push(node);
    for (const neighbor of graph[node] || []) {
      if (neighbor === parent) continue;
      if (path.includes(neighbor)) {
        const cycle = path.slice(path.indexOf(neighbor)).concat(neighbor);
        const key = [...new Set(cycle)].sort().join('|');
        cycles.add(key);
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
    .filter(([node, edges]) => edges.size >= 4)
    .map(([node]) => node);
}

function drawGraph(pairs, duplicates, overbranchedSet) {
  if (cy) cy.destroy();

  const elements = [];
  const nodeSet = new Set();
  const duplicateEdges = new Set();

  duplicates.forEach(({ a, b }) => {
    duplicateEdges.add(`${a}-${b}`);
    duplicateEdges.add(`${b}-${a}`);
  });

  for (const [a, b] of pairs) {
    nodeSet.add(a);
    nodeSet.add(b);
    let classes = [];

    if (duplicateEdges.has(`${a}-${b}`)) classes.push('duplicate');

    elements.push({ data: { id: `${a}-${b}`, source: a, target: b }, classes: classes.join(' ') });
  }

  for (const node of nodeSet) {
    const originalNames = Array.from(nodeNameMap.get(node) || [node]);
    const label = originalNames.join('\n');
    const nameCount = originalNames.length;
    const classes = overbranchedSet.has(node) ? 'overbranched' : '';

    elements.push({
      data: { id: node, label, nameCount },
      classes
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
          'width': 'mapData(nameCount, 1, 5, 40, 100)',
          'height': 'mapData(nameCount, 1, 5, 40, 100)',
          'font-size': '10px'
        }
      },
      {
        selector: 'node.overbranched',
        style: { 'background-color': 'red' }
      },
      {
        selector: 'node.search-highlight',
        style: {
          'border-color': '#FFD700',
          'border-width': '8px',
          'border-style': 'double',
          'background-color': '#FFA500',
          'background-opacity': 0.7
        }
      },
      {
        selector: 'edge',
        style: {
          'line-color': '#888',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier'
        }
      },
      {
        selector: 'edge.duplicate',
        style: {
          'line-color': 'orange',
          'width': 3,
          'line-style': 'dashed'
        }
      }
    ]
  });
}

function analyzeGraph() {
  const { graph, rawPairs, orphans, selfLoops } = parseInput();

  const duplicates = findDuplicates(rawPairs);
  const midpoints = findMidpoints(graph);
  const cycles = findCycles(graph);
  const overbranches = findOverbranched(graph);

  latestReport = { duplicates, midpoints, cycles, overbranches, orphans, selfLoops };

  const repeatedDuplicates = duplicates.filter(d => d.type === "Repeated");
  const bidirectionalDuplicates = duplicates.filter(d => d.type === "Bidirectional");

  let duplicatesHtml = "";

  if (repeatedDuplicates.length > 0) {
    duplicatesHtml += "<h4>Repeated Edges:</h4>";
    duplicatesHtml += repeatedDuplicates.map((d, i) =>
      `${i + 1}. <a href="#" onclick="highlightNodes(['${d.a}','${d.b}']); return false;">${getOriginalNames(d.a)} <-> ${getOriginalNames(d.b)}</a>`
    ).join(", ");
  }

  if (bidirectionalDuplicates.length > 0) {
    if (repeatedDuplicates.length > 0) {
      duplicatesHtml += "<br><br>"; // Add some spacing between sections
    }
    duplicatesHtml += "<h4>Bidirectional Edges:</h4>";
    duplicatesHtml += bidirectionalDuplicates.map((d, i) =>
      `${i + 1}. <a href="#" onclick="highlightNodes(['${d.a}','${d.b}']); return false;">${getOriginalNames(d.a)} <-> ${getOriginalNames(d.b)}</a>`
    ).join(", ");
  }

  document.getElementById("duplicates").innerHTML = duplicatesHtml || "None";

  document.getElementById("midpoints").innerHTML = midpoints.length
    ? midpoints.map((trio, i) => {
        const jsArray = JSON.stringify(trio);
        const label = trio.map(n => getOriginalNames(n)).join(' - ');
        return `${i + 1}. <a href="#" onclick='highlightNodes(${jsArray}); return false;'>${label}</a>`;
      }).join(", ")
    : "None";

  document.getElementById("loops").innerHTML = selfLoops.length
    ? selfLoops.map((n, i) =>
        `${i + 1}. <a href="#" onclick="highlightNode('${n}'); return false;">${getOriginalNames(n)} (self-loop)</a>`
      ).join(", ")
    : "None";

  document.getElementById("branches").innerHTML = overbranches.length
    ? overbranches.map((n, i) =>
        `${i + 1}. <a href="#" onclick="highlightNode('${n}'); return false;">${getOriginalNames(n)}</a>`
      ).join(", ")
    : "None";

  document.getElementById("orphans").innerHTML = orphans.length
    ? orphans.map((line, i) => `${i + 1}. ${line}`).join(", ")
    : "None";

  drawGraph(rawPairs, duplicates, new Set(overbranches));
}

function downloadCSV() {
  const rows = [];
  rows.push(['Section', 'Details']);

  const formatNode = n => getOriginalNames(n);

  if (latestReport.duplicates) {
    latestReport.duplicates.forEach(({ a, b, type }) => {
      rows.push(['Duplicate Edge', `${formatNode(a)} <-> ${formatNode(b)} [${type}]`]);
    });
  }

  if (latestReport.midpoints) {
    latestReport.midpoints.forEach(trio => {
      const display = trio.map(n => formatNode(n)).join(' - ');
      rows.push(['Midpoint', display]);
    });
  }

  if (latestReport.cycles) {
    latestReport.cycles.forEach(cycle => {
      const display = cycle.map(n => formatNode(n)).join(' -> ');
      rows.push(['Cycle', display]);
    });
  }

  if (latestReport.selfLoops) {
    latestReport.selfLoops.forEach(n => {
      rows.push(['Self-Loop', formatNode(n)]);
    });
  }

  if (latestReport.overbranches) {
    latestReport.overbranches.forEach(n => {
      rows.push(['Overbranched Node', formatNode(n)]);
    });
  }

  if (latestReport.orphans) {
    latestReport.orphans.forEach(line => {
      rows.push(['Orphan Line', line]);
    });
  }

  const csvContent = rows.map(r => `"${r[0]}","${r[1]}"`).join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', 'graph_analysis_report.csv');
  link.click();
}

function searchNode() {
  const query = document.getElementById("searchBox").value.trim().toUpperCase();
  if (!cy) return;

  cy.nodes().removeClass('search-highlight');

  if (query) {
    const matchedNodes = cy.nodes().filter(node => {
      const label = node.data('label').toUpperCase();
      return label.includes(query);
    });

    matchedNodes.addClass('search-highlight');
    if (matchedNodes.length > 0) cy.fit(matchedNodes, 50);
  }
}

function highlightNode(name) {
  if (!cy) return;
  const internal = cleanNodeName(name);
  cy.nodes().removeClass('search-highlight');
  const node = cy.getElementById(internal);
  if (node) {
    node.addClass('search-highlight');
    cy.fit(node, 50);
  }
}

function highlightNodes(nodeList) {
  if (!cy) return;

  cy.nodes().removeClass('search-highlight');

  const nodesToHighlight = cy.collection();
  for (const name of nodeList) {
    const internal = cleanNodeName(name);
    const node = cy.getElementById(internal);
    if (node && node.length) {
      node.addClass('search-highlight');
      nodesToHighlight.merge(node);
    }
  }
  if (nodesToHighlight.length > 0) cy.fit(nodesToHighlight, 50);
}

function compareAndRenderGraphs() {
  const graph1Data = parseInputForComparison("inputData1");
  const graph2Data = parseInputForComparison("inputData2");

  const elements = [];
  const nodes1 = new Set(Object.keys(graph1Data.graph));
  const nodes2 = new Set(Object.keys(graph2Data.graph));

  const edges1 = new Set(graph1Data.rawPairs.map(p => p.sort().join('-')));
  const edges2 = new Set(graph2Data.rawPairs.map(p => p.sort().join('-')));

  // Add nodes
  const allNodes = new Set([...nodes1, ...nodes2]);
  for (const node of allNodes) {
    let classes = [];
    if (nodes1.has(node) && nodes2.has(node)) {
      classes.push('common-node');
    } else if (nodes1.has(node)) {
      classes.push('graph1-unique-node');
    } else {
      classes.push('graph2-unique-node');
    }
    elements.push({
      data: { id: node, label: node },
      classes: classes.join(' ')
    });
  }

  // Add edges
  const allEdges = new Set([...edges1, ...edges2]);
  for (const edgeKey of allEdges) {
    const [source, target] = edgeKey.split('-');
    let classes = [];
    if (edges1.has(edgeKey) && edges2.has(edgeKey)) {
      classes.push('common-edge');
    } else if (edges1.has(edgeKey)) {
      classes.push('graph1-unique-edge');
    }
    else {
      classes.push('graph2-unique-edge');
    }
    elements.push({
      data: { id: edgeKey, source: source, target: target },
      classes: classes.join(' ')
    });
  }

  if (cy) cy.destroy();

  cy = cytoscape({
    container: document.getElementById('compareGraph'),
    elements: elements,
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
          'width': '40px',
          'height': '40px',
          'font-size': '10px'
        }
      },
      {
        selector: '.common-node',
        style: {
          'background-color': 'blue'
        }
      },
      {
        selector: '.graph1-unique-node',
        style: {
          'background-color': 'red'
        }
      },
      {
        selector: '.graph2-unique-node',
        style: {
          'background-color': 'red'
        }
      },
      {
        selector: 'edge',
        style: {
          'line-color': '#888',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier'
        }
      },
      {
        selector: '.common-edge',
        style: {
          'line-color': 'blue',
          'width': 3
        }
      },
      {
        selector: '.graph1-unique-edge',
        style: {
          'line-color': 'red',
          'width': 3,
          'line-style': 'dashed'
        }
      },
      {
        selector: '.graph2-unique-edge',
        style: {
          'line-color': 'red',
          'width': 3,
          'line-style': 'dashed'
        }
      }
    ]
  });
}
