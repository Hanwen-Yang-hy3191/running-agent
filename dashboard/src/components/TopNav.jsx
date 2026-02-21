import { NavLink } from "react-router-dom";

const tabs = [
  { to: "/jobs", label: "Jobs" },
  { to: "/pipelines", label: "Pipelines" },
];

export default function TopNav() {
  return (
    <nav className="top-nav">
      <div className="top-nav-brand">
        <span className="logo-dot" />
        Agent Console
      </div>
      <div className="top-nav-tabs">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) =>
              `nav-tab${isActive ? " active" : ""}`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
