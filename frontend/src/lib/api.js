import axios from "axios";

const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  (window.location.port === "5173" ? "http://127.0.0.1:8000" : "");

export async function fetchDashboard() {
  const { data } = await axios.get(`${API_BASE_URL}/api/health`, { timeout: 8000 });
  return data;
}

export async function triageIncident(payload) {
  const { data } = await axios.post(`${API_BASE_URL}/api/ai/incident/triage`, payload, { timeout: 12000 });
  return data;
}
