export default function StatusBadge({ healthy, label }) {
  return (
    <span className={`status-badge ${healthy ? "ok" : "warn"}`}>
      <span className="dot" />
      {label}
    </span>
  );
}
