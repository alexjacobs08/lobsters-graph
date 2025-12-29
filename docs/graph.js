/**
 * Lobste.rs User Graph Visualization
 * Features: Radial tree layout, LOD, semantic zoom, edge curves
 */

let graph = null;
let sigma = null;
let graphData = null;
let enrichedData = {};
let inviteCounts = {};
let childrenMap = {};  // Pre-computed parent -> children for fast descendant lookup
let currentHighlight = 'none';
let currentZoom = 1;
let allNodeData = [];  // Keep all node data for LOD
let maxKarma = 1;  // Will be set from data

// Thresholds for LOD - higher ratio = more zoomed out
// When zoomed out (high ratio), hide low-karma nodes
const LOD_THRESHOLDS = [
    { maxZoom: 0.15, minKarma: 0, minInvites: 0 },      // Zoomed in - show all
    { maxZoom: 0.3, minKarma: 10, minInvites: 2 },
    { maxZoom: 0.5, minKarma: 50, minInvites: 5 },
    { maxZoom: 0.8, minKarma: 200, minInvites: 10 },
    { maxZoom: 999, minKarma: 500, minInvites: 20 },    // Very zoomed out
];

const COLORS = {
    superInviter: '#ff5555',      // Brighter red
    superKarma: '#ffdd44',        // Brighter gold
    highKarma: '#55ddd5',         // Brighter teal
    mediumKarma: '#8899aa',       // Lighter gray-blue
    lowKarma: '#556677',          // Lighter base
    muted: 'rgba(100, 110, 130, 0.5)',
    edge: 'rgba(100, 180, 200, 0.25)',  // More visible edges
    edgeMuted: 'rgba(80, 120, 140, 0.12)',
    edgeHighlight: 'rgba(85, 220, 210, 0.7)',
};

function getNodeColor(karma, inviteCount) {
    if (inviteCount >= 50) return COLORS.superInviter;
    if (karma >= 5000) return COLORS.superKarma;
    if (karma >= 1000) return COLORS.highKarma;
    if (karma >= 100) return COLORS.mediumKarma;
    return COLORS.lowKarma;
}

function getNodeSize(karma) {
    // Continuous log scale - smaller sizes to reduce overlap
    if (karma <= 0) return 1.5;
    const logKarma = Math.log(karma + 1);
    const logMax = Math.log(maxKarma + 1);
    const normalized = logKarma / logMax;  // 0 to 1
    return 1.5 + normalized * 5;  // 1.5 to 6.5
}

// Tangential collision avoidance - pushes nodes apart along the circle, not outward
// This prevents nodes from drifting too far from their parent
function applyCollisionAvoidance(graph, iterations = 8) {
    const minDistance = 10;  // Minimum distance between node centers
    const strength = 0.3;    // How strongly to push apart (0-1)
    const gridSize = 35;     // Spatial grid cell size

    for (let iter = 0; iter < iterations; iter++) {
        // Build spatial grid
        const grid = {};
        graph.forEachNode((node, attrs) => {
            const gx = Math.floor(attrs.x / gridSize);
            const gy = Math.floor(attrs.y / gridSize);
            const key = `${gx},${gy}`;
            if (!grid[key]) grid[key] = [];
            grid[key].push({ node, x: attrs.x, y: attrs.y, size: attrs.size || 3 });
        });

        const movements = {};

        // Only process cells with potential collisions
        for (const key in grid) {
            const [gx, gy] = key.split(',').map(Number);
            const nodes = grid[key];

            // Get all nodes in this cell and neighbors
            const relevantNeighbors = [];
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const neighborKey = `${gx + dx},${gy + dy}`;
                    if (grid[neighborKey]) relevantNeighbors.push(...grid[neighborKey]);
                }
            }

            if (relevantNeighbors.length < 2) continue;

            for (let i = 0; i < nodes.length; i++) {
                const n1 = nodes[i];
                for (let j = 0; j < relevantNeighbors.length; j++) {
                    const n2 = relevantNeighbors[j];
                    if (n1.node >= n2.node) continue;

                    const dx = n2.x - n1.x;
                    const dy = n2.y - n1.y;
                    const distSq = dx * dx + dy * dy;
                    const minDist = minDistance + (n1.size + n2.size);

                    if (distSq < minDist * minDist && distSq > 0.01) {
                        const dist = Math.sqrt(distSq);
                        const overlap = minDist - dist;

                        // Push TANGENTIALLY (along the circle) not radially (outward)
                        // This prevents nodes from drifting far from their parent
                        const r1 = Math.sqrt(n1.x * n1.x + n1.y * n1.y) || 1;
                        const r2 = Math.sqrt(n2.x * n2.x + n2.y * n2.y) || 1;

                        // Tangent direction is perpendicular to radial
                        // For n1: tangent = (-y/r, x/r)
                        const tan1X = -n1.y / r1;
                        const tan1Y = n1.x / r1;
                        const tan2X = -n2.y / r2;
                        const tan2Y = n2.x / r2;

                        // Determine push direction based on relative position
                        const cross = n1.x * n2.y - n1.y * n2.x;  // Cross product sign
                        const pushAmount = overlap * strength;

                        if (!movements[n1.node]) movements[n1.node] = { x: 0, y: 0 };
                        if (!movements[n2.node]) movements[n2.node] = { x: 0, y: 0 };

                        if (cross > 0) {
                            // n2 is counterclockwise from n1, push them apart
                            movements[n1.node].x -= tan1X * pushAmount;
                            movements[n1.node].y -= tan1Y * pushAmount;
                            movements[n2.node].x += tan2X * pushAmount;
                            movements[n2.node].y += tan2Y * pushAmount;
                        } else {
                            // n2 is clockwise from n1
                            movements[n1.node].x += tan1X * pushAmount;
                            movements[n1.node].y += tan1Y * pushAmount;
                            movements[n2.node].x -= tan2X * pushAmount;
                            movements[n2.node].y -= tan2Y * pushAmount;
                        }
                    }
                }
            }
        }

        // Apply movements with damping
        let moved = 0;
        for (const node in movements) {
            const m = movements[node];
            if (Math.abs(m.x) > 0.1 || Math.abs(m.y) > 0.1) {
                const attrs = graph.getNodeAttributes(node);
                graph.setNodeAttribute(node, 'x', attrs.x + m.x);
                graph.setNodeAttribute(node, 'y', attrs.y + m.y);
                moved++;
            }
        }

        // Early exit if few nodes moved
        if (moved < 10) break;
    }
}

