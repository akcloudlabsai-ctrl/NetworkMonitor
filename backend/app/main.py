
import json
import os
import platform
import re
import shutil
import socket
import ssl
import smtplib
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.message import EmailMessage
from threading import Lock
from typing import Any

import psutil
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="Network Monitor API", version="1.0.0")

_ALERT_LOCK = Lock()
_LAST_ALERT_SIGNATURE = ""
_LAST_ALERT_SENT_AT = 0.0
_LAST_ALERT_STATUS: dict[str, Any] = {
    "enabled": False,
    "sent": False,
    "reason": "not-configured",
    "timestamp": None,
}


class IncidentTriageRequest(BaseModel):
    summary: str = Field(min_length=5, max_length=4000)
    service: str | None = None
    impact: str | None = None
    urgency: str | None = None


def _incident_triage(payload: IncidentTriageRequest) -> dict[str, Any]:
    text = f"{payload.summary} {payload.service or ''} {payload.impact or ''} {payload.urgency or ''}".lower()

    system = _system_info()
    internet_ok, _ = _check_internet()
    dns_results = [_dns_lookup(domain) for domain in ["google.com", "cloudflare.com", "microsoft.com"]]
    services = _service_health()
    interfaces = _network_interfaces()
    tls_certificates = _tls_certificates()
    datastores = _datastore_capacity()
    resource_latency = _resource_latency()
    config = _get_alert_config()

    active_alerts = _build_alerts(system, internet_ok, dns_results, services, interfaces, tls_certificates, datastores, resource_latency, config)

    score = 0
    if any(k in text for k in ["down", "outage", "critical", "failed", "unavailable", "sev1", "p1"]):
        score += 3
    if any(k in text for k in ["latency", "slow", "timeout", "degraded"]):
        score += 2
    if any(k in text for k in ["payment", "card", "transaction", "swift", "settlement", "core banking", "trading"]):
        score += 2
    if payload.urgency and payload.urgency.lower() in {"high", "critical", "immediate"}:
        score += 2
    if payload.impact and payload.impact.lower() in {"all users", "customer-facing", "production", "global"}:
        score += 2
    if not internet_ok:
        score += 1
    if active_alerts:
        score += 1

    if score >= 7:
        severity = "Critical"
    elif score >= 5:
        severity = "High"
    elif score >= 3:
        severity = "Medium"
    else:
        severity = "Low"

    probable_causes: list[str] = []
    if not internet_ok:
        probable_causes.append("Internet connectivity instability detected")
    if not all(item.get("resolved") for item in dns_results):
        probable_causes.append("DNS resolution failures affecting upstream reachability")
    if services.get("summary", {}).get("failed", 0) > 0:
        probable_causes.append("One or more critical services are in failed state")
    if datastores.get("summary", {}).get("critical_usage", 0) > 0:
        probable_causes.append("Datastore capacity is in critical utilization")
    if any(x.get("response_time_ms") and x["response_time_ms"] >= 1000 for x in resource_latency.get("https", [])):
        probable_causes.append("External dependency HTTPS latency is elevated")
    if any(k in text for k in ["database", "sql", "db"]):
        probable_causes.append("Database tier saturation or service disruption")
    if any(k in text for k in ["api", "gateway", "timeout"]):
        probable_causes.append("API gateway or upstream timeout under load")
    if not probable_causes:
        probable_causes.append("No direct fault signature; investigate recent deployments and traffic spikes")

    runbook_steps = [
        "Confirm incident scope (service, region, customer segment) and declare severity.",
        "Check active platform alerts, failed services, and dependency latency panels.",
        "Stabilize user impact first: failover, rate-limit, rollback, or route to standby.",
        "Validate critical financial workflows (payments, order flow, settlements) end-to-end.",
        "Collect forensic evidence (logs, traces, metrics, config diff) before major changes.",
        "Communicate every 15 minutes to incident channel and business stakeholders.",
    ]

    compliance_actions = [
        "Preserve audit trail for SOX/PCI evidence (timestamps, actors, commands).",
        "Do not expose PII/PAN in tickets, chat, or screenshots.",
        "Record customer impact and control effectiveness for post-incident review.",
    ]

    escalation = {
        "immediate": ["NOC", "SRE on-call", "Application owner"],
        "within_15_min": ["Security/Compliance on-call", "Service owner manager"],
        "within_30_min": ["Incident commander", "Business operations lead"],
    }

    return {
        "severity": severity,
        "score": score,
        "summary": payload.summary,
        "context": {
            "service": payload.service,
            "impact": payload.impact,
            "urgency": payload.urgency,
        },
        "probable_causes": probable_causes[:6],
        "recommended_runbook": runbook_steps,
        "compliance_actions": compliance_actions,
        "escalation_plan": escalation,
        "active_platform_alerts": active_alerts,
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
    }

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _bytes_to_gb(value: int | float) -> float:
    return round(float(value) / (1024**3), 2)


