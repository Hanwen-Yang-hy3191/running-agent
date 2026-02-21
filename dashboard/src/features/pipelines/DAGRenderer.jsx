import { useMemo } from "react";
import { layoutDAG } from "../../lib/dag";

/**
 * Pure SVG DAG visualizer.
 *
 * Props:
 *   steps       — pipeline step definitions [{name, task, depends_on}]
 *   statusMap   — optional { stepName: status } for live mode coloring
 *   onSelect    — optional callback(stepName) when clicking a node
 *   compact     — if true, renders smaller (for inline preview)
 */
export default function DAGRenderer({
  steps,
  statusMap = {},
  onSelect,
  compact = false,
}) {
  const { nodes, edges, width, height } = useMemo(
    () => layoutDAG(steps || [], statusMap),
    [steps, statusMap]
  );

  if (!steps || steps.length === 0) {
    return (
      <div className="dag-empty">No steps defined</div>
    );
  }

  const scale = compact ? 0.6 : 1;
  const svgW = width * scale;
  const svgH = height * scale;

  return (
    <svg
      className="dag-container"
      viewBox={`0 0 ${width} ${height}`}
      width={svgW}
      height={svgH}
      style={{ maxWidth: "100%", height: "auto" }}
    >
      {/* Edges (background) */}
      {edges.map((e, i) => (
        <path
          key={i}
          d={e.path}
          className="dag-edge"
          markerEnd="url(#arrowhead)"
        />
      ))}

      {/* Arrow marker */}
      <defs>
        <marker
          id="arrowhead"
          markerWidth="8"
          markerHeight="6"
          refX="8"
          refY="3"
          orient="auto"
        >
          <polygon
            points="0 0, 8 3, 0 6"
            fill="var(--text-muted)"
          />
        </marker>
      </defs>

      {/* Nodes (foreground) */}
      {nodes.map((n) => {
        const status = statusMap[n.name] || "idle";
        return (
          <g
            key={n.name}
            className={`dag-node dag-node--${status}`}
            onClick={() => onSelect?.(n.name)}
            style={{ cursor: onSelect ? "pointer" : "default" }}
          >
            <rect
              x={n.x}
              y={n.y}
              width={n.w}
              height={n.h}
              rx={8}
            />
            <text
              x={n.x + n.w / 2}
              y={n.y + n.h / 2 + 1}
              textAnchor="middle"
              dominantBaseline="middle"
              className="dag-node-label"
            >
              {n.name}
            </text>
            {/* Status dot */}
            {status !== "idle" && (
              <circle
                cx={n.x + n.w - 12}
                cy={n.y + 12}
                r={4}
                className={`dag-status-dot dag-status-dot--${status}`}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
