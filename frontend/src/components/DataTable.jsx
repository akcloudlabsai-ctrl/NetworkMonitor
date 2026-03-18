export default function DataTable({ columns, rows, emptyText = "No data available" }) {
  if (!rows?.length) return <p className="empty-state">{emptyText}</p>;

  return (
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={`${row.pid || row.port || "row"}-${idx}`}>
              {columns.map((column) => (
                <td key={column.key}>{row[column.key] ?? "-"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