// Compute radial tree layout - organic style with natural jitter
function computeRadialTreeLayout(nodes, edges) {
    const children = {};
    const nodeMap = {};

    nodes.forEach(n => {
        nodeMap[n.key] = n;
        children[n.key] = [];
    });

    edges.forEach(e => {
        if (children[e.source]) {
            children[e.source].push(e.target);
        }
    });

    // Count invites
    Object.keys(children).forEach(username => {
        inviteCounts[username] = children[username].length;
    });

    // Find root
    let root = 'jcs';
    if (!nodeMap[root]) {
        for (const n of nodes) {
            if (!n.attributes.invited_by) { root = n.key; break; }
        }
    }

    // Calculate subtree sizes and accumulated karma
    const subtreeSize = {};
    const subtreeKarma = {};  // Total karma of all descendants

    function calcSubtreeStats(node) {
        const kids = children[node] || [];
        const nodeKarma = nodeMap[node]?.attributes?.karma || 0;

        if (kids.length === 0) {
            subtreeSize[node] = 1;
            subtreeKarma[node] = nodeKarma;
            return { size: 1, karma: nodeKarma };
        }

        let totalSize = 1;  // Count self
        let totalKarma = nodeKarma;  // Include own karma

        for (const kid of kids) {
            const kidStats = calcSubtreeStats(kid);
            totalSize += kidStats.size;
            totalKarma += kidStats.karma;
        }

        subtreeSize[node] = totalSize;
        subtreeKarma[node] = totalKarma;
        return { size: totalSize, karma: totalKarma };
    }
    calcSubtreeStats(root);

    const positions = {};
    const depths = {};

    // Seeded random for consistent jitter
    function seededRandom(seed) {
        const x = Math.sin(seed * 9999) * 10000;
        return x - Math.floor(x);
    }

    // Get max karma for scaling
    let maxKarmaInGraph = 1;
    nodes.forEach(n => {
        const k = n.attributes.karma || 0;
        if (k > maxKarmaInGraph) maxKarmaInGraph = k;
    });

    function layoutNode(node, depth, angleStart, angleEnd, parentAngle = null) {
        // Base radius from depth - increased spacing between bands
        const baseRadius = 80 + depth * 120;

        // Get node's karma for radial scaling
        const nodeData = nodeMap[node];
        const karma = nodeData?.attributes?.karma || 0;
        const inviteCount = (children[node] || []).length;

        // Karma-based offset: use log scale with more aggressive spread
        // sqrt of log gives better distribution for mid-range values
        const karmaFactor = karma > 0 ? Math.sqrt(Math.log(karma + 1) / Math.log(maxKarmaInGraph + 1)) : 0;

        // Invite count factor - more invites = further out
        const inviteFactor = Math.min(Math.sqrt(inviteCount / 20), 1);  // sqrt for smoother distribution

        // Subtree size factor - larger subtrees extend further (they're "leading" more people)
        const subtreeFactor = Math.min(Math.log(subtreeSize[node] + 1) / 8, 1);

        // Combined influence: 40% karma, 30% invites, 30% subtree
        const influence = karmaFactor * 0.4 + inviteFactor * 0.3 + subtreeFactor * 0.3;

        // Radial offset based on influence (0 to 80 units within the band)
        const influenceOffset = influence * 80;

        // Calculate base angle - center of allocated sector
        let angle = (angleStart + angleEnd) / 2;

        // Bias toward parent's angle to keep edges shorter
        if (parentAngle !== null && depth > 1) {
            const sectorCenter = angle;
            // Blend 70% toward parent, 30% sector center
            angle = parentAngle * 0.3 + sectorCenter * 0.7;
            // Clamp to stay within allocated sector (with small margin)
            const margin = (angleEnd - angleStart) * 0.1;
            angle = Math.max(angleStart + margin, Math.min(angleEnd - margin, angle));
        }

        // Small random jitter for organic look
        const seed = node.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        const jitterAmount = 15;  // Small fixed jitter
        const radialJitter = (seededRandom(seed) - 0.5) * jitterAmount;
        // Very small angular jitter to keep edges short
        const angleJitter = (seededRandom(seed * 2) - 0.5) * 0.015 * Math.min(depth, 5);

        const finalRadius = baseRadius + influenceOffset + radialJitter;
        const finalAngle = angle + angleJitter;
        positions[node] = {
            x: finalRadius * Math.cos(finalAngle),
            y: finalRadius * Math.sin(finalAngle)
        };
        depths[node] = depth;

        const kids = children[node] || [];
        if (kids.length === 0) return;

        kids.sort((a, b) => (subtreeSize[b] || 1) - (subtreeSize[a] || 1));
        const totalSize = kids.reduce((sum, k) => sum + (subtreeSize[k] || 1), 0);
        let currentAngle = angleStart;

        for (const kid of kids) {
            const kidSize = subtreeSize[kid] || 1;
            const kidAngleSpan = (angleEnd - angleStart) * (kidSize / totalSize);
            layoutNode(kid, depth + 1, currentAngle, currentAngle + kidAngleSpan, finalAngle);
            currentAngle += kidAngleSpan;
        }
    }

    layoutNode(root, 0, 0, Math.PI * 2);

    // Scale to fill space
    const maxRadius = Math.max(...Object.values(positions).map(p => Math.sqrt(p.x * p.x + p.y * p.y)));
    const scale = 5000 / maxRadius;
    Object.keys(positions).forEach(node => {
        positions[node].x *= scale;
        positions[node].y *= scale;
    });

    return { positions, depths, subtreeSize, subtreeKarma, children };
}

