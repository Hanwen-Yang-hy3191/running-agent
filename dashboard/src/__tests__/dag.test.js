import { describe, it, expect } from "vitest";
import { topoLayers, layoutDAG } from "../lib/dag";

describe("topoLayers", () => {
  it("handles a single step with no deps", () => {
    const steps = [{ name: "a", task: "do a" }];
    const layers = topoLayers(steps);
    expect(layers).toEqual([["a"]]);
  });

  it("handles linear chain: a → b → c", () => {
    const steps = [
      { name: "a", task: "do a" },
      { name: "b", task: "do b", depends_on: ["a"] },
      { name: "c", task: "do c", depends_on: ["b"] },
    ];
    const layers = topoLayers(steps);
    expect(layers).toEqual([["a"], ["b"], ["c"]]);
  });

  it("handles parallel steps in same layer", () => {
    const steps = [
      { name: "a", task: "do a" },
      { name: "b", task: "do b", depends_on: ["a"] },
      { name: "c", task: "do c", depends_on: ["a"] },
      { name: "d", task: "do d", depends_on: ["b", "c"] },
    ];
    const layers = topoLayers(steps);
    expect(layers[0]).toEqual(["a"]);
    expect(layers[1].sort()).toEqual(["b", "c"]);
    expect(layers[2]).toEqual(["d"]);
  });

  it("handles multiple root nodes", () => {
    const steps = [
      { name: "a", task: "do a" },
      { name: "b", task: "do b" },
      { name: "c", task: "do c", depends_on: ["a", "b"] },
    ];
    const layers = topoLayers(steps);
    expect(layers[0].sort()).toEqual(["a", "b"]);
    expect(layers[1]).toEqual(["c"]);
  });

  it("returns empty array for no steps", () => {
    expect(topoLayers([])).toEqual([]);
  });

  it("handles steps without depends_on field", () => {
    const steps = [
      { name: "x", task: "do x" },
      { name: "y", task: "do y" },
    ];
    const layers = topoLayers(steps);
    expect(layers[0].sort()).toEqual(["x", "y"]);
  });
});

describe("layoutDAG", () => {
  it("returns empty layout for no steps", () => {
    const result = layoutDAG([]);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });

  it("returns empty layout for null steps", () => {
    const result = layoutDAG(null);
    expect(result.nodes).toEqual([]);
  });

  it("computes correct node count", () => {
    const steps = [
      { name: "a", task: "do a" },
      { name: "b", task: "do b", depends_on: ["a"] },
    ];
    const { nodes } = layoutDAG(steps);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.name).sort()).toEqual(["a", "b"]);
  });

  it("assigns layers correctly", () => {
    const steps = [
      { name: "a", task: "do a" },
      { name: "b", task: "do b", depends_on: ["a"] },
      { name: "c", task: "do c", depends_on: ["a"] },
    ];
    const { nodes } = layoutDAG(steps);
    const a = nodes.find((n) => n.name === "a");
    const b = nodes.find((n) => n.name === "b");
    const c = nodes.find((n) => n.name === "c");
    expect(a.layer).toBe(0);
    expect(b.layer).toBe(1);
    expect(c.layer).toBe(1);
  });

  it("generates edges with SVG path strings", () => {
    const steps = [
      { name: "a", task: "do a" },
      { name: "b", task: "do b", depends_on: ["a"] },
    ];
    const { edges } = layoutDAG(steps);
    expect(edges).toHaveLength(1);
    expect(edges[0].from).toBe("a");
    expect(edges[0].to).toBe("b");
    expect(edges[0].path).toMatch(/^M \d/); // starts with M followed by number
    expect(edges[0].path).toContain("C"); // contains cubic bezier
  });

  it("applies statusMap to nodes", () => {
    const steps = [
      { name: "a", task: "do a" },
      { name: "b", task: "do b", depends_on: ["a"] },
    ];
    const { nodes } = layoutDAG(steps, { a: "completed", b: "running" });
    expect(nodes.find((n) => n.name === "a").status).toBe("completed");
    expect(nodes.find((n) => n.name === "b").status).toBe("running");
  });

  it("defaults status to 'idle' when not in statusMap", () => {
    const steps = [{ name: "a", task: "do a" }];
    const { nodes } = layoutDAG(steps, {});
    expect(nodes[0].status).toBe("idle");
  });

  it("produces positive width and height", () => {
    const steps = [
      { name: "a", task: "do a" },
      { name: "b", task: "do b", depends_on: ["a"] },
    ];
    const { width, height } = layoutDAG(steps);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it("positions nodes left-to-right by layer", () => {
    const steps = [
      { name: "a", task: "do a" },
      { name: "b", task: "do b", depends_on: ["a"] },
      { name: "c", task: "do c", depends_on: ["b"] },
    ];
    const { nodes } = layoutDAG(steps);
    const xs = nodes.sort((a, b) => a.layer - b.layer).map((n) => n.x);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
  });
});
