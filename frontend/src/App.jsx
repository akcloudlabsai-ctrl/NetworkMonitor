import { Activity, Bell, Boxes, ChevronDown, Cpu, Download, HardDrive, LineChart, MemoryStick, Network, Server, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import DataTable from "./components/DataTable";
import LineHistoryChart from "./components/LineChart";
import StatCard from "./components/StatCard";
import StatusBadge from "./components/StatusBadge";
import { exportDashboardCsv, exportDashboardPdf } from "./lib/export";
import { fetchDashboard, triageIncident } from "./lib/api";

function formatDate(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function formatRate(value) {
  return `${Number(value || 0).toFixed(2)} Mbps`;
}

function latencyLevelClass(value) {
  if (value == null) return "latency-na";
  if (value >= 1000) return "latency-high";
  if (value >= 300) return "latency-medium";
  return "latency-low";
}

function LatencyResourceTable({ title, rows }) {
  const max = Math.max(...rows.map((x) => x.response_time_ms || 0), 1);
  return (
    <article className="latency-card">
      <h3>{title}</h3>
      <div className="latency-table">
        <div className="latency-head">
          <span>Name</span>
          <span>Response Time</span>
        </div>
        {rows.slice(0, 10).map((row) => {
          const percent = row.response_time_ms ? Math.max(4, (row.response_time_ms / max) * 100) : 0;
          return (
            <div key={`${title}-${row.name}-${row.host}`} className="latency-row">
              <span className="latency-name" title={row.host}>{row.name}</span>
              <span className={`latency-value ${latencyLevelClass(row.response_time_ms)}`}>
                <i style={{ width: `${percent}%` }} />
                <b>{row.response_time_ms != null ? `${row.response_time_ms} ms` : "N/A"}</b>
              </span>
            </div>
          );
        })}
      </div>
    </article>
  );
}

const INFRA_MENU_ITEMS = [
  { id: "network-monitoring", label: "Network Monitoring" },
  { id: "server-monitoring", label: "Server Monitoring" },
  { id: "remote-monitoring", label: "Remote Monitoring" },
  { id: "vm-monitoring", label: "VM Monitoring" },
  { id: "sdwan-monitoring", label: "SD-WAN Monitoring" },
  { id: "database-monitoring", label: "Database Monitoring" },
  { id: "configuration-monitoring", label: "Configuration Monitoring" },
  { id: "storage-monitoring", label: "Storage Monitoring" },
  { id: "ai-incident-agent", label: "AI Incident Agent" },
];

export default function App() {
  const [activeMenu, setActiveMenu] = useState("network-monitoring");
  const [infraExpanded, setInfraExpanded] = useState(false);
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [throughputHistory, setThroughputHistory] = useState([]);
  const [interfaceRates, setInterfaceRates] = useState([]);
  const [thresholds, setThresholds] = useState({ cpu: 90, memory: 85, disk: 90 });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [incidentInput, setIncidentInput] = useState("");
  const [incidentService, setIncidentService] = useState("Payments API");
  const [incidentImpact, setIncidentImpact] = useState("customer-facing");
  const [incidentUrgency, setIncidentUrgency] = useState("high");
  const [aiResult, setAiResult] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const previousInterfaceSnapshotRef = useRef(null);

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const response = await fetchDashboard();
      setData(response);
      const now = Date.now();
      const stamp = new Date(now);
      const label = `${String(stamp.getHours()).padStart(2, "0")}:${String(stamp.getMinutes()).padStart(2, "0")}:${String(stamp.getSeconds()).padStart(2, "0")}`;

      const currentInterfaces = (response.network_interfaces?.items || []).map((item) => ({
        name: item.name,
        bytes_recv: item.bytes_recv,
        bytes_sent: item.bytes_sent,
      }));

      const prev = previousInterfaceSnapshotRef.current;
      if (prev) {
        const elapsedSec = Math.max((now - prev.timestamp) / 1000, 1);
        const prevMap = new Map(prev.items.map((i) => [i.name, i]));
        const rates = currentInterfaces.map((item) => {
          const old = prevMap.get(item.name);
          const rxBytesDelta = Math.max((item.bytes_recv || 0) - (old?.bytes_recv || 0), 0);
          const txBytesDelta = Math.max((item.bytes_sent || 0) - (old?.bytes_sent || 0), 0);
          const rxMbps = (rxBytesDelta * 8) / (elapsedSec * 1_000_000);
          const txMbps = (txBytesDelta * 8) / (elapsedSec * 1_000_000);
          return {
            name: item.name,
            rx_mbps: Number(rxMbps.toFixed(2)),
            tx_mbps: Number(txMbps.toFixed(2)),
            total_mbps: Number((rxMbps + txMbps).toFixed(2)),
          };
        }).sort((a, b) => b.total_mbps - a.total_mbps);

        setInterfaceRates(rates);

        const totalRx = rates.reduce((sum, x) => sum + x.rx_mbps, 0);
        const totalTx = rates.reduce((sum, x) => sum + x.tx_mbps, 0);
        setThroughputHistory((prevHistory) => {
          const next = [...prevHistory, { label, rx: Number(totalRx.toFixed(2)), tx: Number(totalTx.toFixed(2)) }];
          return next.slice(-30);
        });
      }

      previousInterfaceSnapshotRef.current = {
        timestamp: now,
        items: currentInterfaces,
      };

      setHistory((prev) => {
        const next = [
          ...prev,
          {
            label,
            cpu: response.system_info.cpu.usage_percent,
            memory: response.system_info.memory.percent,
            disk: response.system_info.disk.percent,
          },
        ];
        return next.slice(-30);
      });
    } catch {
      setError("Unable to load dashboard. Make sure FastAPI server is running on port 8000.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    const timer = setInterval(loadData, 15000);
    return () => clearInterval(timer);
  }, []);

  const cards = useMemo(() => {
    if (!data) return [];
    return [
      {
        icon: <Cpu size={18} />,
        title: "CPU Usage",
        value: `${data.system_info.cpu.usage_percent}%`,
        subtitle: `${data.system_info.cpu.physical_cores} physical / ${data.system_info.cpu.logical_cores} logical cores`,
        healthy: data.overall_status.checks.cpu,
      },
      {
        icon: <MemoryStick size={18} />,
        title: "RAM Usage",
        value: `${data.system_info.memory.percent}%`,
        subtitle: `${data.system_info.memory.used_gb} GB / ${data.system_info.memory.total_gb} GB`,
        healthy: data.overall_status.checks.memory,
      },
      {
        icon: <HardDrive size={18} />,
        title: "Disk Usage",
        value: `${data.system_info.disk.percent}%`,
        subtitle: `${data.system_info.disk.used_gb} GB / ${data.system_info.disk.total_gb} GB`,
        healthy: data.overall_status.checks.disk,
      },
      {
        icon: <Network size={18} />,
        title: "Internet",
        value: data.internet_connectivity.connected ? "Connected" : "Disconnected",
        subtitle: data.internet_connectivity.latency_ms
          ? `Latency ${data.internet_connectivity.latency_ms} ms`
          : "No latency info",
        healthy: data.overall_status.checks.internet,
      },
      {
        icon: <Server size={18} />,
        title: "Virtualization",
        value: data.virtualization?.host_role || "Unknown",
        subtitle: `${data.virtualization?.virt_type || "N/A"} • VM procs ${data.virtualization?.running_vm_process_count ?? 0}`,
        healthy: true,
      },
      {
        icon: <Boxes size={18} />,
        title: "Kubernetes",
        value: data.kubernetes?.connected ? "Connected" : "Not Connected",
        subtitle: `Nodes ${data.kubernetes?.nodes?.ready ?? 0}/${data.kubernetes?.nodes?.count ?? 0} • Pods ${data.kubernetes?.pods?.running ?? 0}`,
        healthy: !!data.kubernetes?.connected,
      },
      {
        icon: <ShieldCheck size={18} />,
        title: "TLS Certificates",
        value: `${data.tls_certificates?.summary?.reachable ?? 0}/${data.tls_certificates?.summary?.count ?? 0} reachable`,
        subtitle: `Expiring soon ${data.tls_certificates?.summary?.expiring_soon ?? 0} • Expired ${data.tls_certificates?.summary?.expired ?? 0}`,
        healthy: (data.tls_certificates?.summary?.expiring_soon ?? 0) === 0 && (data.tls_certificates?.summary?.expired ?? 0) === 0,
      },
      {
        icon: <HardDrive size={18} />,
        title: "Datastores",
        value: `${data.datastores?.summary?.count ?? 0} mounts`,
        subtitle: `High usage ${data.datastores?.summary?.high_usage ?? 0} • Critical ${data.datastores?.summary?.critical_usage ?? 0}`,
        healthy: (data.datastores?.summary?.critical_usage ?? 0) === 0,
      },
    ];
  }, [data]);

  const activeAlerts = useMemo(() => {
    if (!data) return [];
    const alerts = [...(data.alerting?.alerts || [])];

    if (data.system_info.cpu.usage_percent >= thresholds.cpu) {
      alerts.push(`High CPU: ${data.system_info.cpu.usage_percent}% (threshold ${thresholds.cpu}%)`);
    }
    if (data.system_info.memory.percent >= thresholds.memory) {
      alerts.push(`High RAM: ${data.system_info.memory.percent}% (threshold ${thresholds.memory}%)`);
    }
    if (data.system_info.disk.percent >= thresholds.disk) {
      alerts.push(`High Disk: ${data.system_info.disk.percent}% (threshold ${thresholds.disk}%)`);
    }
    if (!data.internet_connectivity.connected) {
      alerts.push("Internet connectivity lost.");
    }
    if (!data.dns.healthy) {
      alerts.push("DNS resolution failing for one or more domains.");
    }
    if ((data.services?.summary?.failed ?? 0) > 0) {
      alerts.push(`Failed services detected: ${data.services.summary.failed}`);
    }
    if ((data.network_interfaces?.summary?.total_errors ?? 0) > 0) {
      alerts.push(`Network interface errors detected: ${data.network_interfaces.summary.total_errors}`);
    }
    if ((data.network_interfaces?.summary?.total_drops ?? 0) > 0) {
      alerts.push(`Network packet drops detected: ${data.network_interfaces.summary.total_drops}`);
    }
    if ((data.tls_certificates?.summary?.expired ?? 0) > 0) {
      alerts.push(`Expired TLS certificates detected: ${data.tls_certificates.summary.expired}`);
    }
    if ((data.tls_certificates?.summary?.expiring_soon ?? 0) > 0) {
      alerts.push(`TLS certificates expiring soon: ${data.tls_certificates.summary.expiring_soon}`);
    }
    if ((data.datastores?.summary?.critical_usage ?? 0) > 0) {
      alerts.push(`Critical datastore usage detected: ${data.datastores.summary.critical_usage}`);
    }

    return [...new Set(alerts)];
  }, [data, thresholds]);

  const historyCpu = history.map((item) => ({ label: item.label, value: item.cpu }));
  const historyRam = history.map((item) => ({ label: item.label, value: item.memory }));
  const historyDisk = history.map((item) => ({ label: item.label, value: item.disk }));
  const historyRx = throughputHistory.map((item) => ({ label: item.label, value: item.rx }));
  const historyTx = throughputHistory.map((item) => ({ label: item.label, value: item.tx }));

  const remotePorts = useMemo(() => {
    const remotePortSet = new Set([22, 3389, 5900, 5901, 443, 8443]);
    return (data?.running_ports?.items || []).filter((item) => remotePortSet.has(Number(item.port)));
  }, [data]);

  const databaseServices = useMemo(() => {
    const dbTokens = ["postgres", "mysql", "redis", "mongo", "mariadb", "oracle", "etcd"];
    return (data?.services?.critical || []).filter((item) => dbTokens.some((token) => item.service?.toLowerCase().includes(token)));
  }, [data]);

  const databaseProcesses = useMemo(() => {
    const dbTokens = ["postgres", "mysql", "redis", "mongod", "mariadb", "oracle", "sql"];
    return (data?.top_memory_processes?.items || []).filter((item) => dbTokens.some((token) => item.name?.toLowerCase().includes(token)));
  }, [data]);

  const storageAlerts = useMemo(
    () => activeAlerts.filter((item) => /disk|datastore|storage/i.test(item)),
    [activeAlerts]
  );

  const handleThresholdChange = (key, value) => {
    setThresholds((prev) => ({ ...prev, [key]: Number(value) }));
  };

  async function handleAiTriage() {
    if (!incidentInput.trim()) {
      setAiError("Enter incident summary to analyze.");
      return;
    }
    setAiError("");
    setAiLoading(true);
    try {
      const result = await triageIncident({
        summary: incidentInput,
        service: incidentService,
        impact: incidentImpact,
        urgency: incidentUrgency,
      });
      setAiResult(result);
    } catch {
      setAiError("AI triage failed. Check backend and try again.");
    } finally {
      setAiLoading(false);
    }
  }

  return (
    <div className="app-layout">
      <aside className="side-menu">
        <div className="menu-brand">KNM</div>
        <h2>Menu</h2>
        <div className="menu-group">
          <button className="menu-parent" type="button" onClick={() => setInfraExpanded((prev) => !prev)}>
            <span>Infrastructure</span>
            <ChevronDown size={14} className={`menu-chevron ${infraExpanded ? "open" : ""}`} />
          </button>
          {infraExpanded ? (
            INFRA_MENU_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`menu-item ${activeMenu === item.id ? "active" : ""}`}
                onClick={() => setActiveMenu(item.id)}
              >
                {item.label}
              </button>
            ))
          ) : null}
        </div>
      </aside>

      <main className="container">
      {!infraExpanded ? (
        <section className="blank-screen" />
      ) : activeMenu === "network-monitoring" ? (
      <>
      <section className="hero">
        <div>
          <h1><span className="k-brand">K</span> - Network Monitor</h1>
          <p>Infrastructure / Network Monitoring</p>
        </div>
        <div className="hero-actions">
          <StatusBadge healthy={data?.overall_status?.healthy} label={data?.overall_status?.status || "Loading"} />
          <button className="secondary" onClick={() => exportDashboardCsv(data)} disabled={!data}><Download size={14} /> CSV</button>
          <button className="secondary" onClick={() => exportDashboardPdf(data, activeAlerts)} disabled={!data}><Download size={14} /> PDF</button>
          <button onClick={loadData} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button>
        </div>
      </section>

      {error ? <p className="error-box">{error}</p> : null}

      <section className="grid-cards">
        {cards.map((card) => (
          <div key={card.title} className="card-with-icon">
            <span className="card-icon">{card.icon}</span>
            <StatCard {...card} />
          </div>
        ))}
      </section>

      {data?.resource_latency ? (
        <section className="latency-grid">
          <LatencyResourceTable title="Top Resources by HTTP Latency" rows={data.resource_latency.http || []} />
          <LatencyResourceTable title="Top Resources by HTTPS Latency" rows={data.resource_latency.https || []} />
          <LatencyResourceTable title="Top Resources by ICMP Ping Latency" rows={data.resource_latency.icmp || []} />
        </section>
      ) : null}

      {data ? (
        <section className="panel two-col">
          <article>
            <h2><Bell size={16} /> Alert Notifications</h2>
            <p className="muted">Set custom thresholds and get immediate health alerts.</p>
            <p className="muted">
              Email: {data?.alerting?.email_enabled ? "Enabled" : "Disabled"}
              {data?.alerting?.email?.reason ? ` • Last status: ${data.alerting.email.reason}` : ""}
            </p>
            <div className="threshold-grid">
              <label>
                CPU %
                <input type="number" min="1" max="100" value={thresholds.cpu} onChange={(e) => handleThresholdChange("cpu", e.target.value)} />
              </label>
              <label>
                RAM %
                <input type="number" min="1" max="100" value={thresholds.memory} onChange={(e) => handleThresholdChange("memory", e.target.value)} />
              </label>
              <label>
                Disk %
                <input type="number" min="1" max="100" value={thresholds.disk} onChange={(e) => handleThresholdChange("disk", e.target.value)} />
              </label>
            </div>
            <div className="alert-list">
              {!activeAlerts.length ? (
                <p className="ok-note">No active alerts. System looks stable.</p>
              ) : (
                activeAlerts.map((alert, index) => (
                  <p key={`${alert}-${index}`} className="warn-note">{alert}</p>
                ))
              )}
            </div>
          </article>
          <article>
            <h2><LineChart size={16} /> Historical Charts</h2>
            <p className="muted">Last {history.length} samples (15s interval).</p>
            <div className="chart-block">
              <h4>CPU Usage %</h4>
              <LineHistoryChart data={historyCpu} color="#79a1ff" />
            </div>
            <div className="chart-block">
              <h4>RAM Usage %</h4>
              <LineHistoryChart data={historyRam} color="#45d2a2" />
            </div>
            <div className="chart-block">
              <h4>Disk Usage %</h4>
              <LineHistoryChart data={historyDisk} color="#ffb369" />
            </div>
          </article>
        </section>
      ) : null}

      {data ? (
        <>
          <section className="panel two-col">
            <article>
              <h2>System Information</h2>
              <ul className="meta-list">
                <li><b>Hostname:</b> {data.system_info.hostname}</li>
                <li><b>OS:</b> {data.system_info.os}</li>
                <li><b>Kernel:</b> {data.system_info.kernel}</li>
                <li><b>Architecture:</b> {data.system_info.architecture}</li>
                <li><b>Python:</b> {data.system_info.python_version}</li>
                <li><b>Boot Time:</b> {formatDate(data.system_info.boot_time)}</li>
                <li><b>Checked:</b> {formatDate(data.system_info.timestamp)}</li>
              </ul>
            </article>
            <article>
              <h2>DNS Health</h2>
              <div className="dns-list">
                {data.dns.results.map((item) => (
                  <div key={item.domain} className="dns-item">
                    <div>
                      <strong>{item.domain}</strong>
                      <p>{item.resolved ? `Resolved in ${item.latency_ms} ms` : "Failed to resolve"}</p>
                    </div>
                    <StatusBadge healthy={item.resolved} label={item.resolved ? "Resolved" : "Failed"} />
                  </div>
                ))}
              </div>
            </article>
          </section>

          <section className="panel">
            <h2>Ports Running ({data.running_ports.count})</h2>
            <DataTable
              columns={[
                { key: "ip", label: "IP" },
                { key: "port", label: "Port" },
                { key: "pid", label: "PID" },
                { key: "process_name", label: "Process" },
              ]}
              rows={data.running_ports.items}
              emptyText="No listening ports found."
            />
          </section>

          <section className="panel">
            <h2>Servers Running ({data.running_servers?.count || 0})</h2>
            <DataTable
              columns={[
                { key: "name", label: "Server Process" },
                { key: "pid", label: "PID" },
                { key: "port_count", label: "Ports" },
                { key: "ports_joined", label: "Port List" },
                { key: "bind_ips_joined", label: "Bind IPs" },
              ]}
              rows={(data.running_servers?.items || []).map((item) => ({
                ...item,
                ports_joined: (item.ports || []).join(", "),
                bind_ips_joined: (item.bind_ips || []).join(", "),
              }))}
              emptyText="No server processes with listening ports found."
            />
          </section>

          <section className="panel two-col">
            <article>
              <h2>Network Interfaces ({data.network_interfaces?.count || 0})</h2>
              <DataTable
                columns={[
                  { key: "name", label: "Interface" },
                  { key: "status", label: "Status" },
                  { key: "speed", label: "Speed (Mbps)" },
                  { key: "ipv4", label: "IPv4" },
                  { key: "errors", label: "Errors In/Out" },
                  { key: "drops", label: "Drops In/Out" },
                ]}
                rows={(data.network_interfaces?.items || []).map((item) => ({
                  name: item.name,
                  status: item.is_up ? "Up" : "Down",
                  speed: item.speed_mbps,
                  ipv4: (item.ipv4 || []).join(", ") || "-",
                  errors: `${item.errors_in}/${item.errors_out}`,
                  drops: `${item.drops_in}/${item.drops_out}`,
                }))}
                emptyText="No interfaces found."
              />
            </article>
            <article>
              <h2>Live Throughput</h2>
              <p className="muted">Per-interface Mbps estimated between refresh intervals.</p>
              <div className="chart-block">
                <h4>Total Ingress (Mbps)</h4>
                <LineHistoryChart data={historyRx} color="#72c7ff" yMax={Math.max(100, ...historyRx.map((x) => x.value), 100)} unit=" Mbps" />
              </div>
              <div className="chart-block">
                <h4>Total Egress (Mbps)</h4>
                <LineHistoryChart data={historyTx} color="#f59dff" yMax={Math.max(100, ...historyTx.map((x) => x.value), 100)} unit=" Mbps" />
              </div>
              <DataTable
                columns={[
                  { key: "name", label: "Interface" },
                  { key: "rx_label", label: "Ingress" },
                  { key: "tx_label", label: "Egress" },
                  { key: "total_label", label: "Total" },
                ]}
                rows={interfaceRates.map((item) => ({
                  ...item,
                  rx_label: formatRate(item.rx_mbps),
                  tx_label: formatRate(item.tx_mbps),
                  total_label: formatRate(item.total_mbps),
                }))}
                emptyText="Need two samples to estimate throughput."
              />
            </article>
          </section>

          <section className="panel two-col">
            <article>
              <h2>Critical Services</h2>
              <p className="muted">Active {data.services?.summary?.active ?? 0} • Failed {data.services?.summary?.failed ?? 0}</p>
              <DataTable
                columns={[
                  { key: "service", label: "Service" },
                  { key: "unit", label: "Unit" },
                  { key: "active", label: "Active" },
                  { key: "sub", label: "Sub" },
                  { key: "health", label: "Healthy" },
                ]}
                rows={(data.services?.critical || []).map((item) => ({
                  ...item,
                  health: item.healthy ? "Yes" : "No",
                }))}
                emptyText="No tracked critical services found on this host."
              />
            </article>
            <article>
              <h2>TLS Certificate Expiry</h2>
              <DataTable
                columns={[
                  { key: "host", label: "Host" },
                  { key: "port", label: "Port" },
                  { key: "reachable_label", label: "Reachable" },
                  { key: "days_left_label", label: "Days Left" },
                  { key: "expires_label", label: "Expires At" },
                ]}
                rows={(data.tls_certificates?.items || []).map((item) => ({
                  ...item,
                  reachable_label: item.reachable ? "Yes" : "No",
                  days_left_label: item.days_left ?? "N/A",
                  expires_label: item.expires_at ? formatDate(item.expires_at) : "N/A",
                }))}
                emptyText="No certificate targets configured."
              />
            </article>
          </section>

          <section className="panel">
            <h2>Datastore Capacity</h2>
            <DataTable
              columns={[
                { key: "device", label: "Device" },
                { key: "mountpoint", label: "Mount" },
                { key: "fstype", label: "FS" },
                { key: "used_label", label: "Used / Total" },
                { key: "percent_label", label: "Usage %" },
                { key: "healthy_label", label: "Healthy" },
              ]}
              rows={(data.datastores?.items || []).map((item) => ({
                ...item,
                used_label: `${item.used_gb} GB / ${item.total_gb} GB`,
                percent_label: `${item.percent}%`,
                healthy_label: item.healthy ? "Yes" : "No",
              }))}
              emptyText="No datastore information available."
            />
          </section>

          <section className="panel">
            <h2>Kubernetes System</h2>
            <div className="kube-summary">
              <StatusBadge healthy={data.kubernetes?.installed} label={data.kubernetes?.installed ? "kubectl Installed" : "kubectl Missing"} />
              <StatusBadge healthy={data.kubernetes?.connected} label={data.kubernetes?.connected ? "Cluster Connected" : "Cluster Not Connected"} />
            </div>
            <ul className="meta-list">
              <li><b>Context:</b> {data.kubernetes?.context || "N/A"}</li>
              <li><b>Message:</b> {data.kubernetes?.message || "N/A"}</li>
              <li><b>Nodes Ready:</b> {data.kubernetes?.nodes?.ready ?? 0} / {data.kubernetes?.nodes?.count ?? 0}</li>
              <li><b>Pods Running:</b> {data.kubernetes?.pods?.running ?? 0} / {data.kubernetes?.pods?.count ?? 0}</li>
              <li><b>Namespaces:</b> {data.kubernetes?.pods?.namespaces ?? 0}</li>
            </ul>

            <DataTable
              columns={[
                { key: "name", label: "Node" },
                { key: "ready_label", label: "Ready" },
                { key: "roles_label", label: "Roles" },
                { key: "kubelet_version", label: "Kubelet" },
              ]}
              rows={(data.kubernetes?.nodes?.items || []).map((node) => ({
                ...node,
                ready_label: node.ready ? "Yes" : "No",
                roles_label: (node.roles || []).join(", "),
              }))}
              emptyText="No Kubernetes node data available."
            />
          </section>

          <section className="panel">
            <h2>Top Processes by Memory ({data.top_memory_processes.count})</h2>
            <DataTable
              columns={[
                { key: "pid", label: "PID" },
                { key: "name", label: "Process" },
                { key: "username", label: "User" },
                { key: "memory_rss_gb", label: "Memory (GB)" },
                { key: "memory_percent", label: "Memory %" },
                { key: "cpu_percent", label: "CPU %" },
              ]}
              rows={data.top_memory_processes.items}
              emptyText="No process data available."
            />
          </section>
        </>
      ) : null}

      <footer>
        <Activity size={14} />
        <span>Auto-refresh every 15 seconds</span>
      </footer>
      </>
      ) : activeMenu === "ai-incident-agent" ? (
        <>
          <section className="hero">
            <div>
              <h1><span className="k-brand">K</span> - AI Incident Agent</h1>
              <p>Fast incident triage for financial services IT operations.</p>
            </div>
          </section>

          <section className="panel two-col">
            <article>
              <h2>Incident Input</h2>
              <div className="ai-form">
                <label>
                  Summary
                  <textarea
                    value={incidentInput}
                    onChange={(e) => setIncidentInput(e.target.value)}
                    placeholder="Example: Payment authorization API latency spikes across production region..."
                    rows={7}
                  />
                </label>
                <label>
                  Service
                  <input value={incidentService} onChange={(e) => setIncidentService(e.target.value)} />
                </label>
                <label>
                  Impact
                  <select value={incidentImpact} onChange={(e) => setIncidentImpact(e.target.value)}>
                    <option value="customer-facing">Customer-facing</option>
                    <option value="production">Production</option>
                    <option value="internal">Internal</option>
                    <option value="all users">All users</option>
                  </select>
                </label>
                <label>
                  Urgency
                  <select value={incidentUrgency} onChange={(e) => setIncidentUrgency(e.target.value)}>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </label>
                <button onClick={handleAiTriage} disabled={aiLoading}>{aiLoading ? "Analyzing..." : "Run AI Triage"}</button>
                {aiError ? <p className="error-box">{aiError}</p> : null}
              </div>
            </article>

            <article>
              <h2>AI Output</h2>
              {!aiResult ? (
                <p className="muted">Submit an incident to receive severity, causes, runbook and escalation guidance.</p>
              ) : (
                <div className="ai-output">
                  <p><b>Severity:</b> {aiResult.severity} (score {aiResult.score})</p>
                  <p><b>Service:</b> {aiResult.context?.service || "N/A"}</p>
                  <p><b>Impact:</b> {aiResult.context?.impact || "N/A"}</p>
                  <h4>Probable Causes</h4>
                  <ul className="meta-list">
                    {(aiResult.probable_causes || []).map((item, idx) => <li key={`cause-${idx}`}>{item}</li>)}
                  </ul>
                  <h4>Recommended Runbook</h4>
                  <ul className="meta-list">
                    {(aiResult.recommended_runbook || []).map((item, idx) => <li key={`runbook-${idx}`}>{item}</li>)}
                  </ul>
                  <h4>Compliance Actions</h4>
                  <ul className="meta-list">
                    {(aiResult.compliance_actions || []).map((item, idx) => <li key={`cmp-${idx}`}>{item}</li>)}
                  </ul>
                </div>
              )}
            </article>
          </section>
        </>
      ) : activeMenu === "server-monitoring" ? (
        <>
          <section className="hero">
            <div>
              <h1><span className="k-brand">K</span> - Server Monitoring</h1>
              <p>Service health, process load, and server exposure visibility.</p>
            </div>
            <div className="hero-actions">
              <StatusBadge healthy={data?.overall_status?.healthy} label={data?.overall_status?.status || "Loading"} />
              <button onClick={loadData} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button>
            </div>
          </section>

          {data ? (
            <>
              <section className="grid-cards">
                <div className="card-with-icon"><span className="card-icon"><Cpu size={18} /></span><StatCard title="CPU Usage" value={`${data.system_info.cpu.usage_percent}%`} subtitle={`Load ${data.system_info.cpu.load_avg?.join(" / ") || "N/A"}`} healthy={data.system_info.cpu.usage_percent < thresholds.cpu} /></div>
                <div className="card-with-icon"><span className="card-icon"><MemoryStick size={18} /></span><StatCard title="RAM Usage" value={`${data.system_info.memory.percent}%`} subtitle={`${data.system_info.memory.used_gb} GB / ${data.system_info.memory.total_gb} GB`} healthy={data.system_info.memory.percent < thresholds.memory} /></div>
                <div className="card-with-icon"><span className="card-icon"><Server size={18} /></span><StatCard title="Critical Services" value={`${data.services?.summary?.active ?? 0} active`} subtitle={`${data.services?.summary?.failed ?? 0} failed`} healthy={(data.services?.summary?.failed ?? 0) === 0} /></div>
              </section>

              <section className="panel two-col">
                <article>
                  <h2>Servers Running ({data.running_servers?.count || 0})</h2>
                  <DataTable
                    columns={[
                      { key: "name", label: "Server Process" },
                      { key: "pid", label: "PID" },
                      { key: "port_count", label: "Ports" },
                      { key: "ports_joined", label: "Port List" },
                    ]}
                    rows={(data.running_servers?.items || []).map((item) => ({
                      ...item,
                      ports_joined: (item.ports || []).join(", "),
                    }))}
                    emptyText="No server processes with listening ports found."
                  />
                </article>
                <article>
                  <h2>Critical Services</h2>
                  <DataTable
                    columns={[
                      { key: "service", label: "Service" },
                      { key: "unit", label: "Unit" },
                      { key: "active", label: "Active" },
                      { key: "sub", label: "Sub" },
                      { key: "health", label: "Healthy" },
                    ]}
                    rows={(data.services?.critical || []).map((item) => ({ ...item, health: item.healthy ? "Yes" : "No" }))}
                    emptyText="No tracked critical services found on this host."
                  />
                </article>
              </section>

              <section className="panel">
                <h2>Top Processes by Memory ({data.top_memory_processes.count})</h2>
                <DataTable
                  columns={[
                    { key: "pid", label: "PID" },
                    { key: "name", label: "Process" },
                    { key: "username", label: "User" },
                    { key: "memory_rss_gb", label: "Memory (GB)" },
                    { key: "memory_percent", label: "Memory %" },
                    { key: "cpu_percent", label: "CPU %" },
                  ]}
                  rows={data.top_memory_processes.items}
                  emptyText="No process data available."
                />
              </section>
            </>
          ) : null}
        </>
      ) : activeMenu === "remote-monitoring" ? (
        <>
          <section className="hero">
            <div>
              <h1><span className="k-brand">K</span> - Remote Monitoring</h1>
              <p>Reachability, remote access paths, and external dependency health.</p>
            </div>
            <div className="hero-actions">
              <StatusBadge healthy={data?.internet_connectivity?.connected} label={data?.internet_connectivity?.connected ? "Internet Up" : "Internet Down"} />
              <button onClick={loadData} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button>
            </div>
          </section>

          {data ? (
            <>
              <section className="panel two-col">
                <article>
                  <h2>Remote Reachability</h2>
                  <ul className="meta-list">
                    <li><b>Internet:</b> {data.internet_connectivity.connected ? "Connected" : "Disconnected"}</li>
                    <li><b>Latency:</b> {data.internet_connectivity.latency_ms ? `${data.internet_connectivity.latency_ms} ms` : "N/A"}</li>
                    <li><b>DNS Healthy:</b> {data.dns.healthy ? "Yes" : "No"}</li>
                    <li><b>TLS Reachable:</b> {data.tls_certificates?.summary?.reachable ?? 0} / {data.tls_certificates?.summary?.count ?? 0}</li>
                  </ul>
                  <div className="dns-list">
                    {data.dns.results.map((item) => (
                      <div key={item.domain} className="dns-item">
                        <div>
                          <strong>{item.domain}</strong>
                          <p>{item.resolved ? `Resolved in ${item.latency_ms} ms` : "Failed to resolve"}</p>
                        </div>
                        <StatusBadge healthy={item.resolved} label={item.resolved ? "Resolved" : "Failed"} />
                      </div>
                    ))}
                  </div>
                </article>
                <article>
                  <h2>Remote Access Surface ({remotePorts.length})</h2>
                  <DataTable
                    columns={[
                      { key: "ip", label: "Bind IP" },
                      { key: "port", label: "Port" },
                      { key: "pid", label: "PID" },
                      { key: "process_name", label: "Process" },
                    ]}
                    rows={remotePorts}
                    emptyText="No common remote-access ports currently listening."
                  />
                </article>
              </section>

              <section className="latency-grid">
                <LatencyResourceTable title="HTTP Endpoint Latency" rows={data.resource_latency.http || []} />
                <LatencyResourceTable title="HTTPS Endpoint Latency" rows={data.resource_latency.https || []} />
                <LatencyResourceTable title="ICMP Endpoint Latency" rows={data.resource_latency.icmp || []} />
              </section>
            </>
          ) : null}
        </>
      ) : activeMenu === "vm-monitoring" ? (
        <>
          <section className="hero">
            <div>
              <h1><span className="k-brand">K</span> - VM Monitoring</h1>
              <p>Virtualization inventory and orchestration runtime posture.</p>
            </div>
            <div className="hero-actions">
              <StatusBadge healthy={data?.virtualization?.host_role !== "unknown"} label={data?.virtualization?.host_role || "Unknown"} />
              <button onClick={loadData} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button>
            </div>
          </section>

          {data ? (
            <>
              <section className="panel two-col">
                <article>
                  <h2>Virtualization Host</h2>
                  <ul className="meta-list">
                    <li><b>Host Role:</b> {data.virtualization?.host_role || "N/A"}</li>
                    <li><b>Virtualization Type:</b> {data.virtualization?.virt_type || "N/A"}</li>
                    <li><b>VM Processes:</b> {data.virtualization?.running_vm_process_count ?? 0}</li>
                  </ul>
                  <DataTable
                    columns={[
                      { key: "pid", label: "PID" },
                      { key: "name", label: "Process" },
                      { key: "memory_percent", label: "Memory %" },
                    ]}
                    rows={data.virtualization?.top_vm_processes || []}
                    emptyText="No virtualization processes detected."
                  />
                </article>
                <article>
                  <h2>Kubernetes Runtime</h2>
                  <div className="kube-summary">
                    <StatusBadge healthy={data.kubernetes?.installed} label={data.kubernetes?.installed ? "kubectl Installed" : "kubectl Missing"} />
                    <StatusBadge healthy={data.kubernetes?.connected} label={data.kubernetes?.connected ? "Cluster Connected" : "Cluster Not Connected"} />
                  </div>
                  <ul className="meta-list">
                    <li><b>Context:</b> {data.kubernetes?.context || "N/A"}</li>
                    <li><b>Nodes Ready:</b> {data.kubernetes?.nodes?.ready ?? 0} / {data.kubernetes?.nodes?.count ?? 0}</li>
                    <li><b>Pods Running:</b> {data.kubernetes?.pods?.running ?? 0} / {data.kubernetes?.pods?.count ?? 0}</li>
                  </ul>
                  <DataTable
                    columns={[
                      { key: "name", label: "Node" },
                      { key: "ready_label", label: "Ready" },
                      { key: "roles_label", label: "Roles" },
                      { key: "kubelet_version", label: "Kubelet" },
                    ]}
                    rows={(data.kubernetes?.nodes?.items || []).map((node) => ({
                      ...node,
                      ready_label: node.ready ? "Yes" : "No",
                      roles_label: (node.roles || []).join(", "),
                    }))}
                    emptyText="No Kubernetes node data available."
                  />
                </article>
              </section>
            </>
          ) : null}
        </>
      ) : activeMenu === "sdwan-monitoring" ? (
        <>
          <section className="hero">
            <div>
              <h1><span className="k-brand">K</span> - SD-WAN Monitoring</h1>
              <p>Link quality and WAN edge health using interface and latency telemetry.</p>
            </div>
            <div className="hero-actions">
              <StatusBadge
                healthy={(data?.network_interfaces?.summary?.total_drops ?? 0) === 0 && (data?.network_interfaces?.summary?.total_errors ?? 0) === 0}
                label="WAN Fabric"
              />
              <button onClick={loadData} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button>
            </div>
          </section>

          {data ? (
            <>
              <section className="panel two-col">
                <article>
                  <h2>WAN Summary</h2>
                  <ul className="meta-list">
                    <li><b>Internet:</b> {data.internet_connectivity.connected ? "Connected" : "Disconnected"}</li>
                    <li><b>Interfaces Up:</b> {data.network_interfaces?.summary?.up ?? 0} / {data.network_interfaces?.count ?? 0}</li>
                    <li><b>Total Errors:</b> {data.network_interfaces?.summary?.total_errors ?? 0}</li>
                    <li><b>Total Drops:</b> {data.network_interfaces?.summary?.total_drops ?? 0}</li>
                  </ul>
                  <DataTable
                    columns={[
                      { key: "name", label: "Interface" },
                      { key: "status", label: "Status" },
                      { key: "speed", label: "Speed (Mbps)" },
                      { key: "errors", label: "Errors In/Out" },
                      { key: "drops", label: "Drops In/Out" },
                    ]}
                    rows={(data.network_interfaces?.items || []).map((item) => ({
                      name: item.name,
                      status: item.is_up ? "Up" : "Down",
                      speed: item.speed_mbps,
                      errors: `${item.errors_in}/${item.errors_out}`,
                      drops: `${item.drops_in}/${item.drops_out}`,
                    }))}
                    emptyText="No interfaces found."
                  />
                </article>
                <article>
                  <h2>Live Throughput</h2>
                  <div className="chart-block">
                    <h4>Total Ingress (Mbps)</h4>
                    <LineHistoryChart data={historyRx} color="#72c7ff" yMax={Math.max(100, ...historyRx.map((x) => x.value), 100)} unit=" Mbps" />
                  </div>
                  <div className="chart-block">
                    <h4>Total Egress (Mbps)</h4>
                    <LineHistoryChart data={historyTx} color="#f59dff" yMax={Math.max(100, ...historyTx.map((x) => x.value), 100)} unit=" Mbps" />
                  </div>
                </article>
              </section>

              <section className="latency-grid">
                <LatencyResourceTable title="HTTP Path Latency" rows={data.resource_latency.http || []} />
                <LatencyResourceTable title="HTTPS Path Latency" rows={data.resource_latency.https || []} />
                <LatencyResourceTable title="ICMP Path Latency" rows={data.resource_latency.icmp || []} />
              </section>
            </>
          ) : null}
        </>
      ) : activeMenu === "database-monitoring" ? (
        <>
          <section className="hero">
            <div>
              <h1><span className="k-brand">K</span> - Database Monitoring</h1>
              <p>Database service uptime, memory pressure, and datastore capacity.</p>
            </div>
            <div className="hero-actions">
              <StatusBadge healthy={databaseServices.every((svc) => svc.healthy)} label="DB Services" />
              <button onClick={loadData} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button>
            </div>
          </section>

          {data ? (
            <>
              <section className="panel two-col">
                <article>
                  <h2>Database Services ({databaseServices.length})</h2>
                  <DataTable
                    columns={[
                      { key: "service", label: "Service" },
                      { key: "unit", label: "Unit" },
                      { key: "active", label: "Active" },
                      { key: "sub", label: "Sub" },
                      { key: "health", label: "Healthy" },
                    ]}
                    rows={databaseServices.map((item) => ({ ...item, health: item.healthy ? "Yes" : "No" }))}
                    emptyText="No tracked database services found on this host."
                  />
                </article>
                <article>
                  <h2>Datastore Capacity</h2>
                  <DataTable
                    columns={[
                      { key: "device", label: "Device" },
                      { key: "mountpoint", label: "Mount" },
                      { key: "fstype", label: "FS" },
                      { key: "used_label", label: "Used / Total" },
                      { key: "percent_label", label: "Usage %" },
                      { key: "healthy_label", label: "Healthy" },
                    ]}
                    rows={(data.datastores?.items || []).map((item) => ({
                      ...item,
                      used_label: `${item.used_gb} GB / ${item.total_gb} GB`,
                      percent_label: `${item.percent}%`,
                      healthy_label: item.healthy ? "Yes" : "No",
                    }))}
                    emptyText="No datastore information available."
                  />
                </article>
              </section>

              <section className="panel">
                <h2>Database Processes by Memory</h2>
                <DataTable
                  columns={[
                    { key: "pid", label: "PID" },
                    { key: "name", label: "Process" },
                    { key: "username", label: "User" },
                    { key: "memory_rss_gb", label: "Memory (GB)" },
                    { key: "memory_percent", label: "Memory %" },
                    { key: "cpu_percent", label: "CPU %" },
                  ]}
                  rows={databaseProcesses}
                  emptyText="No database-like processes found in top memory list."
                />
              </section>
            </>
          ) : null}
        </>
      ) : activeMenu === "configuration-monitoring" ? (
        <>
          <section className="hero">
            <div>
              <h1><span className="k-brand">K</span> - Configuration Monitoring</h1>
              <p>Platform configuration state, service posture, and control checks.</p>
            </div>
            <div className="hero-actions">
              <StatusBadge healthy={(data?.alerting?.alerts || []).length === 0} label="Config Drift" />
              <button onClick={loadData} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button>
            </div>
          </section>

          {data ? (
            <>
              <section className="panel two-col">
                <article>
                  <h2>System Baseline</h2>
                  <ul className="meta-list">
                    <li><b>Hostname:</b> {data.system_info.hostname}</li>
                    <li><b>OS:</b> {data.system_info.os}</li>
                    <li><b>Kernel:</b> {data.system_info.kernel}</li>
                    <li><b>Architecture:</b> {data.system_info.architecture}</li>
                    <li><b>Python:</b> {data.system_info.python_version}</li>
                    <li><b>Boot Time:</b> {formatDate(data.system_info.boot_time)}</li>
                  </ul>
                </article>
                <article>
                  <h2>Alerting Configuration</h2>
                  <ul className="meta-list">
                    <li><b>Email Enabled:</b> {data.alerting?.email_enabled ? "Yes" : "No"}</li>
                    <li><b>Last Email Status:</b> {data.alerting?.email?.reason || "N/A"}</li>
                    <li><b>Active Alerts:</b> {data.alerting?.count ?? 0}</li>
                    <li><b>TLS Expiring Soon:</b> {data.tls_certificates?.summary?.expiring_soon ?? 0}</li>
                    <li><b>TLS Expired:</b> {data.tls_certificates?.summary?.expired ?? 0}</li>
                  </ul>
                </article>
              </section>

              <section className="panel">
                <h2>Service Configuration State</h2>
                <DataTable
                  columns={[
                    { key: "service", label: "Service" },
                    { key: "unit", label: "Unit" },
                    { key: "active", label: "Active" },
                    { key: "sub", label: "Sub" },
                    { key: "health", label: "Healthy" },
                  ]}
                  rows={(data.services?.critical || []).map((item) => ({ ...item, health: item.healthy ? "Yes" : "No" }))}
                  emptyText="No tracked critical services found on this host."
                />
              </section>

              <section className="panel">
                <h2>Kubernetes Context</h2>
                <ul className="meta-list">
                  <li><b>Context:</b> {data.kubernetes?.context || "N/A"}</li>
                  <li><b>Message:</b> {data.kubernetes?.message || "N/A"}</li>
                  <li><b>Nodes Ready:</b> {data.kubernetes?.nodes?.ready ?? 0} / {data.kubernetes?.nodes?.count ?? 0}</li>
                  <li><b>Namespaces:</b> {data.kubernetes?.pods?.namespaces ?? 0}</li>
                </ul>
              </section>
            </>
          ) : null}
        </>
      ) : activeMenu === "storage-monitoring" ? (
        <>
          <section className="hero">
            <div>
              <h1><span className="k-brand">K</span> - Storage Monitoring</h1>
              <p>Filesystem capacity, root disk utilization, and storage alert posture.</p>
            </div>
            <div className="hero-actions">
              <StatusBadge healthy={storageAlerts.length === 0} label={storageAlerts.length ? "Attention Needed" : "Stable"} />
              <button onClick={loadData} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button>
            </div>
          </section>

          {data ? (
            <>
              <section className="grid-cards">
                <div className="card-with-icon"><span className="card-icon"><HardDrive size={18} /></span><StatCard title="Root Disk" value={`${data.system_info.disk.percent}%`} subtitle={`${data.system_info.disk.used_gb} GB / ${data.system_info.disk.total_gb} GB`} healthy={data.system_info.disk.percent < thresholds.disk} /></div>
                <div className="card-with-icon"><span className="card-icon"><Boxes size={18} /></span><StatCard title="Datastores" value={`${data.datastores?.summary?.count ?? 0}`} subtitle={`Critical ${data.datastores?.summary?.critical_usage ?? 0} • High ${data.datastores?.summary?.high_usage ?? 0}`} healthy={(data.datastores?.summary?.critical_usage ?? 0) === 0} /></div>
              </section>

              <section className="panel">
                <h2>Datastore Capacity</h2>
                <DataTable
                  columns={[
                    { key: "device", label: "Device" },
                    { key: "mountpoint", label: "Mount" },
                    { key: "fstype", label: "FS" },
                    { key: "used_label", label: "Used / Total" },
                    { key: "percent_label", label: "Usage %" },
                    { key: "healthy_label", label: "Healthy" },
                  ]}
                  rows={(data.datastores?.items || []).map((item) => ({
                    ...item,
                    used_label: `${item.used_gb} GB / ${item.total_gb} GB`,
                    percent_label: `${item.percent}%`,
                    healthy_label: item.healthy ? "Yes" : "No",
                  }))}
                  emptyText="No datastore information available."
                />
              </section>

              <section className="panel">
                <h2>Storage Alerts</h2>
                <div className="alert-list">
                  {!storageAlerts.length ? (
                    <p className="ok-note">No storage alerts detected.</p>
                  ) : (
                    storageAlerts.map((alert, idx) => (
                      <p key={`storage-alert-${idx}`} className="warn-note">{alert}</p>
                    ))
                  )}
                </div>
              </section>
            </>
          ) : null}
        </>
      ) : (
        <section className="panel">
          <h2>Coming Soon</h2>
          <p className="muted">{INFRA_MENU_ITEMS.find((item) => item.id === activeMenu)?.label} view will be enabled next.</p>
        </section>
      )}
      </main>
    </div>
  );
}