async function initGraph() {
    try {
        const response = await fetch('data/graph.json');
        graphData = await response.json();

        try {
            const enrichResponse = await fetch('data/enriched.json');
            enrichedData = await enrichResponse.json();
        } catch (e) {}

        const loadingEl = document.getElementById('loading');
        if (loadingEl) loadingEl.style.display = 'none';

        // Set max karma for size scaling
        maxKarma = graphData.stats.max_karma || 1;

        const statUsers = document.getElementById('stat-users');
        const statKarma = document.getElementById('stat-karma');
        if (statUsers) statUsers.textContent = graphData.stats.total_users.toLocaleString();
        if (statKarma) statKarma.textContent = maxKarma.toLocaleString();

        const topInvitersEl = document.getElementById('top-inviters');
        if (topInvitersEl) {
            topInvitersEl.innerHTML = graphData.stats.top_inviters.slice(0, 12).map(inv => `
                <div class="inviter-row" onclick="focusNode('${inv.username}')">
                    <span class="inviter-name">${inv.username}</span>
                    <span class="inviter-count">${inv.count}</span>
                </div>
            `).join('');
        }

        buildGraph(0);
        setupSearch();
        setupKarmaFilter();
        setupTooltip();
        setupHighlightModes();
        setupZoomTracking();

    } catch (error) {
        console.error('Failed to load graph:', error);
        const loadingEl = document.getElementById('loading');
        if (loadingEl) {
            loadingEl.innerHTML = `<div style="color: #ff6b6b;">Error: ${error.message}</div>`;
        }
    }
}

