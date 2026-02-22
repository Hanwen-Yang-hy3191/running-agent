"""
DAG Scheduler for pipeline execution.

Parses pipeline step definitions into a directed acyclic graph,
resolves template variables from upstream outputs, and validates
pipeline DAG structure.

The actual execution orchestration lives in api.py's run_pipeline_task.
"""

import json
import re
from collections import deque


# ---------------------------------------------------------------------------
# 1. Template variable resolution
# ---------------------------------------------------------------------------

_TEMPLATE_RE = re.compile(r"\{\{\s*steps\.(\w+)\.output\.(\w+)\s*\}\}")


def resolve_templates(text: str, step_outputs: dict[str, dict]) -> str:
    """
    Replace {{steps.<name>.output.<key>}} placeholders with actual values.

    Args:
        text: The template string (e.g. a task description).
        step_outputs: Mapping of step_name -> output dict from completed steps.

    Returns the resolved string. Missing references are left as-is.
    """
    def _replace(match: re.Match) -> str:
        step_name = match.group(1)
        key = match.group(2)
        output = step_outputs.get(step_name, {})
        value = output.get(key)
        if value is None:
            return match.group(0)
        # Use JSON for complex types (dict/list) to ensure proper serialization
        if isinstance(value, (dict, list)):
            return json.dumps(value)
        return str(value)

    return _TEMPLATE_RE.sub(_replace, text)


# ---------------------------------------------------------------------------
# 2. DAG validation and topological sort
# ---------------------------------------------------------------------------

def _build_graph(steps: list[dict]) -> tuple[dict[str, list[str]], dict[str, int]]:
    """
    Build adjacency list and in-degree map from step definitions.

    Each step dict should have:
        name: str
        task: str
        depends_on: list[str]  (optional)

    Returns (adjacency, in_degree) where:
        adjacency[parent] = [children that depend on parent]
        in_degree[name] = number of unresolved dependencies
    """
    names = {s["name"] for s in steps}
    adjacency: dict[str, list[str]] = {s["name"]: [] for s in steps}
    in_degree: dict[str, int] = {s["name"]: 0 for s in steps}

    for step in steps:
        for dep in step.get("depends_on", []):
            if dep not in names:
                raise ValueError(
                    f"Step '{step['name']}' depends on unknown step '{dep}'"
                )
            adjacency[dep].append(step["name"])
            in_degree[step["name"]] += 1

    return adjacency, in_degree


def topological_sort(steps: list[dict]) -> list[list[str]]:
    """
    Return steps grouped into execution layers (Kahn's algorithm).

    Each layer is a list of step names that can run in parallel.
    Steps in layer N+1 depend on at least one step in layer N or earlier.

    Raises ValueError if the graph contains a cycle.
    """
    adjacency, in_degree = _build_graph(steps)

    queue = deque(name for name, deg in in_degree.items() if deg == 0)
    layers: list[list[str]] = []
    visited = 0

    while queue:
        layer = list(queue)
        layers.append(layer)
        next_queue: deque[str] = deque()

        for name in layer:
            visited += 1
            for child in adjacency[name]:
                in_degree[child] -= 1
                if in_degree[child] == 0:
                    next_queue.append(child)

        queue = next_queue

    if visited != len(in_degree):
        raise ValueError("Pipeline contains a cycle — cannot schedule")

    return layers
