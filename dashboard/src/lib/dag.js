// ── DAG Layout Engine ────────────────────────────────────────────────────────
//
// Pure function: steps[] → { nodes[], edges[], width, height }
// Uses Kahn's algorithm for topological sort into layers,
// then computes SVG coordinates for rendering.

const NODE_W = 160;
const NODE_H = 50;
const LAYER_GAP = 200;  // horizontal gap between layers
const NODE_GAP = 80;    // vertical gap between nodes in same layer

/**
 * Topological sort into layers using Kahn's algorithm.
 * @param {Array<{name: string, depends_on?: string[]}>} steps
 * @returns {string[][]} layers — each inner array can execute in parallel
 */
export function topoLayers(steps) {
  const adj = {};    // parent → children
  const inDeg = {};  // node → in-degree

  for (const s of steps) {
    adj[s.name] = adj[s.name] || [];
    inDeg[s.name] = inDeg[s.name] || 0;
  }

  for (const s of steps) {
    for (const dep of s.depends_on || []) {
      adj[dep] = adj[dep] || [];
      adj[dep].push(s.name);
      inDeg[s.name] = (inDeg[s.name] || 0) + 1;
    }
  }

  const layers = [];
  let queue = Object.keys(inDeg).filter((k) => inDeg[k] === 0);

  while (queue.length > 0) {
    layers.push([...queue]);
    const next = [];
    for (const node of queue) {
      for (const child of adj[node] || []) {
        inDeg[child]--;
        if (inDeg[child] === 0) next.push(child);
      }
    }
    queue = next;
  }

  return layers;
}

/**
 * Compute layout for DAG visualization.
 * @param {Array<{name: string, task?: string, depends_on?: string[]}>} steps
 * @param {Object<string, string>} [statusMap] — optional { stepName: status }
 * @returns {{ nodes: Array, edges: Array, width: number, height: number }}
 */
export function layoutDAG(steps, statusMap = {}) {
  if (!steps || steps.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  const layers = topoLayers(steps);
  const nodeMap = {};
  const nodes = [];

  // Compute max layer height for centering
  const maxLayerSize = Math.max(...layers.map((l) => l.length));

  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    const layerH = layer.length * (NODE_H + NODE_GAP) - NODE_GAP;
    const totalH = maxLayerSize * (NODE_H + NODE_GAP) - NODE_GAP;
    const offsetY = (totalH - layerH) / 2;

    for (let ni = 0; ni < layer.length; ni++) {
      const name = layer[ni];
      const step = steps.find((s) => s.name === name);
      const node = {
        name,
        task: step?.task || "",
        x: li * LAYER_GAP + 40,
        y: ni * (NODE_H + NODE_GAP) + offsetY + 40,
        layer: li,
        indexInLayer: ni,
        status: statusMap[name] || "idle",
        w: NODE_W,
        h: NODE_H,
      };
      nodes.push(node);
      nodeMap[name] = node;
    }
  }

  // Build edges with cubic bezier paths
  const edges = [];
  for (const step of steps) {
    for (const dep of step.depends_on || []) {
      const from = nodeMap[dep];
      const to = nodeMap[step.name];
      if (!from || !to) continue;

      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      const cx = (x1 + x2) / 2;

      edges.push({
        from: dep,
        to: step.name,
        path: `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`,
      });
    }
  }

  const width = layers.length * LAYER_GAP + 80;
  const height = maxLayerSize * (NODE_H + NODE_GAP) + 40;

  return { nodes, edges, width, height };
}