function buildGraph(minKarma) {
    if (sigma) { sigma.kill(); sigma = null; }

    graph = new graphology.Graph();

    // Filter nodes
    const filteredNodes = graphData.nodes.filter(n => (n.attributes.karma || 0) >= minKarma);
    const nodeSet = new Set(filteredNodes.map(n => n.key));
    const filteredEdges = graphData.edges.filter(e => nodeSet.has(e.source) && nodeSet.has(e.target));

    // Compute radial layout
    console.log('Computing radial tree layout...');
    const { positions, depths, subtreeSize, subtreeKarma, children } = computeRadialTreeLayout(filteredNodes, filteredEdges);
    childrenMap = children;  // Store globally for fast descendant lookup

    // Store all node data for LOD
    allNodeData = filteredNodes.map(node => {
        const karma = node.attributes.karma || 0;
        let pos = positions[node.key];

        // If node has no position (orphaned), place in circle
        if (!pos) {
            const seed = node.key.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
            const angle = (seed % 360) * Math.PI / 180;
            const radius = 800 + (seed % 500);
            pos = { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
        }

        return {
            key: node.key,
            x: pos.x,
            y: pos.y,
            karma: karma,
            inviteCount: inviteCounts[node.key] || 0,
            depth: depths[node.key] || 0,
            invited_by: node.attributes.invited_by,
            // Accumulated stats for the subtree
            descendantCount: (subtreeSize[node.key] || 1) - 1,  // Exclude self
            descendantKarma: (subtreeKarma[node.key] || karma) - karma,  // Exclude own karma
        };
    });

    // Add all nodes
    allNodeData.forEach(node => {
        graph.addNode(node.key, {
            label: node.key,
            x: node.x,
            y: node.y,
            size: getNodeSize(node.karma),
            color: getNodeColor(node.karma, node.inviteCount),
            karma: node.karma,
            inviteCount: node.inviteCount,
            depth: node.depth,
            invited_by: node.invited_by,
            descendantCount: node.descendantCount,
            descendantKarma: node.descendantKarma,
            hidden: false,
        });
    });

    // Add edges
    filteredEdges.forEach((edge) => {
        if (!graph.hasEdge(edge.source, edge.target)) {
            graph.addEdge(edge.source, edge.target, {
                color: COLORS.edge,
                size: 0.5,
            });
        }
    });

    const statVisible = document.getElementById('stat-visible');
    if (statVisible) statVisible.textContent = graph.order.toLocaleString();
    console.log(`Graph built: ${graph.order} nodes, ${graph.size} edges`);

    // Collision avoidance disabled - was causing long edges
    // applyCollisionAvoidance(graph, 12);


    // Create sigma instance
    const container = document.getElementById('sigma-container');
    sigma = new Sigma(graph, container, {
        renderEdgeLabels: false,
        enableEdgeEvents: false,
        labelColor: { color: '#fff' },
        labelSize: 12,
        labelWeight: 'bold',
        minCameraRatio: 0.01,
        maxCameraRatio: 5,
        labelDensity: 0.7,           // Show more labels
        labelGridCellSize: 80,       // Smaller grid = more labels
        zIndex: true,
        labelRenderedSizeThreshold: 3,  // Show labels for smaller nodes
        // Disable the default hover label box by providing empty renderer
        hoverRenderer: () => {},
        // Better label rendering
        labelRenderer: (context, data, settings) => {
            const size = settings.labelSize;
            const font = `${settings.labelWeight} ${size}px Inter, sans-serif`;
            context.font = font;

            // Draw text shadow/outline for better readability
            context.fillStyle = 'rgba(0, 0, 0, 0.8)';
            context.fillText(data.label, data.x + data.size + 4, data.y + size / 3);
            context.fillText(data.label, data.x + data.size + 2, data.y + size / 3);
            context.fillText(data.label, data.x + data.size + 3, data.y + size / 3 - 1);
            context.fillText(data.label, data.x + data.size + 3, data.y + size / 3 + 1);

            // Draw actual label
            context.fillStyle = '#fff';
            context.fillText(data.label, data.x + data.size + 3, data.y + size / 3);
        },
    });

    // Start with a good view - zoomed in enough to see nodes clearly
    sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: 0.25 });

    sigma.on('clickNode', ({ node }) => showNodeDetail(node));
    sigma.on('clickStage', () => closeDetail());

    // Initial LOD - show all at start since we're zoomed in
    const lodNodes = document.getElementById('lod-nodes');
    if (lodNodes) lodNodes.textContent = `${graph.order.toLocaleString()}/${graph.order.toLocaleString()}`;

    console.log(`Graph built: ${graph.order} nodes, ${graph.size} edges`);
}

function setupZoomTracking() {
    if (!sigma) return;

    let lodDebounce = null;

    sigma.getCamera().on('updated', () => {
        const ratio = sigma.getCamera().ratio;
        currentZoom = ratio;

        // Update zoom indicator
        const zoomLevel = document.getElementById('zoom-level');
        if (zoomLevel) {
            zoomLevel.textContent = `${Math.round(ratio * 100)}%`;
        }

        // Debounce LOD updates for performance
        if (lodDebounce) clearTimeout(lodDebounce);
        lodDebounce = setTimeout(() => {
            applyLOD(ratio);
        }, 100);
    });
}

function applyLOD(zoom) {
    if (!graph || currentHighlight !== 'none') return;

    // Find appropriate threshold - higher zoom ratio = more zoomed out
    let threshold = LOD_THRESHOLDS[0];  // Default: show all
    for (const t of LOD_THRESHOLDS) {
        if (zoom <= t.maxZoom) {
            threshold = t;
            break;
        }
    }

    let visibleCount = 0;

    graph.forEachNode((node, attrs) => {
        const shouldHide = attrs.karma < threshold.minKarma &&
                          (attrs.inviteCount || 0) < threshold.minInvites;

        graph.setNodeAttribute(node, 'hidden', shouldHide);

        if (!shouldHide) visibleCount++;
    });

    // Make edges fainter when zoomed out (but don't hide completely)
    graph.forEachEdge((edge) => {
        if (zoom > 0.6) {
            graph.setEdgeAttribute(edge, 'color', COLORS.edgeMuted);
            graph.setEdgeAttribute(edge, 'hidden', false);
        } else {
            graph.setEdgeAttribute(edge, 'color', COLORS.edge);
            graph.setEdgeAttribute(edge, 'hidden', false);
        }
    });

    // Update LOD info
    const lodNodes = document.getElementById('lod-nodes');
    if (lodNodes) {
        lodNodes.textContent = `${visibleCount.toLocaleString()}/${graph.order.toLocaleString()}`;
    }
}

function updateLODInfo() {
    // Now handled by applyLOD
    applyLOD(currentZoom || 0.12);
}

function setupHighlightModes() {
    const btnKarma = document.getElementById('btn-highlight-karma');
    const btnInviters = document.getElementById('btn-highlight-inviters');
    const btnReset = document.getElementById('btn-highlight-reset');

    if (btnKarma) btnKarma.addEventListener('click', () => highlightTopKarma());
    if (btnInviters) btnInviters.addEventListener('click', () => highlightTopInviters());
    if (btnReset) btnReset.addEventListener('click', () => resetHighlight());
}