def _check_internet(host: str = "8.8.8.8", port: int = 53, timeout: float = 2.0) -> tuple[bool, float | None]:
    start = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            latency_ms = (time.perf_counter() - start) * 1000
            return True, round(latency_ms, 2)
    except OSError:
        return False, None


def _dns_lookup(domain: str) -> dict[str, Any]:
    start = time.perf_counter()
    try:
        _, _, ips = socket.gethostbyname_ex(domain)
        elapsed_ms = (time.perf_counter() - start) * 1000
        return {
            "domain": domain,
            "resolved": True,
            "latency_ms": round(elapsed_ms, 2),
            "ips": sorted(set(ips)),
        }
    except OSError:
        return {
            "domain": domain,
            "resolved": False,
            "latency_ms": None,
            "ips": [],
        }


def _listening_ports() -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    seen = set()
    for conn in psutil.net_connections(kind="inet"):
        if conn.status != psutil.CONN_LISTEN or not conn.laddr:
            continue

        ip = conn.laddr.ip
        port = conn.laddr.port
        pid = conn.pid
        key = (ip, port, pid)
        if key in seen:
            continue
        seen.add(key)

        process_name = "unknown"
        if pid:
            try:
                process_name = psutil.Process(pid).name()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                process_name = "access-denied"

        results.append(
            {
                "ip": ip,
                "port": port,
                "pid": pid,
                "process_name": process_name,
                "protocol": "tcp",
            }
        )

    results.sort(key=lambda x: (x["port"], x["ip"]))
    return results


def _top_memory_processes(limit: int = 8) -> list[dict[str, Any]]:
    processes: list[dict[str, Any]] = []
    for process in psutil.process_iter([
        "pid",
        "name",
        "username",
        "memory_info",
        "memory_percent",
        "cpu_percent",
    ]):
        try:
            info = process.info
            rss = info["memory_info"].rss if info.get("memory_info") else 0
            processes.append(
                {
                    "pid": info.get("pid"),
                    "name": info.get("name") or "unknown",
                    "username": info.get("username") or "unknown",
                    "memory_rss_gb": _bytes_to_gb(rss),
                    "memory_percent": round(info.get("memory_percent", 0.0), 2),
                    "cpu_percent": round(info.get("cpu_percent", 0.0), 2),
                }
            )
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    processes.sort(key=lambda x: x["memory_rss_gb"], reverse=True)
    return processes[:limit]


def _running_servers(ports: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, int | None], dict[str, Any]] = {}
    for item in ports:
        key = (item["process_name"], item["pid"])
        if key not in grouped:
            grouped[key] = {
                "name": item["process_name"],
                "pid": item["pid"],
                "ports": [],
                "bind_ips": set(),
            }

        grouped[key]["ports"].append(item["port"])
        grouped[key]["bind_ips"].add(item["ip"])

    results: list[dict[str, Any]] = []
    for value in grouped.values():
        ports_sorted = sorted(set(value["ports"]))
        bind_ips = sorted(value["bind_ips"])
        results.append(
            {
                "name": value["name"],
                "pid": value["pid"],
                "port_count": len(ports_sorted),
                "ports": ports_sorted,
                "bind_ips": bind_ips,
            }
        )

    results.sort(key=lambda x: (x["name"], x["pid"] or 0))
    return results


