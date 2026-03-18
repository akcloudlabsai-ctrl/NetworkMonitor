export default function StatCard({ title, value, subtitle, healthy = true }) {
  return (
    <article className="stat-card">
      <header>
        <h3>{title}</h3>
        <span className={`chip ${healthy ? "ok" : "warn"}`}>{healthy ? "OK" : "Alert"}</span>
      </header>
      <p className="value">{value}</p>
      {subtitle ? <small>{subtitle}</small> : null}
    </article>
  );
}