function highlightTopKarma() {
    if (!graph) return;
    currentHighlight = 'karma';

    const nodes = [];
    graph.forEachNode((node, attrs) => nodes.push({ node, karma: attrs.karma }));
    nodes.sort((a, b) => b.karma - a.karma);
    const topSet = new Set(nodes.slice(0, 50).map(n => n.node));

    graph.forEachNode((node, attrs) => {
        if (topSet.has(node)) {
            graph.setNodeAttribute(node, 'color', COLORS.superKarma);
            graph.setNodeAttribute(node, 'zIndex', 1);
            graph.setNodeAttribute(node, 'hidden', false);
        } else {
            graph.setNodeAttribute(node, 'color', COLORS.muted);
            graph.setNodeAttribute(node, 'zIndex', 0);
        }
    });

    graph.forEachEdge(edge => {
        graph.setEdgeAttribute(edge, 'color', COLORS.edgeMuted);
    });

    sigma.refresh();
    updateHighlightButtons('karma');
}

function highlightTopInviters() {
    if (!graph) return;
    currentHighlight = 'inviters';

    const nodes = [];
    graph.forEachNode((node, attrs) => nodes.push({ node, count: attrs.inviteCount || 0 }));
    nodes.sort((a, b) => b.count - a.count);
    const topSet = new Set(nodes.slice(0, 50).map(n => n.node));

    graph.forEachNode((node, attrs) => {
        if (topSet.has(node)) {
            graph.setNodeAttribute(node, 'color', COLORS.superInviter);
            graph.setNodeAttribute(node, 'zIndex', 1);
            graph.setNodeAttribute(node, 'hidden', false);
        } else {
            graph.setNodeAttribute(node, 'color', COLORS.muted);
            graph.setNodeAttribute(node, 'zIndex', 0);
        }
    });

    graph.forEachEdge(edge => {
        graph.setEdgeAttribute(edge, 'color', COLORS.edgeMuted);
    });

    sigma.refresh();
    updateHighlightButtons('inviters');
}

function resetHighlight() {
    if (!graph) return;
    currentHighlight = 'none';

    graph.forEachNode((node, attrs) => {
        graph.setNodeAttribute(node, 'color', getNodeColor(attrs.karma, attrs.inviteCount));
        graph.setNodeAttribute(node, 'size', getNodeSize(attrs.karma));
        graph.setNodeAttribute(node, 'zIndex', 0);
        graph.setNodeAttribute(node, 'hidden', false);
    });

    graph.forEachEdge(edge => {
        graph.setEdgeAttribute(edge, 'color', COLORS.edge);
        graph.setEdgeAttribute(edge, 'size', 1);  // Reset to default size
    });

    sigma.refresh();
    updateHighlightButtons('none');
}

function updateHighlightButtons(active) {
    ['karma', 'inviters', 'reset'].forEach(type => {
        const btn = document.getElementById(`btn-highlight-${type}`);
        if (btn) {
            btn.classList.toggle('active', (type === 'reset' && active === 'none') || type === active);
        }
    });
}

function showNodeDetail(nodeKey) {
    if (!graph.hasNode(nodeKey)) return;

    const attrs = graph.getNodeAttributes(nodeKey);
    const enriched = enrichedData[nodeKey] || {};

    document.getElementById('detail-username').textContent = nodeKey;

    const invitedUsers = [];
    graph.forEachNode((node, nodeAttrs) => {
        if (nodeAttrs.invited_by === nodeKey) {
            invitedUsers.push({ name: node, karma: nodeAttrs.karma || 0 });
        }
    });
    invitedUsers.sort((a, b) => b.karma - a.karma);

    let html = `
        <div class="detail-row badges">
            <span class="karma-badge">${(attrs.karma || 0).toLocaleString()} karma</span>
            ${attrs.inviteCount > 0 ? `<span class="invite-badge">${attrs.inviteCount} invited</span>` : ''}
        </div>
    `;

    if (attrs.invited_by) {
        html += `
            <div class="detail-row">
                <div class="detail-label">Invited by</div>
                <div class="detail-value">
                    <a href="#" onclick="focusNode('${attrs.invited_by}'); return false;">${attrs.invited_by}</a>
                </div>
            </div>
        `;
    } else {
        html += `<div class="detail-row"><div class="detail-value" style="color: #ff6b6b;">👑 Founder</div></div>`;
    }

    if (attrs.depth !== undefined) {
        html += `<div class="detail-row"><div class="detail-label">Generation</div><div class="detail-value">${attrs.depth}</div></div>`;
    }

    if (invitedUsers.length > 0) {
        html += `
            <div class="detail-row">
                <div class="detail-label">Top invitees</div>
                <div class="detail-value invited-list">
                    ${invitedUsers.slice(0, 15).map(u => `<a href="#" onclick="focusNode('${u.name}'); return false;">${u.name}</a>`).join('')}
                    ${invitedUsers.length > 15 ? `<span style="color:#555">+${invitedUsers.length - 15}</span>` : ''}
                </div>
            </div>
        `;
    }

    // Accumulated stats (descendants)
    const descendantCount = attrs.descendantCount || 0;
    const descendantKarma = attrs.descendantKarma || 0;
    if (descendantCount > 0) {
        html += `
            <div class="detail-row descendants-section">
                <div class="detail-label">Invitation Tree</div>
                <div class="detail-value">
                    <a href="#" class="descendant-stat" onclick="highlightDescendants('${nodeKey}'); return false;" title="Click to highlight all descendants">
                        <span class="tree-badge">${descendantCount.toLocaleString()} descendants</span>
                        <span class="tree-badge karma">${descendantKarma.toLocaleString()} total karma</span>
                    </a>
                </div>
            </div>
        `;
    }

    if (enriched.full_name) {
        html += `<div class="enrichment-section">
            <div class="detail-label" style="color:#ff6b6b;">Enriched</div>
            <div class="detail-value">${escapeHtml(enriched.full_name)}</div>
            ${enriched.linkedin ? `<div class="detail-value"><a href="${enriched.linkedin}" target="_blank">LinkedIn</a></div>` : ''}
        </div>`;
    }

    html += `<div class="detail-row" style="margin-top: 10px;">
        <a href="https://lobste.rs/~${nodeKey}" target="_blank" style="color: #ff6b6b;">View on lobste.rs →</a>
    </div>`;

    document.getElementById('detail-content').innerHTML = html;
    document.getElementById('node-detail').classList.add('visible');

    highlightNodeConnections(nodeKey);
}