def _network_interfaces() -> dict[str, Any]:
    interfaces: list[dict[str, Any]] = []
    io_stats = psutil.net_io_counters(pernic=True)
    addr_map = psutil.net_if_addrs()
    nic_stats = psutil.net_if_stats()

    total_errors = 0
    total_drops = 0

    for name, stats in nic_stats.items():
        addrs = addr_map.get(name, [])
        io = io_stats.get(name)

        ipv4 = [a.address for a in addrs if a.family == socket.AF_INET]
        ipv6 = [a.address for a in addrs if a.family == socket.AF_INET6]
        mac = next((a.address for a in addrs if str(a.family) == "AddressFamily.AF_PACKET"), None)

        err_in = int(getattr(io, "errin", 0) if io else 0)
        err_out = int(getattr(io, "errout", 0) if io else 0)
        drop_in = int(getattr(io, "dropin", 0) if io else 0)
        drop_out = int(getattr(io, "dropout", 0) if io else 0)

        total_errors += err_in + err_out
        total_drops += drop_in + drop_out

        interfaces.append(
            {
                "name": name,
                "is_up": bool(stats.isup),
                "speed_mbps": stats.speed,
                "mtu": stats.mtu,
                "mac": mac,
                "ipv4": ipv4,
                "ipv6": ipv6,
                "bytes_sent": int(getattr(io, "bytes_sent", 0) if io else 0),
                "bytes_recv": int(getattr(io, "bytes_recv", 0) if io else 0),
                "packets_sent": int(getattr(io, "packets_sent", 0) if io else 0),
                "packets_recv": int(getattr(io, "packets_recv", 0) if io else 0),
                "errors_in": err_in,
                "errors_out": err_out,
                "drops_in": drop_in,
                "drops_out": drop_out,
            }
        )

    interfaces.sort(key=lambda x: x["name"])
    return {
        "count": len(interfaces),
        "items": interfaces,
        "summary": {
            "up": sum(1 for i in interfaces if i["is_up"]),
            "down": sum(1 for i in interfaces if not i["is_up"]),
            "total_errors": total_errors,
            "total_drops": total_drops,
        },
    }


def _service_health() -> dict[str, Any]:
    systemctl = shutil.which("systemctl")
    critical_names = ["ssh", "sshd", "docker", "containerd", "kubelet", "nginx", "apache2", "postgresql", "mysql", "redis", "etcd"]

    if not systemctl:
        return {
            "installed": False,
            "message": "systemctl not found",
            "summary": {"total": 0, "active": 0, "failed": 0, "inactive": 0},
            "critical": [],
        }

    ok, output = _run_cmd([systemctl, "list-units", "--type=service", "--all", "--no-pager", "--no-legend"], timeout=6.0)
    if not ok:
        return {
            "installed": True,
            "message": output,
            "summary": {"total": 0, "active": 0, "failed": 0, "inactive": 0},
            "critical": [],
        }

    services: list[dict[str, Any]] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        parts = line.split()
        if len(parts) < 4:
            continue
        unit = parts[0]
        load = parts[1]
        active = parts[2]
        sub = parts[3]
        description = " ".join(parts[4:]) if len(parts) > 4 else ""
        services.append({"unit": unit, "load": load, "active": active, "sub": sub, "description": description})

    summary = {
        "total": len(services),
        "active": sum(1 for s in services if s["active"] == "active"),
        "failed": sum(1 for s in services if s["active"] == "failed"),
        "inactive": sum(1 for s in services if s["active"] in {"inactive", "dead"}),
    }

    critical: list[dict[str, Any]] = []
    for name in critical_names:
        unit_name = f"{name}.service"
        matched = next((s for s in services if s["unit"] == unit_name or s["unit"].startswith(f"{name}@")), None)
        if matched:
            critical.append(
                {
                    "service": name,
                    "unit": matched["unit"],
                    "active": matched["active"],
                    "sub": matched["sub"],
                    "healthy": matched["active"] == "active",
                }
            )

    return {
        "installed": True,
        "message": "ok",
        "summary": summary,
        "critical": critical,
    }


def _virtualization_info() -> dict[str, Any]:
    detector = shutil.which("systemd-detect-virt")
    virt_type = "unknown"
    if detector:
        ok, out = _run_cmd([detector], timeout=2.0)
        virt_type = out if ok and out else "none"
    else:
        virt_type = "none"

    vm_tokens = ["qemu", "kvm", "vmware", "vbox", "libvirtd", "virtqemud"]
    vm_processes: list[dict[str, Any]] = []
    for process in psutil.process_iter(["pid", "name", "memory_percent", "cmdline"]):
        try:
            info = process.info
            text = f"{info.get('name', '')} {' '.join(info.get('cmdline') or [])}".lower()
            if any(token in text for token in vm_tokens):
                vm_processes.append(
                    {
                        "pid": info.get("pid"),
                        "name": info.get("name") or "unknown",
                        "memory_percent": round(float(info.get("memory_percent") or 0.0), 2),
                    }
                )
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    vm_processes.sort(key=lambda x: x["memory_percent"], reverse=True)
    host_role = "physical"
    if vm_processes:
        host_role = "hypervisor-likely"
    elif virt_type not in {"none", "unknown"}:
        host_role = "virtual-machine"

    return {
        "host_role": host_role,
        "virt_type": virt_type,
        "running_vm_process_count": len(vm_processes),
        "top_vm_processes": vm_processes[:8],
    }


