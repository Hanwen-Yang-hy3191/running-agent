import { Routes, Route, Navigate } from "react-router-dom";
import TopNav from "./components/TopNav";
import JobsPage from "./pages/JobsPage";
import PipelinesPage from "./pages/PipelinesPage";
import PipelineDetail from "./pages/PipelineDetail";
import RunDetail from "./pages/RunDetail";
import "./App.css";

export default function App() {
  return (
    <div className="app-shell">
      <TopNav />
      <div className="app-content">
        <Routes>
          <Route path="/" element={<Navigate to="/jobs" replace />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/pipelines" element={<PipelinesPage />} />
          <Route path="/pipelines/:id" element={<PipelineDetail />} />
          <Route path="/runs/:runId" element={<RunDetail />} />
        </Routes>
      </div>
    </div>
  );
}