function highlightNodeConnections(nodeKey) {
    currentHighlight = 'node';  // Track that we're highlighting a node
    const neighbors = new Set(graph.neighbors(nodeKey));
    neighbors.add(nodeKey);

    graph.forEachNode((node, attrs) => {
        // Make sure all nodes are visible first
        graph.setNodeAttribute(node, 'hidden', false);

        if (neighbors.has(node)) {
            // Use bright magenta for selected node (visible against dark bg, not white)
            const nodeColor = node === nodeKey ? '#ff00ff' : getNodeColor(attrs.karma, attrs.inviteCount);
            graph.setNodeAttribute(node, 'color', nodeColor);
            graph.setNodeAttribute(node, 'zIndex', 1);
            // Slightly larger for selected
            const size = node === nodeKey ? getNodeSize(attrs.karma) * 1.5 : getNodeSize(attrs.karma);
            graph.setNodeAttribute(node, 'size', size);
        } else {
            graph.setNodeAttribute(node, 'color', COLORS.muted);
            graph.setNodeAttribute(node, 'zIndex', 0);
            graph.setNodeAttribute(node, 'size', getNodeSize(attrs.karma));
        }
    });

    graph.forEachEdge((edge, attrs, source, target) => {
        if (source === nodeKey || target === nodeKey) {
            graph.setEdgeAttribute(edge, 'color', COLORS.edgeHighlight);
            graph.setEdgeAttribute(edge, 'size', 1.5);
        } else {
            graph.setEdgeAttribute(edge, 'color', COLORS.edgeMuted);
            graph.setEdgeAttribute(edge, 'size', 1);  // Reset to default
        }
    });

    sigma.refresh();
}

// Highlight all descendants of a node with a cascade visualization
// Optimized: uses pre-computed childrenMap for O(n) traversal instead of O(n²)
function highlightDescendants(rootKey) {
    if (!graph.hasNode(rootKey)) return;

    currentHighlight = 'descendants';

    // BFS to collect descendants using pre-computed children map - O(n)
    const descendants = new Map();  // node -> depth from root
    const queue = [[rootKey, 0]];

    while (queue.length > 0) {
        const [node, depth] = queue.shift();
        if (descendants.has(node)) continue;
        descendants.set(node, depth);

        const kids = childrenMap[node] || [];
        for (const kid of kids) {
            if (!descendants.has(kid)) {
                queue.push([kid, depth + 1]);
            }
        }
    }

    const maxDepth = Math.max(...descendants.values());
    const descendantCount = descendants.size;

    // Color palette: gradient from root to leaves (warm to cool)
    const depthColors = [
        '#ff00ff',  // Root: bright magenta
        '#ff4444',  // Gen 1: red
        '#ff8844',  // Gen 2: orange
        '#ffcc44',  // Gen 3: yellow
        '#88ff44',  // Gen 4: lime
        '#44ffaa',  // Gen 5: cyan
        '#44aaff',  // Gen 6: sky blue
        '#8844ff',  // Gen 7+: purple
    ];

    // Batch all node updates before refresh
    graph.forEachNode((node, attrs) => {
        if (descendants.has(node)) {
            const depth = descendants.get(node);
            const colorIndex = Math.min(depth, depthColors.length - 1);
            graph.setNodeAttribute(node, 'color', depthColors[colorIndex]);
            graph.setNodeAttribute(node, 'zIndex', 10 - depth);
            const baseSize = getNodeSize(attrs.karma);
            const sizeMultiplier = node === rootKey ? 2 : Math.max(0.8, 1.5 - depth * 0.1);
            graph.setNodeAttribute(node, 'size', baseSize * sizeMultiplier);
        } else {
            graph.setNodeAttribute(node, 'color', COLORS.muted);
            graph.setNodeAttribute(node, 'zIndex', 0);
            graph.setNodeAttribute(node, 'size', getNodeSize(attrs.karma) * 0.7);
        }
    });

    // Batch edge updates
    graph.forEachEdge((edge, attrs, source, target) => {
        const sourceInTree = descendants.has(source);
        const targetInTree = descendants.has(target);

        if (sourceInTree && targetInTree) {
            const depth = Math.min(descendants.get(source), descendants.get(target));
            const colorIndex = Math.min(depth, depthColors.length - 1);
            graph.setEdgeAttribute(edge, 'color', depthColors[colorIndex] + '88');
            graph.setEdgeAttribute(edge, 'size', 2);
        } else {
            graph.setEdgeAttribute(edge, 'color', COLORS.edgeMuted);
            graph.setEdgeAttribute(edge, 'size', 0.5);
        }
    });

    sigma.refresh();

    // Only animate for smaller trees (< 500 descendants) to avoid performance issues
    if (descendantCount < 500) {
        animateCascade(rootKey, descendants, depthColors);
    }
}