def _tls_certificates(targets: list[tuple[str, int]] | None = None) -> dict[str, Any]:
    targets = targets or [("google.com", 443), ("cloudflare.com", 443), ("microsoft.com", 443)]
    now = datetime.now(timezone.utc)
    items: list[dict[str, Any]] = []

    for host, port in targets:
        start = time.perf_counter()
        try:
            context = ssl.create_default_context()
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            with socket.create_connection((host, port), timeout=4.0) as sock:
                with context.wrap_socket(sock, server_hostname=host) as secured:
                    cert = secured.getpeercert()

            not_after_text = cert.get("notAfter")
            expires_at = None
            days_left = None
            healthy = False
            if not_after_text:
                expires_at_dt = datetime.strptime(not_after_text, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
                expires_at = expires_at_dt.isoformat()
                days_left = (expires_at_dt - now).days
                healthy = days_left >= 14

            elapsed_ms = (time.perf_counter() - start) * 1000
            items.append(
                {
                    "host": host,
                    "port": port,
                    "reachable": True,
                    "expires_at": expires_at,
                    "days_left": days_left,
                    "healthy": healthy,
                    "latency_ms": round(elapsed_ms, 2),
                }
            )
        except (OSError, ssl.SSLError, socket.error) as ex:
            items.append(
                {
                    "host": host,
                    "port": port,
                    "reachable": False,
                    "expires_at": None,
                    "days_left": None,
                    "healthy": False,
                    "latency_ms": None,
                    "error": str(ex),
                }
            )

    summary = {
        "count": len(items),
        "reachable": sum(1 for i in items if i["reachable"]),
        "expired": sum(1 for i in items if i.get("days_left") is not None and i["days_left"] < 0),
        "expiring_soon": sum(1 for i in items if i.get("days_left") is not None and 0 <= i["days_left"] < 14),
    }
    return {"summary": summary, "items": items}


def _datastore_capacity() -> dict[str, Any]:
    skip_fs = {"tmpfs", "devtmpfs", "overlay", "squashfs", "proc", "sysfs", "cgroup2", "autofs", "mqueue", "debugfs", "tracefs", "fusectl", "securityfs", "pstore", "efivarfs"}
    items: list[dict[str, Any]] = []

    for part in psutil.disk_partitions(all=False):
        if part.fstype in skip_fs:
            continue
        try:
            usage = psutil.disk_usage(part.mountpoint)
        except PermissionError:
            continue

        items.append(
            {
                "device": part.device,
                "mountpoint": part.mountpoint,
                "fstype": part.fstype,
                "total_gb": _bytes_to_gb(usage.total),
                "used_gb": _bytes_to_gb(usage.used),
                "free_gb": _bytes_to_gb(usage.free),
                "percent": round(usage.percent, 2),
                "healthy": usage.percent < 85,
            }
        )

    items.sort(key=lambda x: x["percent"], reverse=True)
    summary = {
        "count": len(items),
        "high_usage": sum(1 for i in items if i["percent"] >= 85),
        "critical_usage": sum(1 for i in items if i["percent"] >= 95),
    }
    return {"summary": summary, "items": items}


def _default_resource_targets() -> list[dict[str, str]]:
    return [
        {"name": "OpenAI", "host": "openai.com"},
        {"name": "Cloudflare", "host": "cloudflare.com"},
        {"name": "Microsoft", "host": "microsoft.com"},
        {"name": "GitHub", "host": "github.com"},
        {"name": "Google", "host": "google.com"},
        {"name": "Wikipedia", "host": "wikipedia.org"},
    ]


def _resource_targets() -> list[dict[str, str]]:
    raw = os.getenv("RESOURCE_TARGETS", "").strip()
    if not raw:
        return _default_resource_targets()

    parsed: list[dict[str, str]] = []
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "," in chunk:
            name, host = chunk.split(",", 1)
            parsed.append({"name": name.strip(), "host": host.strip()})
        else:
            parsed.append({"name": chunk, "host": chunk})

    return parsed or _default_resource_targets()


def _http_latency(host: str, scheme: str = "https") -> tuple[bool, float | None, str | None]:
    url = f"{scheme}://{host}"
    start = time.perf_counter()
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "NetworkMonitor/1.0"})
        with urllib.request.urlopen(request, timeout=4.0):  # noqa: S310
            elapsed_ms = (time.perf_counter() - start) * 1000
            return True, round(elapsed_ms, 2), None
    except (urllib.error.URLError, socket.timeout, OSError) as ex:
        return False, None, str(ex)


