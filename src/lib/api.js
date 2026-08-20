// Thin fetch wrapper. Base URL comes from Vite env so the same build can point
// at a local or deployed API.
const BASE = import.meta.env?.VITE_API_URL || 'http://localhost:4000';

async function req(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // A network-level failure here almost always means the API isn't running,
    // so say that rather than surfacing "Failed to fetch".
    throw new Error(`Cannot reach the API at ${BASE}. Is the server running?`);
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!res.ok) {
    const msg = (data && data.error) || `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return data;
}

export const api = {
  health: () => req('GET', '/api/health'),

  listPatients: (search = '') =>
    req('GET', '/api/patients' + (search ? `?search=${encodeURIComponent(search)}` : '')),
  getPatient: (id) => req('GET', `/api/patients/${id}`),
  savePatient: (patient) => req('POST', '/api/patients', patient),
  renamePatient: (id, name) => req('PATCH', `/api/patients/${id}`, { name }),
  updatePatientId: (id, patientId) => req('PATCH', `/api/patients/${id}`, { patientId }),
  deletePatient: (id) => req('DELETE', `/api/patients/${id}`),
  deletePatientSessions: (id) => req('DELETE', `/api/patients/${id}/sessions`),

  listSessions: (params = {}) => {
    const q = new URLSearchParams();
    if (params.patient) q.set('patient', params.patient);
    if (params.patientId) q.set('patientId', params.patientId);
    if (params.limit) q.set('limit', params.limit);
    if (params.page) q.set('page', params.page);
    const s = q.toString();
    return req('GET', '/api/sessions' + (s ? '?' + s : ''));
  },
  getSession: (id, withWaveform = false) =>
    req('GET', `/api/sessions/${id}` + (withWaveform ? '?waveform=1' : '')),
  saveSession: (session) => req('POST', '/api/sessions', session),
  deleteSession: (id) => req('DELETE', `/api/sessions/${id}`),
  trend: (id) => req('GET', `/api/sessions/${id}/trend`),
  waveformCsvUrl: (id) => `${BASE}/api/sessions/${id}/waveform.csv`,
};

export { BASE as API_BASE };