// Animate a cascade effect through the descendant tree
// Optimized: groups nodes by depth upfront, limits refresh calls
function animateCascade(rootKey, descendants, depthColors) {
    const maxDepth = Math.max(...descendants.values());

    // Pre-group nodes by depth for faster animation
    const nodesByDepth = [];
    for (let d = 0; d <= maxDepth; d++) nodesByDepth[d] = [];
    descendants.forEach((depth, node) => {
        nodesByDepth[depth].push(node);
    });

    let currentAnimDepth = 0;

    function animateStep() {
        if (currentAnimDepth > maxDepth) return;

        const nodesAtDepth = nodesByDepth[currentAnimDepth];

        // Enlarge all nodes at this depth
        for (const node of nodesAtDepth) {
            if (!graph.hasNode(node)) continue;
            const attrs = graph.getNodeAttributes(node);
            const baseSize = getNodeSize(attrs.karma);
            const depth = descendants.get(node);
            const sizeMultiplier = node === rootKey ? 2 : Math.max(0.8, 1.5 - depth * 0.1);
            graph.setNodeAttribute(node, 'size', baseSize * sizeMultiplier * 1.3);
        }
        sigma.refresh();

        // Schedule shrink back
        const depthToShrink = currentAnimDepth;
        setTimeout(() => {
            for (const node of nodesByDepth[depthToShrink]) {
                if (!graph.hasNode(node)) continue;
                const attrs = graph.getNodeAttributes(node);
                const baseSize = getNodeSize(attrs.karma);
                const depth = descendants.get(node);
                const sizeMultiplier = node === rootKey ? 2 : Math.max(0.8, 1.5 - depth * 0.1);
                graph.setNodeAttribute(node, 'size', baseSize * sizeMultiplier);
            }
            sigma.refresh();
        }, 120);

        currentAnimDepth++;
        setTimeout(animateStep, 80);
    }

    setTimeout(animateStep, 150);
}

function closeDetail() {
    document.getElementById('node-detail').classList.remove('visible');
    if (currentHighlight === 'karma') highlightTopKarma();
    else if (currentHighlight === 'inviters') highlightTopInviters();
    else if (currentHighlight === 'descendants') {
        currentHighlight = 'none';
        resetHighlight();
    }
    else {
        currentHighlight = 'none';
        resetHighlight();
    }
}

function focusNode(nodeKey) {
    if (!graph || !graph.hasNode(nodeKey)) {
        const karmaFilter = document.getElementById('karma-filter');
        const karmaValue = document.getElementById('karma-value');
        if (karmaFilter && parseInt(karmaFilter.value) > 0) {
            if (karmaFilter) karmaFilter.value = 0;
            if (karmaValue) karmaValue.textContent = '0';
            buildGraph(0);
        }
        setTimeout(() => {
            if (graph && graph.hasNode(nodeKey)) doFocusNode(nodeKey);
        }, 100);
        return;
    }
    doFocusNode(nodeKey);
}

function doFocusNode(nodeKey) {
    if (!sigma || !graph.hasNode(nodeKey)) return;

    // Get graph bounds to normalize coordinates
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    graph.forEachNode((node, attrs) => {
        if (attrs.x < minX) minX = attrs.x;
        if (attrs.x > maxX) maxX = attrs.x;
        if (attrs.y < minY) minY = attrs.y;
        if (attrs.y > maxY) maxY = attrs.y;
    });

    // Get node position from graph attributes
    const attrs = graph.getNodeAttributes(nodeKey);

    // Normalize to 0-1 range (what camera expects)
    const normalizedX = (attrs.x - minX) / (maxX - minX);
    const normalizedY = (attrs.y - minY) / (maxY - minY);

    sigma.getCamera().animate(
        { x: normalizedX, y: normalizedY, ratio: 0.1 },
        { duration: 400 }
    );

    showNodeDetail(nodeKey);
}

function resetView() {
    if (sigma) sigma.getCamera().animate({ x: 0.5, y: 0.5, ratio: 0.12 }, { duration: 300 });
}

function zoomOut() {
    if (sigma) sigma.getCamera().animate({ x: 0.5, y: 0.5, ratio: 0.5 }, { duration: 400 });
}

function zoomToFit() {
    if (sigma) sigma.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1 }, { duration: 500 });
}

