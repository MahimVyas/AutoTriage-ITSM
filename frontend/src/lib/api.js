/**
 * API client for AutoTriage-ITSM.
 * Uses Vite's dev proxy (/api -> FastAPI :8000) unless VITE_API_BASE is set.
 *
 * Static builds (GitHub Pages) set VITE_DEMO=true and route every call to the
 * in-browser demo backend in ./demoApi.js instead of the network.
 */
import demoApi from './demoApi'

const BASE = import.meta.env.VITE_API_BASE || ''

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail =
        typeof body.detail === 'string'
          ? body.detail
          : JSON.stringify(body.detail || body)
    } catch {
      /* ignore body parse errors */
    }
    throw new Error(`${res.status}: ${detail}`)
  }
  return res.json()
}

const qs = (params = {}) => {
  const clean = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (!clean.length) return ''
  return `?${new URLSearchParams(clean).toString()}`
}

const realApi = {
  // --- tickets ---------------------------------------------------------
  listTickets: (filters = {}) => request(`/api/tickets${qs(filters)}`),
  getTicket: (id) => request(`/api/tickets/${id}`),
  createTicket: (payload) =>
    request('/api/tickets', { method: 'POST', body: JSON.stringify(payload) }),
  updateTicket: (id, payload) =>
    request(`/api/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  overrideTicket: (id, payload) =>
    request(`/api/tickets/${id}/override`, { method: 'POST', body: JSON.stringify(payload) }),
  escalateTicket: (id) =>
    request(`/api/tickets/${id}/escalate`, { method: 'POST', body: '{}' }),
  regenerateSteps: (id) =>
    request(`/api/tickets/${id}/troubleshooting`, { method: 'POST', body: '{}' }),
  getAudit: (id) => request(`/api/tickets/${id}/audit`),

  // --- analytics / system ---------------------------------------------
  analytics: () => request('/api/analytics/overview'),
  users: (role) => request(`/api/users${qs({ role })}`),
  health: () => request('/api/health'),
  kb: () => request('/api/kb'),
}

export const api = import.meta.env.VITE_DEMO === 'true' ? demoApi : realApi

export default api
