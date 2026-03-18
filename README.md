# Network Monitor Dashboard

A full-stack local monitoring dashboard built with **FastAPI (Python)** and **React (Vite)**.

It provides:
- Local system information (OS, CPU, RAM, disk)
- List of listening/running ports
- List of server processes running (from listening ports)
- Internet connectivity status with latency
- DNS resolution health checks
- Kubernetes system summary (context, nodes, pods)
- Network interface health (speed, errors, drops)
- Critical service health summary (systemd)
- Virtualization summary (host role and VM process signals)
- Live network throughput estimates (ingress/egress Mbps)
- TLS certificate expiry checks
- Datastore capacity inventory and health
- Private Cloud left-side menu with Platform Info view
- Top resources latency panels (HTTP / HTTPS / ICMP)
- AI Incident Agent for fast financial-services incident triage
- Top memory-consuming processes
- Overall healthy status summary
- Alert notifications with custom thresholds
- Historical mini line charts (CPU/RAM/Disk)
- Export report to CSV and PDF
- Docker one-command run option

## Tech Stack

- Backend: FastAPI, psutil, uvicorn
- Frontend: React, Vite, axios, lucide-react

## Project Structure

frontend/ - React UI
backend/ - FastAPI API

## 1) Backend Setup (FastAPI)

From project root:

1. Create and activate a virtual environment
2. Install dependencies
3. Start API server

Commands:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

API base URL:
- http://127.0.0.1:8000

Key endpoint:
- GET /api/health

## 2) Frontend Setup (React)

Open a second terminal:

```bash
cd frontend
npm install
npm run dev
```

UI URL:
- http://127.0.0.1:5173

Optional custom backend URL:

```bash
VITE_API_URL=http://127.0.0.1:8000 npm run dev
```

## What the Dashboard Shows

- **CPU Usage** and cores
- **RAM Usage** including total/used
- **Disk Usage** including total/used/free
- **Internet Connectivity** (connected + latency)
- **DNS Health** (resolution checks)
- **Ports Running** table (IP, port, PID, process)
- **Servers Running** table (server process, PID, ports, bind IPs)
- **Kubernetes System** status (kubectl, cluster connectivity, nodes, pods)
- **Network Interfaces** table (status, speed, IPs, errors, drops)
- **Critical Services** table (service state for key platform services)
- **Virtualization** summary card
- **Live Throughput** charts and per-interface rates
- **TLS Certificate Expiry** table with days remaining
- **Datastore Capacity** table with usage health
- **Private Cloud > Platform Info** navigation menu
- **Top Resources by Latency** cards similar to NOC dashboards
- **AI Incident Agent** with severity scoring, probable causes, runbook, and compliance actions

Resource latency target override (optional):

- `RESOURCE_TARGETS=World Air Quality,waqi.info;Open Weather,openweathermap.org;ServiceNow,servicenow.com`
- **Top Memory Processes** table
- **Overall Health** badge
- **Alert Notifications** with user-defined threshold values
- **Historical Charts** for CPU, RAM, and disk usage
- **Export Buttons** for CSV and PDF report files

## 3) Docker (One Command Run)

From project root:

```bash
docker compose up --build
```

URLs:
- Frontend: http://127.0.0.1:5173
- Backend API: http://127.0.0.1:8000

To stop:

```bash
docker compose down
```

## Notes

- Some port/process info may require elevated permissions depending on OS.
- Data auto-refreshes every 15 seconds.

## Email Alert Notifications

Set these environment variables before starting backend:

- `ALERT_EMAIL_ENABLED=true`
- `ALERT_SMTP_HOST=smtp.yourprovider.com`
- `ALERT_SMTP_PORT=587`
- `ALERT_SMTP_USER=your_user`
- `ALERT_SMTP_PASSWORD=your_password`
- `ALERT_SMTP_STARTTLS=true`
- `ALERT_EMAIL_FROM=monitor@yourcompany.com`
- `ALERT_EMAIL_TO=ops1@yourcompany.com,ops2@yourcompany.com`
- `ALERT_EMAIL_COOLDOWN_SECONDS=900`

Optional threshold overrides:

- `ALERT_CPU_THRESHOLD=90`
- `ALERT_MEMORY_THRESHOLD=85`
- `ALERT_DISK_THRESHOLD=90`

Test email endpoint:

- `GET /api/alerts/test-email`

AI incident triage endpoint:

- `POST /api/ai/incident/triage`