function setupSearch() {
    const searchInput = document.getElementById('search');
    const searchResults = document.getElementById('search-results');
    if (!searchInput || !searchResults) return;

    let debounceTimer;

    function showResults(matches) {
        if (matches.length === 0) {
            searchResults.classList.remove('visible');
            return;
        }

        // Sort by karma and take top 10
        const sorted = matches
            .map(name => {
                const attrs = graph.getNodeAttributes(name);
                return { name, karma: attrs?.karma || 0 };
            })
            .sort((a, b) => b.karma - a.karma)
            .slice(0, 10);

        searchResults.innerHTML = sorted.map(m => `
            <div class="search-result" data-user="${m.name}">
                <span class="name">${m.name}</span>
                <span class="karma">${m.karma.toLocaleString()} karma</span>
            </div>
        `).join('');

        searchResults.classList.add('visible');

        // Add click handlers
        searchResults.querySelectorAll('.search-result').forEach(el => {
            el.addEventListener('click', () => {
                const user = el.dataset.user;
                searchInput.value = user;
                searchResults.classList.remove('visible');
                focusNode(user);
            });
        });
    }

    function hideResults() {
        setTimeout(() => searchResults.classList.remove('visible'), 150);
    }

    searchInput.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const query = e.target.value.toLowerCase().trim();
            if (!query) {
                searchResults.classList.remove('visible');
                resetHighlight();
                return;
            }

            const matches = [];
            graph.forEachNode((node) => {
                if (node.toLowerCase().includes(query)) matches.push(node);
            });

            showResults(matches);

            // Also highlight matches on the graph
            if (matches.length > 0 && matches.length < 100) {
                currentHighlight = 'search';
                const matchSet = new Set(matches);
                graph.forEachNode((node, attrs) => {
                    if (matchSet.has(node)) {
                        graph.setNodeAttribute(node, 'color', COLORS.superKarma);
                        graph.setNodeAttribute(node, 'hidden', false);
                        graph.setNodeAttribute(node, 'zIndex', 1);
                    } else {
                        graph.setNodeAttribute(node, 'color', COLORS.muted);
                        graph.setNodeAttribute(node, 'zIndex', 0);
                    }
                });
                sigma.refresh();
            }
        }, 150);
    });

    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const query = e.target.value.toLowerCase().trim();
            let found = null;
            graph.forEachNode((node) => {
                if (!found && node.toLowerCase() === query) found = node;
            });
            if (!found) {
                graph.forEachNode((node) => {
                    if (!found && node.toLowerCase().includes(query)) found = node;
                });
            }
            if (found) {
                searchResults.classList.remove('visible');
                focusNode(found);
                searchInput.blur();
            }
        }
    });

    searchInput.addEventListener('blur', hideResults);
    searchInput.addEventListener('focus', (e) => {
        if (e.target.value.trim()) {
            // Re-trigger search on focus if there's a query
            searchInput.dispatchEvent(new Event('input'));
        }
    });
}

function setupKarmaFilter() {
    const slider = document.getElementById('karma-filter');
    const valueDisplay = document.getElementById('karma-value');
    if (!slider) return;

    slider.addEventListener('input', (e) => {
        if (valueDisplay) valueDisplay.textContent = e.target.value;
    });

    slider.addEventListener('change', (e) => {
        buildGraph(parseInt(e.target.value));
    });
}

function setupTooltip() {
    const tooltip = document.getElementById('tooltip');
    if (!tooltip || !sigma) return;

    sigma.on('enterNode', ({ node }) => {
        const attrs = graph.getNodeAttributes(node);
        const ttName = tooltip.querySelector('.tt-name');
        const ttKarma = tooltip.querySelector('.tt-karma');
        const ttInvites = tooltip.querySelector('.tt-invites');

        if (ttName) ttName.textContent = node;
        if (ttKarma) ttKarma.textContent = `${(attrs.karma || 0).toLocaleString()} karma`;
        if (ttInvites) ttInvites.textContent = attrs.inviteCount > 0 ? ` · ${attrs.inviteCount} invited` : '';
        tooltip.style.display = 'block';
    });

    sigma.on('leaveNode', () => { tooltip.style.display = 'none'; });

    document.addEventListener('mousemove', (e) => {
        tooltip.style.left = (e.clientX + 12) + 'px';
        tooltip.style.top = (e.clientY + 12) + 'px';
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Expose globals
window.resetView = resetView;
window.zoomOut = zoomOut;
window.zoomToFit = zoomToFit;
window.focusNode = focusNode;
window.closeDetail = closeDetail;
window.highlightTopKarma = highlightTopKarma;
window.highlightTopInviters = highlightTopInviters;
window.resetHighlight = resetHighlight;
window.highlightDescendants = highlightDescendants;

// Mobile menu toggle
function setupMobileMenu() {
    const toggle = document.getElementById('mobile-toggle');
    const controls = document.getElementById('controls');
    if (!toggle || !controls) return;

    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        controls.classList.toggle('open');
        toggle.textContent = controls.classList.contains('open') ? '✕' : '☰';
    });

    // Close menu when clicking on the graph
    document.getElementById('sigma-container')?.addEventListener('click', () => {
        controls.classList.remove('open');
        toggle.textContent = '☰';
    });

    // Close menu when selecting a node from the list
    controls.addEventListener('click', (e) => {
        if (e.target.closest('.top-list-item')) {
            controls.classList.remove('open');
            toggle.textContent = '☰';
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initGraph();
    setupMobileMenu();
});
