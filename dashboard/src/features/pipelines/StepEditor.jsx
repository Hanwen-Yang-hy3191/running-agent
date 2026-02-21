/**
 * Step editor — add, edit, delete pipeline steps with dependency selection.
 *
 * Props:
 *   steps    — array of { name, task, depends_on, on_failure }
 *   onChange — callback(newSteps)
 */
export default function StepEditor({ steps, onChange }) {
  const updateStep = (index, field, value) => {
    const next = steps.map((s, i) =>
      i === index ? { ...s, [field]: value } : s
    );
    onChange(next);
  };

  const addStep = () => {
    onChange([
      ...steps,
      { name: "", task: "", depends_on: [], on_failure: "stop" },
    ]);
  };

  const removeStep = (index) => {
    const removed = steps[index].name;
    const next = steps
      .filter((_, i) => i !== index)
      .map((s) => ({
        ...s,
        depends_on: (s.depends_on || []).filter((d) => d !== removed),
      }));
    onChange(next);
  };

  const toggleDep = (index, depName) => {
    const step = steps[index];
    const deps = step.depends_on || [];
    const next = deps.includes(depName)
      ? deps.filter((d) => d !== depName)
      : [...deps, depName];
    updateStep(index, "depends_on", next);
  };

  return (
    <div className="step-editor">
      {steps.map((step, i) => {
        // Available deps: all other named steps before this one
        const availDeps = steps
          .filter((s, j) => j !== i && s.name.trim())
          .map((s) => s.name);

        return (
          <div key={i} className="step-row">
            <div className="step-row-header">
              <span className="step-row-index">Step {i + 1}</span>
              <button
                type="button"
                className="step-row-delete"
                onClick={() => removeStep(i)}
                title="Remove step"
              >
                ×
              </button>
            </div>

            <div className="step-row-fields">
              <input
                className="form-input"
                placeholder="Step name (e.g. lint)"
                value={step.name}
                onChange={(e) => updateStep(i, "name", e.target.value)}
              />
              <textarea
                className="form-input form-textarea"
                placeholder="Task description"
                value={step.task}
                onChange={(e) => updateStep(i, "task", e.target.value)}
                rows={2}
              />

              {availDeps.length > 0 && (
                <div className="step-deps">
                  <span className="step-deps-label">Depends on:</span>
                  {availDeps.map((dep) => (
                    <label key={dep} className="step-dep-checkbox">
                      <input
                        type="checkbox"
                        checked={(step.depends_on || []).includes(dep)}
                        onChange={() => toggleDep(i, dep)}
                      />
                      {dep}
                    </label>
                  ))}
                </div>
              )}

              <div className="step-failure-row">
                <span className="step-deps-label">On failure:</span>
                <select
                  className="form-input step-select"
                  value={step.on_failure || "stop"}
                  onChange={(e) => updateStep(i, "on_failure", e.target.value)}
                >
                  <option value="stop">Stop pipeline</option>
                  <option value="continue">Continue</option>
                </select>
              </div>
            </div>
          </div>
        );
      })}

      <button type="button" className="step-add-btn" onClick={addStep}>
        + Add Step
      </button>
    </div>
  );
}