def _icmp_latency(host: str) -> tuple[bool, float | None, str | None]:
    ping = shutil.which("ping")
    if not ping:
        return False, None, "ping command not found"

    ok, output = _run_cmd([ping, "-c", "1", "-W", "1", host], timeout=3.0)
    if not ok:
        return False, None, output

    match = re.search(r"time=([0-9.]+)\s*ms", output)
    if not match:
        return False, None, "unable to parse ping latency"
    return True, round(float(match.group(1)), 2), None


def _resource_latency() -> dict[str, Any]:
    targets = _resource_targets()
    http_items: list[dict[str, Any]] = []
    https_items: list[dict[str, Any]] = []
    icmp_items: list[dict[str, Any]] = []

    for target in targets:
        name = target["name"]
        host = target["host"]

        ok_http, ms_http, err_http = _http_latency(host, "http")
        http_items.append(
            {
                "name": name,
                "host": host,
                "response_time_ms": ms_http,
                "reachable": ok_http,
                "error": err_http,
            }
        )

        ok_https, ms_https, err_https = _http_latency(host, "https")
        https_items.append(
            {
                "name": name,
                "host": host,
                "response_time_ms": ms_https,
                "reachable": ok_https,
                "error": err_https,
            }
        )

        ok_icmp, ms_icmp, err_icmp = _icmp_latency(host)
        icmp_items.append(
            {
                "name": name,
                "host": host,
                "response_time_ms": ms_icmp,
                "reachable": ok_icmp,
                "error": err_icmp,
            }
        )

    def _sorted(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return sorted(items, key=lambda x: (x["response_time_ms"] is None, -(x["response_time_ms"] or -1)))

    return {
        "targets": targets,
        "http": _sorted(http_items),
        "https": _sorted(https_items),
        "icmp": _sorted(icmp_items),
    }


def _run_cmd(command: list[str], timeout: float = 3.0) -> tuple[bool, str]:
    try:
        process = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
        if process.returncode != 0:
            return False, (process.stderr or process.stdout or "command failed").strip()
        return True, process.stdout.strip()
    except (subprocess.SubprocessError, subprocess.TimeoutExpired, OSError) as ex:
        return False, str(ex)


def _get_alert_config() -> dict[str, Any]:
    recipients = [x.strip() for x in os.getenv("ALERT_EMAIL_TO", "").split(",") if x.strip()]
    return {
        "enabled": os.getenv("ALERT_EMAIL_ENABLED", "false").lower() == "true",
        "smtp_host": os.getenv("ALERT_SMTP_HOST", ""),
        "smtp_port": int(os.getenv("ALERT_SMTP_PORT", "587")),
        "smtp_user": os.getenv("ALERT_SMTP_USER", ""),
        "smtp_password": os.getenv("ALERT_SMTP_PASSWORD", ""),
        "smtp_starttls": os.getenv("ALERT_SMTP_STARTTLS", "true").lower() == "true",
        "from_email": os.getenv("ALERT_EMAIL_FROM", "network-monitor@localhost"),
        "to_emails": recipients,
        "cooldown_seconds": int(os.getenv("ALERT_EMAIL_COOLDOWN_SECONDS", "900")),
        "cpu_threshold": float(os.getenv("ALERT_CPU_THRESHOLD", "90")),
        "memory_threshold": float(os.getenv("ALERT_MEMORY_THRESHOLD", "85")),
        "disk_threshold": float(os.getenv("ALERT_DISK_THRESHOLD", "90")),
    }


def _build_alerts(
    system: dict[str, Any],
    internet_ok: bool,
    dns_results: list[dict[str, Any]],
    services: dict[str, Any],
    interfaces: dict[str, Any],
    tls_certificates: dict[str, Any],
    datastores: dict[str, Any],
    resource_latency: dict[str, Any],
    config: dict[str, Any],
) -> list[str]:
    alerts: list[str] = []

    if system["cpu"]["usage_percent"] >= config["cpu_threshold"]:
        alerts.append(f"High CPU: {system['cpu']['usage_percent']}% (threshold {config['cpu_threshold']}%)")
    if system["memory"]["percent"] >= config["memory_threshold"]:
        alerts.append(f"High RAM: {system['memory']['percent']}% (threshold {config['memory_threshold']}%)")
    if system["disk"]["percent"] >= config["disk_threshold"]:
        alerts.append(f"High Disk: {system['disk']['percent']}% (threshold {config['disk_threshold']}%)")
    if not internet_ok:
        alerts.append("Internet connectivity lost")
    if not all(item.get("resolved") for item in dns_results):
        alerts.append("DNS resolution failed for one or more domains")

    failed_services = services.get("summary", {}).get("failed", 0)
    if failed_services > 0:
        alerts.append(f"Failed services detected: {failed_services}")

    total_errors = interfaces.get("summary", {}).get("total_errors", 0)
    total_drops = interfaces.get("summary", {}).get("total_drops", 0)
    if total_errors > 0:
        alerts.append(f"Network interface errors detected: {total_errors}")
    if total_drops > 0:
        alerts.append(f"Network packet drops detected: {total_drops}")

    tls_summary = tls_certificates.get("summary", {})
    if tls_summary.get("expired", 0) > 0:
        alerts.append(f"Expired TLS certificates detected: {tls_summary['expired']}")
    if tls_summary.get("expiring_soon", 0) > 0:
        alerts.append(f"TLS certificates expiring soon: {tls_summary['expiring_soon']}")

    critical_datastores = datastores.get("summary", {}).get("critical_usage", 0)
    if critical_datastores > 0:
        alerts.append(f"Critical datastore usage detected: {critical_datastores}")

    for key, label in (("http", "HTTP"), ("https", "HTTPS"), ("icmp", "ICMP")):
        high = [x for x in resource_latency.get(key, []) if x.get("response_time_ms") is not None and x["response_time_ms"] >= 1000]
        if high:
            alerts.append(f"High {label} latency resources: {len(high)}")

    return alerts


def _send_alert_email(alerts: list[str], system: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    now = time.time()
    signature = "|".join(sorted(alerts))

    with _ALERT_LOCK:
        global _LAST_ALERT_SIGNATURE, _LAST_ALERT_SENT_AT, _LAST_ALERT_STATUS

        if not alerts:
            _LAST_ALERT_STATUS = {
                "enabled": config["enabled"],
                "sent": False,
                "reason": "no-alerts",
                "timestamp": datetime.now(tz=timezone.utc).isoformat(),
            }
            return _LAST_ALERT_STATUS

        if not config["enabled"]:
            _LAST_ALERT_STATUS = {
                "enabled": False,
                "sent": False,
                "reason": "disabled",
                "timestamp": datetime.now(tz=timezone.utc).isoformat(),
            }
            return _LAST_ALERT_STATUS

        required = [config["smtp_host"], config["smtp_user"], config["smtp_password"], *config["to_emails"]]
        if not all(required):
            _LAST_ALERT_STATUS = {
                "enabled": True,
                "sent": False,
                "reason": "incomplete-smtp-config",
                "timestamp": datetime.now(tz=timezone.utc).isoformat(),
            }
            return _LAST_ALERT_STATUS

        if signature == _LAST_ALERT_SIGNATURE and (now - _LAST_ALERT_SENT_AT) < config["cooldown_seconds"]:
            _LAST_ALERT_STATUS = {
                "enabled": True,
                "sent": False,
                "reason": "cooldown",
                "timestamp": datetime.now(tz=timezone.utc).isoformat(),
                "cooldown_seconds": config["cooldown_seconds"],
            }
            return _LAST_ALERT_STATUS

        message = EmailMessage()
        message["Subject"] = f"[ALERT] Network Monitor - {system['hostname']}"
        message["From"] = config["from_email"]
        message["To"] = ", ".join(config["to_emails"])
        body = [
            f"Host: {system['hostname']}",
            f"Time (UTC): {datetime.now(tz=timezone.utc).isoformat()}",
            "",
            "Active Alerts:",
            *[f"- {item}" for item in alerts],
        ]
        message.set_content("\n".join(body))

        try:
            with smtplib.SMTP(config["smtp_host"], config["smtp_port"], timeout=10) as smtp:
                if config["smtp_starttls"]:
                    smtp.starttls()
                smtp.login(config["smtp_user"], config["smtp_password"])
                smtp.send_message(message)

            _LAST_ALERT_SIGNATURE = signature
            _LAST_ALERT_SENT_AT = now
            _LAST_ALERT_STATUS = {
                "enabled": True,
                "sent": True,
                "reason": "sent",
                "timestamp": datetime.now(tz=timezone.utc).isoformat(),
                "recipients": config["to_emails"],
            }
            return _LAST_ALERT_STATUS
        except (smtplib.SMTPException, OSError, TimeoutError) as ex:
            _LAST_ALERT_STATUS = {
                "enabled": True,
                "sent": False,
                "reason": "send-failed",
                "timestamp": datetime.now(tz=timezone.utc).isoformat(),
                "error": str(ex),
            }
            return _LAST_ALERT_STATUS


def _kubernetes_info() -> dict[str, Any]:
    kubectl = shutil.which("kubectl")
    if not kubectl:
        return {
            "installed": False,
            "connected": False,
            "message": "kubectl not found",
            "context": None,
            "nodes": {"count": 0, "ready": 0, "items": []},
            "pods": {"count": 0, "running": 0, "namespaces": 0},
        }

    ok_ctx, current_context = _run_cmd([kubectl, "config", "current-context"])
    if not ok_ctx:
        return {
            "installed": True,
            "connected": False,
            "message": current_context,
            "context": None,
            "nodes": {"count": 0, "ready": 0, "items": []},
            "pods": {"count": 0, "running": 0, "namespaces": 0},
        }

    ok_nodes, nodes_out = _run_cmd([kubectl, "get", "nodes", "-o", "json"], timeout=5.0)
    ok_pods, pods_out = _run_cmd([kubectl, "get", "pods", "-A", "-o", "json"], timeout=5.0)

    nodes_items: list[dict[str, Any]] = []
    nodes_ready = 0
    if ok_nodes:
        try:
            nodes_json = json.loads(nodes_out)
            for node in nodes_json.get("items", []):
                name = node.get("metadata", {}).get("name", "unknown")
                conditions = node.get("status", {}).get("conditions", [])
                ready = any(c.get("type") == "Ready" and c.get("status") == "True" for c in conditions)
                _prefix = "node-role.kubernetes.io/"
                roles = [
                    k[len(_prefix):]
                    for k in (node.get("metadata", {}).get("labels", {}) or {}).keys()
                    if k.startswith(_prefix)
                ]
                if ready:
                    nodes_ready += 1
                nodes_items.append(
                    {
                        "name": name,
                        "ready": ready,
                        "roles": roles or ["worker"],
                        "kubelet_version": node.get("status", {}).get("nodeInfo", {}).get("kubeletVersion"),
                    }
                )
        except json.JSONDecodeError:
            ok_nodes = False

    pods_count = 0
    pods_running = 0
    namespaces: set[str] = set()
    if ok_pods:
        try:
            pods_json = json.loads(pods_out)
            for pod in pods_json.get("items", []):
                pods_count += 1
                phase = pod.get("status", {}).get("phase")
                if phase == "Running":
                    pods_running += 1
                namespaces.add(pod.get("metadata", {}).get("namespace", "default"))
        except json.JSONDecodeError:
            ok_pods = False

    return {
        "installed": True,
        "connected": ok_nodes or ok_pods,
        "message": "Connected" if (ok_nodes or ok_pods) else "kubectl present but cluster data unavailable",
        "context": current_context,
        "nodes": {
            "count": len(nodes_items),
            "ready": nodes_ready,
            "items": nodes_items,
        },
        "pods": {
            "count": pods_count,
            "running": pods_running,
            "namespaces": len(namespaces),
        },
    }


def _system_info() -> dict[str, Any]:
    vm = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    swap = psutil.swap_memory()

    return {
        "hostname": socket.gethostname(),
        "os": platform.platform(),
        "kernel": platform.release(),
        "architecture": platform.machine(),
        "python_version": platform.python_version(),
        "cpu": {
            "physical_cores": psutil.cpu_count(logical=False),
            "logical_cores": psutil.cpu_count(logical=True),
            "usage_percent": round(psutil.cpu_percent(interval=0.3), 2),
            "load_avg": tuple(round(x, 2) for x in os.getloadavg()) if hasattr(os, "getloadavg") else None,
        },
        "memory": {
            "total_gb": _bytes_to_gb(vm.total),
            "used_gb": _bytes_to_gb(vm.used),
            "available_gb": _bytes_to_gb(vm.available),
            "percent": round(vm.percent, 2),
            "swap_total_gb": _bytes_to_gb(swap.total),
            "swap_used_gb": _bytes_to_gb(swap.used),
            "swap_percent": round(swap.percent, 2),
        },
        "disk": {
            "total_gb": _bytes_to_gb(disk.total),
            "used_gb": _bytes_to_gb(disk.used),
            "free_gb": _bytes_to_gb(disk.free),
            "percent": round(disk.percent, 2),
        },
        "boot_time": datetime.fromtimestamp(psutil.boot_time(), tz=timezone.utc).isoformat(),
        "timestamp": datetime.now(tz=timezone.utc).isoformat(),
    }


def _healthy_status(system: dict[str, Any], internet_ok: bool) -> dict[str, Any]:
    memory_ok = system["memory"]["percent"] < 85
    disk_ok = system["disk"]["percent"] < 90
    cpu_ok = system["cpu"]["usage_percent"] < 90

    checks = {
        "internet": internet_ok,
        "memory": memory_ok,
        "disk": disk_ok,
        "cpu": cpu_ok,
    }

    healthy = all(checks.values())
    return {
        "healthy": healthy,
        "checks": checks,
        "status": "Healthy" if healthy else "Needs Attention",
    }


@app.get("/api/health")
def health() -> dict[str, Any]:
    system = _system_info()
    internet_ok, latency = _check_internet()
    dns_results = [_dns_lookup(domain) for domain in ["google.com", "cloudflare.com", "microsoft.com"]]
    ports = _listening_ports()
    servers = _running_servers(ports)
    top_processes = _top_memory_processes(limit=8)
    kubernetes = _kubernetes_info()
    interfaces = _network_interfaces()
    services = _service_health()
    virtualization = _virtualization_info()
    tls_certificates = _tls_certificates()
    datastores = _datastore_capacity()
    resource_latency = _resource_latency()
    alert_config = _get_alert_config()
    alerts = _build_alerts(system, internet_ok, dns_results, services, interfaces, tls_certificates, datastores, resource_latency, alert_config)
    email_status = _send_alert_email(alerts, system, alert_config)

    return {
        "system_info": system,
        "internet_connectivity": {
            "connected": internet_ok,
            "latency_ms": latency,
        },
        "dns": {
            "servers_tested": len(dns_results),
            "results": dns_results,
            "healthy": all(item["resolved"] for item in dns_results),
        },
        "running_ports": {
            "count": len(ports),
            "items": ports,
        },
        "running_servers": {
            "count": len(servers),
            "items": servers,
        },
        "kubernetes": kubernetes,
        "network_interfaces": interfaces,
        "services": services,
        "virtualization": virtualization,
        "tls_certificates": tls_certificates,
        "datastores": datastores,
        "resource_latency": resource_latency,
        "top_memory_processes": {
            "count": len(top_processes),
            "items": top_processes,
        },
        "alerting": {
            "count": len(alerts),
            "alerts": alerts,
            "email": email_status,
            "email_enabled": alert_config["enabled"],
        },
        "overall_status": _healthy_status(system, internet_ok),
    }


@app.get("/api/ports")
def ports() -> dict[str, Any]:
    data = _listening_ports()
    return {"count": len(data), "items": data}


@app.get("/api/processes")
def processes(limit: int = 10) -> dict[str, Any]:
    limit = max(1, min(limit, 50))
    data = _top_memory_processes(limit=limit)
    return {"count": len(data), "items": data}


@app.get("/api/servers")
def servers() -> dict[str, Any]:
    ports = _listening_ports()
    data = _running_servers(ports)
    return {"count": len(data), "items": data}


@app.get("/api/kubernetes")
def kubernetes() -> dict[str, Any]:
    return _kubernetes_info()


@app.get("/api/network-interfaces")
def network_interfaces() -> dict[str, Any]:
    return _network_interfaces()


@app.get("/api/services")
def services() -> dict[str, Any]:
    return _service_health()


@app.get("/api/virtualization")
def virtualization() -> dict[str, Any]:
    return _virtualization_info()


@app.get("/api/tls-certificates")
def tls_certificates() -> dict[str, Any]:
    return _tls_certificates()


@app.get("/api/datastores")
def datastores() -> dict[str, Any]:
    return _datastore_capacity()


@app.get("/api/alerts/test-email")
def test_alert_email() -> dict[str, Any]:
    system = _system_info()
    config = _get_alert_config()
    result = _send_alert_email(["Manual test alert from Network Monitor"], system, config)
    return {"email": result, "email_enabled": config["enabled"]}


@app.get("/api/resource-latency")
def resource_latency() -> dict[str, Any]:
    return _resource_latency()


@app.post("/api/ai/incident/triage")
def ai_incident_triage(payload: IncidentTriageRequest) -> dict[str, Any]:
    return _incident_triage(payload)
