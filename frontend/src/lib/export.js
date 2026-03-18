import { jsPDF } from "jspdf";

function makeCsvRow(values) {
  return values
    .map((value) => {
      const safe = String(value ?? "").replaceAll('"', '""');
      return `"${safe}"`;
    })
    .join(",");
}

export function exportDashboardCsv(data) {
  if (!data) return;

  const lines = [];
  lines.push(makeCsvRow(["Section", "Metric", "Value"]));
  lines.push(makeCsvRow(["System", "Hostname", data.system_info.hostname]));
  lines.push(makeCsvRow(["System", "OS", data.system_info.os]));
  lines.push(makeCsvRow(["CPU", "Usage %", data.system_info.cpu.usage_percent]));
  lines.push(makeCsvRow(["Memory", "Usage %", data.system_info.memory.percent]));
  lines.push(makeCsvRow(["Disk", "Usage %", data.system_info.disk.percent]));
  lines.push(makeCsvRow(["Network", "Internet", data.internet_connectivity.connected ? "Connected" : "Disconnected"]));
  lines.push(makeCsvRow(["Network", "Latency ms", data.internet_connectivity.latency_ms ?? "N/A"]));
  lines.push("");

  lines.push(makeCsvRow(["Ports", "IP", "Port", "PID", "Process"]));
  data.running_ports.items.forEach((item) => {
    lines.push(makeCsvRow(["Port", item.ip, item.port, item.pid, item.process_name]));
  });
  lines.push("");

  lines.push(makeCsvRow(["Processes", "PID", "Name", "User", "Memory GB", "Memory %", "CPU %"]));
  data.top_memory_processes.items.forEach((item) => {
    lines.push(
      makeCsvRow([
        "Process",
        item.pid,
        item.name,
        item.username,
        item.memory_rss_gb,
        item.memory_percent,
        item.cpu_percent,
      ])
    );
  });

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `network-monitor-${new Date().toISOString().replaceAll(":", "-")}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function exportDashboardPdf(data, alerts = []) {
  if (!data) return;

  const doc = new jsPDF();
  let y = 14;
  const addLine = (text, spacing = 7) => {
    doc.text(text, 12, y);
    y += spacing;
  };

  doc.setFontSize(16);
  addLine("Network Monitor Report", 9);
  doc.setFontSize(10);

  addLine(`Generated: ${new Date().toLocaleString()}`);
  addLine(`Hostname: ${data.system_info.hostname}`);
  addLine(`Overall Status: ${data.overall_status.status}`);
  y += 2;

  addLine(`CPU Usage: ${data.system_info.cpu.usage_percent}%`);
  addLine(`RAM Usage: ${data.system_info.memory.percent}%`);
  addLine(`Disk Usage: ${data.system_info.disk.percent}%`);
  addLine(`Internet: ${data.internet_connectivity.connected ? "Connected" : "Disconnected"}`);
  addLine(`Listening Ports: ${data.running_ports.count}`);
  addLine(`Top Memory Processes: ${data.top_memory_processes.count}`);

  y += 2;
  addLine("Active Alerts:");
  if (!alerts.length) {
    addLine("- None");
  } else {
    alerts.forEach((alert) => addLine(`- ${alert}`));
  }

  y += 2;
  addLine("Top Processes:");
  data.top_memory_processes.items.slice(0, 8).forEach((p) => {
    addLine(`- ${p.name} (PID ${p.pid}): ${p.memory_rss_gb} GB`);
  });

  doc.save(`network-monitor-${new Date().toISOString().replaceAll(":", "-")}.pdf`);
}
