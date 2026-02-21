import { useState } from "react";
import StepEditor from "./StepEditor";
import DAGRenderer from "./DAGRenderer";

/**
 * Pipeline creation form with step editor and DAG preview.
 *
 * Props:
 *   onSubmit(data) — called with { name, repo_url, steps }
 *   onCancel()     — optional cancel callback
 */
export default function PipelineForm({ onSubmit, onCancel }) {
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [steps, setSteps] = useState([
    { name: "", task: "", depends_on: [], on_failure: "stop" },
  ]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const validSteps = steps.filter((s) => s.name.trim() && s.task.trim());

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (!name.trim()) {
      setError("Pipeline name is required.");
      return;
    }
    if (validSteps.length === 0) {
      setError("At least one step with name and task is required.");
      return;
    }

    // Check for duplicate step names
    const names = validSteps.map((s) => s.name.trim());
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length > 0) {
      setError(`Duplicate step name: "${dupes[0]}"`);
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        repo_url: repoUrl.trim(),
        steps: validSteps.map((s) => ({
          name: s.name.trim(),
          task: s.task.trim(),
          depends_on: s.depends_on || [],
          on_failure: s.on_failure || "stop",
        })),
      });
      // Reset form on success
      setName("");
      setRepoUrl("");
      setSteps([{ name: "", task: "", depends_on: [], on_failure: "stop" }]);
    } catch (err) {
      setError(err.message || "Failed to create pipeline.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="pipeline-form" onSubmit={handleSubmit}>
      <h3 className="form-section-title">Create Pipeline</h3>

      {error && <div className="error-banner">{error}</div>}

      <input
        className="form-input"
        placeholder="Pipeline name (e.g. Full CI)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="form-input"
        placeholder="Default repo URL (optional)"
        value={repoUrl}
        onChange={(e) => setRepoUrl(e.target.value)}
      />

      <h4 className="form-section-subtitle">Steps</h4>
      <StepEditor steps={steps} onChange={setSteps} />

      {/* Mini DAG preview */}
      {validSteps.length > 0 && (
        <div className="dag-preview-section">
          <h4 className="form-section-subtitle">DAG Preview</h4>
          <DAGRenderer steps={validSteps} compact />
        </div>
      )}

      <div className="form-actions">
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="submit-btn" disabled={submitting}>
          {submitting ? "Creating..." : "Create Pipeline"}
        </button>
      </div>
    </form>
  );
}
