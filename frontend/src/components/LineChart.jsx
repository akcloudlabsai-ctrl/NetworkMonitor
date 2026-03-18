export default function LineChart({ data = [], color = "#4f84ff", yMax = 100, unit = "%" }) {
  const width = 520;
  const height = 160;
  const pad = 18;

  if (!data.length) {
    return <p className="empty-state">No history yet.</p>;
  }

  const points = data.map((item, index) => {
    const x = pad + (index * (width - pad * 2)) / Math.max(1, data.length - 1);
    const y = height - pad - (Math.min(yMax, item.value) / yMax) * (height - pad * 2);
    return { x, y, value: item.value, label: item.label };
  });

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(" ");

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="metric history chart">
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} className="axis" />
        <line x1={pad} y1={pad} x2={pad} y2={height - pad} className="axis" />
        <path d={path} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((point, index) => (
          <circle key={`${point.x}-${index}`} cx={point.x} cy={point.y} r="2.6" fill={color}>
            <title>{`${point.label}: ${point.value}${unit}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
