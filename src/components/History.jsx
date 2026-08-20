import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { analyseRecording, DEVICE_SAMPLE_RATE_HZ } from '../lib/dsp';
import { legacyDoshaFull, legacyDoshaProfile } from '../lib/dsp-legacy';
import { DoshaBars, WaveformCanvas, WaveformDetail, HrvReliability, KvGrid } from './Common';

const fx = (v, d = 1, u = '') => (Number.isFinite(v) ? v.toFixed(d) + u : '—');
const when = (d) => (d ? new Date(d).toLocaleString() : '—');

// Which method the headline panel reports, matching the results screen. The
// table lower down still runs both on the same stored waveform. The key is the
// stored database value and must match ALGORITHMS in App.jsx; the label is
// display only.
const HEADLINE_KEY = 'legacy-full';
const HEADLINE_LABEL = 'Using heart rate & SpO₂';
const ALT_LABEL = 'Profile only, no heart rate or SpO₂';

export default function History({ onLog }) {
  const [patients, setPatients] = useState([]);
  const [search, setSearch] = useState('');
  const [selPatient, setSelPatient] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [selSession, setSelSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(false);
  const [idDraft, setIdDraft] = useState('');

  // Scrolled into view whenever their section first appears, so opening a
  // patient/session actually shows it instead of leaving the page wherever it
  // was and requiring a manual scroll down to notice anything changed.
  const patientPanelRef = useRef(null);
  const sessionPanelRef = useRef(null);
  useEffect(() => {
    if (selPatient) patientPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selPatient?._id]);
  useEffect(() => {
    if (selSession) sessionPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selSession?._id]);

  const loadPatients = useCallback(async (q = '') => {
    setBusy(true); setError(null);
    try {
      setPatients(await api.listPatients(q));
    } catch (e) {
      setError(e.message); onLog?.(e.message, 'error');
    } finally { setBusy(false); }
  }, [onLog]);

  useEffect(() => { loadPatients(); }, [loadPatients]);

  const openPatient = async (p) => {
    setSelPatient(p); setSelSession(null); setBusy(true); setError(null); setEditingId(false);
    try {
      const r = await api.listSessions({ patient: p._id, limit: 100 });
      setSessions(r.items);
      onLog?.(`Loaded ${r.items.length} stored session(s) for ${p.patientId}.`);
      // Leave the session table unopened — the user picks which recording to
      // view rather than one being auto-selected for them.
    } catch (e) {
      setError(e.message); onLog?.(e.message, 'error');
    } finally { setBusy(false); }
  };

  // Deselects the patient entirely, collapsing back to just the patients table.
  const closePatient = () => {
    setSelPatient(null); setSessions([]); setSelSession(null); setEditingId(false);
  };

  // Clears just the opened session, keeping the patient panel and session list.
  const closeSession = () => setSelSession(null);

  // The list endpoint deliberately omits the waveform (30 KB per row), so it is
  // fetched only when a specific session is opened.
  const openSession = async (row) => {
    setBusy(true); setError(null);
    try {
      const full = await api.getSession(row._id, true);
      const wf = full.waveform || [];
      // Sessions stored before the duration fix have a hardcoded 300000ms even
      // when the bulk transfer truncated, so their stored rate is a fiction
      // (2201 samples "over 300s" = 7.34Hz) and the 20Hz gate refuses them. The
      // waveform itself was sampled at 50Hz, so re-analyse at its true span —
      // this is exactly the retroactive correction keeping the raw data buys.
      const trueDurationMs = Math.round((wf.length / DEVICE_SAMPLE_RATE_HZ) * 1000);
      const durationSuspect = Math.abs(trueDurationMs - full.durationMs) > 2000;

      // Re-run the analysis from the stored raw waveform rather than trusting
      // the stored summary. That way an improved algorithm applies retroactively
      // to every historical recording.
      const reanalysed = wf.length > 200 ? analyseRecording(wf, trueDurationMs) : null;

      // Re-run the legacy methods too, using the patient's stored profile, so a
      // historical recording can be compared across all three without re-scanning.
      let legacy = null;
      if (reanalysed && full.patient) {
        const p = full.patient;
        const args = {
          age: p.age, gender: p.gender, weightKg: p.weightKg, heightCm: p.heightCm,
          waveform: wf, durationMs: trueDurationMs,
        };
        legacy = {
          'legacy-full': legacyDoshaFull({
            ...args,
            // As stored from the device, not re-derived from the beat series.
            hr: full.device?.hrBpm ?? null,
            spo2: full.device?.spo2 ?? null,
          }),
          'legacy-profile': legacyDoshaProfile(args),
        };
      }
      setSelSession({ ...full, waveform: wf, reanalysed, legacy, trueDurationMs, durationSuspect });
      onLog?.(`Opened session ${row._id} — ${wf.length} samples, re-analysed from raw.`);
      if (durationSuspect) {
        onLog?.(
          `Stored duration ${(full.durationMs / 1000).toFixed(0)}s disagrees with ${wf.length} samples at ` +
          `${DEVICE_SAMPLE_RATE_HZ}Hz (${(trueDurationMs / 1000).toFixed(0)}s) — this was a truncated ` +
          `transfer. Re-analysed at the true span.`,
          'warn'
        );
      }
    } catch (e) {
      setError(e.message); onLog?.(e.message, 'error');
    } finally { setBusy(false); }
  };

  const removeSession = async (id) => {
    if (!confirm('Delete this session permanently?')) return;
    try {
      await api.deleteSession(id);
      setSessions((s) => s.filter((x) => x._id !== id));
      if (selSession?._id === id) setSelSession(null);
      onLog?.('Session deleted.', 'warn');
    } catch (e) { onLog?.(e.message, 'error'); }
  };

  // Clears this patient's recordings and KEEPS the patient, so the same person
  // can be re-scanned without re-entering their profile.
  const clearSessions = async () => {
    if (!confirm(
      `Delete all ${sessions.length} recording(s) for patient ${selPatient.patientId}?\n\n`
      + 'The raw waveforms go with them and cannot be recovered. The patient record itself is kept.'
    )) return;
    try {
      const r = await api.deletePatientSessions(selPatient._id);
      setSessions([]);
      setSelSession(null);
      // sessionCount is shown in the patients table; keep it honest without a refetch.
      setPatients((ps) => ps.map((p) => (p._id === selPatient._id ? { ...p, sessionCount: 0, lastScan: null } : p)));
      onLog?.(`Deleted ${r.sessionsDeleted} recording(s) for ${selPatient.patientId}.`, 'warn');
    } catch (e) { setError(e.message); onLog?.(e.message, 'error'); }
  };

  // Deletes the patient AND their recordings. Scoped to this one patient — no
  // other patient's data is touched.
  const removePatient = async () => {
    if (!confirm(
      `Delete patient ${selPatient.patientId}${selPatient.name ? ` (${selPatient.name})` : ''} entirely?\n\n`
      + `The profile and all ${sessions.length} recording(s) are removed and cannot be recovered. `
      + 'No other patient is affected.'
    )) return;
    try {
      const r = await api.deletePatient(selPatient._id);
      const gone = selPatient.patientId;
      setPatients((ps) => ps.filter((p) => p._id !== selPatient._id));
      setSelPatient(null); setSessions([]); setSelSession(null);
      onLog?.(`Deleted patient ${gone} and ${r.sessionsDeleted} recording(s).`, 'warn');
    } catch (e) { setError(e.message); onLog?.(e.message, 'error'); }
  };

  const startEditId = () => { setIdDraft(selPatient.patientId); setEditingId(true); };
  const cancelEditId = () => setEditingId(false);

  // Renames the patient's human-facing ID. The backend keeps every stored
  // session's denormalised patientId in sync, so the history list stays
  // consistent without a refetch here.
  const saveEditId = async () => {
    const next = idDraft.trim();
    if (!next) { onLog?.('Patient ID cannot be empty.', 'error'); return; }
    if (next === selPatient.patientId) { setEditingId(false); return; }
    const prev = selPatient.patientId;
    try {
      const updated = await api.updatePatientId(selPatient._id, next);
      setSelPatient(updated);
      setPatients((ps) => ps.map((p) => (p._id === updated._id ? { ...p, patientId: updated.patientId } : p)));
      setEditingId(false);
      onLog?.(`Patient ID changed from ${prev} to ${updated.patientId}.`);
    } catch (e) {
      setError(e.message); onLog?.(e.message, 'error');
    }
  };

  // The headline dosha figures. Falls back to null so the "not measurable" note
  // shows rather than three dashes with no explanation.
  const headline = selSession?.legacy?.[HEADLINE_KEY] ?? null;

  return (
    <div className="history">
      {error && <div className="alert err">{error}</div>}

      {/* ---------- patients ---------- */}
      <section className="panel">
        <h2>Stored patients</h2>
        <div className="row-btns">
          <input
            placeholder="Search by patient ID or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadPatients(search)}
          />
          <button onClick={() => loadPatients(search)}>Search</button>
          <button onClick={() => { setSearch(''); loadPatients(''); }}>Reset</button>
        </div>

        {patients.length === 0 && !busy && (
          <p className="hint">No patients stored yet. Run a scan to create one.</p>
        )}

        {patients.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Patient ID</th><th>Name</th><th>Age</th><th>Sex</th>
                  <th>BMI</th><th>Scans</th><th>Last scan</th><th />
                </tr>
              </thead>
              <tbody>
                {patients.map((p) => (
                  <tr key={p._id} className={selPatient?._id === p._id ? 'sel' : ''}>
                    <td className="mono">{p.patientId}</td>
                    <td>{p.name || '—'}</td>
                    <td>{p.age}</td>
                    <td>{p.gender}</td>
                    <td>{p.bmi ?? '—'}</td>
                    <td>{p.sessionCount}</td>
                    <td className="dim">{when(p.lastScan)}</td>
                    <td><button onClick={() => openPatient(p)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------- that patient's sessions ---------- */}
      {selPatient && (
        <section className="panel" ref={patientPanelRef}>
          <h2>
            Sessions —{' '}
            {editingId ? (
              <span className="row-btns tight" style={{ display: 'inline-flex', verticalAlign: 'middle' }}>
                <input
                  className="mono"
                  value={idDraft}
                  autoFocus
                  onChange={(e) => setIdDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEditId();
                    if (e.key === 'Escape') cancelEditId();
                  }}
                  style={{ width: 140 }}
                />
                <button className="primary" onClick={saveEditId}>Save</button>
                <button onClick={cancelEditId}>Cancel</button>
              </span>
            ) : (
              <span className="row-btns tight" style={{ display: 'inline-flex', verticalAlign: 'middle' }}>
                <span className="mono">{selPatient.patientId}</span>
                <button onClick={startEditId} title="Change this patient's ID">Edit ID</button>
              </span>
            )}
          </h2>
          <KvGrid rows={{
            'name': selPatient.name || '—',
            'age': selPatient.age,
            'gender': selPatient.gender,
            'weight (kg)': selPatient.weightKg,
            'height (cm)': selPatient.heightCm,
            'BMI': selPatient.bmi ?? '—',
            // "special state" and its "stage" detail are not shown. They are a
            // pair — stage only means anything alongside a special state — so
            // dropping one would leave a dangling detail field. Both are still
            // stored on the patient and still sent to the device in the profile.
          }} />

          <div className="row-btns" style={{ marginTop: 12 }}>
            <button className="danger" onClick={clearSessions} disabled={sessions.length === 0}>
              Delete {sessions.length} recording{sessions.length === 1 ? '' : 's'}
            </button>
            <button className="danger" onClick={removePatient}>Delete patient entirely</button>
            <button onClick={closePatient}>Close</button>
            <span className="hint" style={{ margin: 0 }}>
              The first keeps the patient so they can be re-scanned; the second removes the profile too.
            </span>
          </div>
        </section>
      )}

      {/* ---------- one stored session in full — rendered above the sessions
          table itself, so opening a recording shows it right away instead of
          requiring a scroll past every other session first ---------- */}
      {selSession && (
        <>
          <section className="panel" ref={sessionPanelRef}>
            <h2 className="row-btns" style={{ justifyContent: 'space-between' }}>
              <span>Recording — {when(selSession.recordedAt)}</span>
              <button onClick={closeSession}>Close</button>
            </h2>

            {selSession.durationSuspect && (
              <div className="alert warn">
                <strong>Truncated transfer, corrected.</strong> This session was stored as{' '}
                {selSession.waveformSampleCount} samples over {(selSession.durationMs / 1000).toFixed(0)}s, which
                works out to {selSession.sampleRateHz} Hz — a fiction, because the duration was hardcoded to
                300&nbsp;s while the bulk transfer only delivered part of the waveform. The samples themselves
                were captured at {DEVICE_SAMPLE_RATE_HZ} Hz, so the columns below are re-analysed over their true{' '}
                {(selSession.trueDurationMs / 1000).toFixed(0)}s span. The <em>stored</em> figures were refused at
                scan time by the 20&nbsp;Hz gate and stay blank.
              </div>
            )}
            {!selSession.durationSuspect && selSession.sampleRateHz < 20 && (
              <div className="alert err">
                This recording was captured at {selSession.sampleRateHz} Hz. Below about 20 Hz the beat timing is
                quantised too coarsely for HRV or second-derivative analysis, so the derived values were refused
                at the time and remain unavailable.
              </div>
            )}
            {selSession.gapCount > 0 && (
              <div className="alert warn">
                {selSession.gapCount} gap marker(s) were removed from this recording — the finger came off
                mid-session, so the trace below is discontinuous at those points.
              </div>
            )}

            <WaveformCanvas
              data={selSession.waveform}
              beats={selSession.reanalysed?.beats}
              height={140}
            />
            <p className="hint">
              {selSession.waveformSampleCount} samples over{' '}
              {((selSession.trueDurationMs ?? selSession.durationMs) / 1000).toFixed(0)}s
              &nbsp;·&nbsp; {selSession.reanalysed?.sampleRateHz ?? selSession.sampleRateHz} Hz
              &nbsp;·&nbsp; <a href={api.waveformCsvUrl(selSession._id)}>download CSV</a>
            </p>

            <div className="row-btns" style={{ marginTop: 10 }}>
              <button className={showDetail ? 'primary' : ''} onClick={() => setShowDetail((v) => !v)}>
                {showDetail ? 'Hide detailed waveform' : 'Show detailed waveform'}
              </button>
            </div>

            {showDetail && (
              <WaveformDetail
                data={selSession.waveform}
                beats={selSession.reanalysed?.beats}
                sampleRateHz={selSession.reanalysed?.sampleRateHz || DEVICE_SAMPLE_RATE_HZ}
                height={300}
              />
            )}
          </section>

          <section className="panel">
            <h2>Results</h2>
            <div className="compare-grid single">
              {/* Device column hidden — showing computed values only. The stored
                  session still carries selSession.device untouched, so restoring
                  this block brings the comparison back with no other change.
              <div className="compare-col">
                <div className="col-head dev">Device calculation</div>
                <div className="col-sub">As stored from the firmware at scan time.</div>
                <Row k="Heart rate" v={fx(selSession.device?.hrBpm, 1, ' bpm')} />
                <Row k="SpO₂" v={fx(selSession.device?.spo2, 1, ' %')} />
                <Row k="BMI" v={fx(selSession.device?.bmi, 1)} />
                <Row k="RMSSD" v={fx(selSession.device?.rmssdMs)} />
                <Row k="SDNN" v={fx(selSession.device?.sdnnMs)} />
                <Row k="LF/HF" v={fx(selSession.device?.lfhf, 2)} />
                <div className="sec">Dosha</div>
                <DoshaBars
                  vata={selSession.device?.vata} pitta={selSession.device?.pitta}
                  kapha={selSession.device?.kapha} />
              </div>
              */}

              <div className="compare-col">
                <div className="col-head ours">{HEADLINE_LABEL}</div>
                <div className="col-sub">
                  Re-computed just now from the stored raw waveform, so algorithm improvements apply
                  retroactively to old recordings. HR, RMSSD, SDNN and LF/HF come from the beat series and are
                  the same whichever dosha method is selected.
                </div>
                <Row k="Heart rate" v={fx(selSession.device?.hrBpm, 1, ' bpm (device)')} />
                <Row k="SpO₂" v={fx(selSession.device?.spo2, 1, ' % (device)')} />
                <Row k="RMSSD" v={fx(selSession.reanalysed?.hrv?.rmssd)} />
                <Row k="SDNN" v={fx(selSession.reanalysed?.hrv?.sdnn)} />
                <Row k="LF/HF" v={fx(selSession.reanalysed?.hrv?.lfhf, 2)} />
                <HrvReliability hrv={selSession.reanalysed?.hrv} />
                <div className="sec">
                  Dosha <span className="dim">— {HEADLINE_LABEL}</span>
                  {headline && <span className="conf">conf. {headline.confidence}</span>}
                </div>
                <DoshaBars vata={headline?.vata} pitta={headline?.pitta} kapha={headline?.kapha} />
                {!headline && (
                  <div className="col-note err">
                    Not measurable: {selSession.reanalysed?.unavailableReason
                      || selSession.computed?.unavailableReason || 'insufficient data'}.
                  </div>
                )}
              </div>
            </div>

            {selSession.legacy && selSession.reanalysed && (
              <div className="algo-compare">
                <div className="sec">Both methods, re-run on this stored recording</div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Algorithm</th><th>Vata</th><th>Pitta</th><th>Kapha</th><th>Conf</th>
                          <th>Stored at scan time</th></tr>
                    </thead>
                    <tbody>
                      {[['legacy-full', HEADLINE_LABEL, selSession.legacy['legacy-full']],
                        ['legacy-profile', ALT_LABEL, selSession.legacy['legacy-profile']]
                      ].map(([key, label, r]) => {
                        const stored = selSession.allAlgorithms?.[key];
                        return (
                          // Two different things were being conflated by one
                          // "(selected)" marker: the method shown in the panel
                          // above (always HEADLINE_KEY) and the one that happened
                          // to be selected when this session was recorded, which
                          // for older sessions is a method the app no longer uses.
                          <tr key={key} className={key === HEADLINE_KEY ? 'sel' : ''}>
                            <td>
                              {label}
                              {key === HEADLINE_KEY && <span className="dim"> (shown above)</span>}
                              {selSession.algorithm === key && key !== HEADLINE_KEY &&
                                <span className="dim"> (used when this scan was taken)</span>}
                            </td>
                            {r
                              ? <>
                                  <td className="mono">{r.vata}</td>
                                  <td className="mono">{r.pitta}</td>
                                  <td className="mono">{r.kapha}</td>
                                  <td className="mono">{r.confidence}</td>
                                </>
                              : <td colSpan={4} className="dim">not measurable</td>}
                            <td className="mono dim">
                              {Number.isFinite(stored?.vata)
                                ? `${stored.vata} / ${stored.pitta} / ${stored.kapha}`
                                : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="hint">
                  Re-computed from the stored raw waveform. A difference against the stored column means the
                  analysis code changed since this recording was taken — which is exactly why the raw waveform
                  is kept rather than only the summary.
                </p>
              </div>
            )}

            {/* stored-vs-now, which reveals whether the analysis code has changed */}
            {Number.isFinite(selSession.computed?.vata) && headline && (
              <div className="delta-box">
                <div>
                  <b>Stored at scan time</b> {selSession.computed.vata} / {selSession.computed.pitta} / {selSession.computed.kapha}
                  &nbsp;·&nbsp; <b>re-computed now</b> {headline.vata} / {headline.pitta} / {headline.kapha}
                </div>
                <div className="dim">
                  A difference here means the analysis code changed since this recording was stored — including
                  the removal of SDPTG, which is what older sessions were scanned with. The raw waveform is the
                  source of truth, which is why it is kept.
                </div>
              </div>
            )}
          </section>

          {selSession.reanalysed && (
            <section className="panel">
              <h2>Measured signal quality</h2>
              <KvGrid rows={{
                'sample rate (Hz)': selSession.reanalysed.sampleRateHz,
                'samples': selSession.reanalysed.sampleCount,
                'beats detected': selSession.reanalysed.beats.length,
                'intervals total': selSession.reanalysed.hrv?.rrTotal ?? '—',
                'outside 30-200bpm': selSession.reanalysed.hrv?.rrOutOfBand ?? '—',
                'rejected vs local median': selSession.reanalysed.hrv?.rrRejected ?? '—',
                'intervals used': selSession.reanalysed.hrv?.rrCount ?? '—',
                'discarded total': selSession.reanalysed.hrv?.rrDiscardedPct != null
                  ? `${selSession.reanalysed.hrv.rrDiscardedPct}%` : '—',
                'gap markers removed': selSession.gapCount ?? 0,
              }} />
            </section>
          )}
        </>
      )}

      {/* ---------- that patient's sessions table ---------- */}
      {selPatient && (
        <section className="panel">
          <h2>Recordings</h2>
          {sessions.length === 0
            ? <p className="hint">No stored recordings for this patient.</p>
            : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Recorded</th><th>Fs (Hz)</th><th>Samples</th>
                      <th>HR</th><th>SpO₂</th><th>RMSSD</th><th>SDNN</th><th>LF/HF</th>
                      <th>V / P / K</th><th>Conf</th><th>Algorithm</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => {
                      const c = s.computed || {};
                      // computed.* holds whichever method was SELECTED when the
                      // scan was taken, so older rows carry SDPTG figures. Every
                      // session also stores all three under allAlgorithms, so the
                      // headline method can be shown consistently across rows
                      // without re-fetching waveforms the list endpoint omits.
                      const head = s.allAlgorithms?.[HEADLINE_KEY];
                      const d = head || c;
                      const ok = Number.isFinite(d.vata);
                      const fellBack = !head && Number.isFinite(c.vata);
                      return (
                        <tr
                          key={s._id}
                          className={'clickable' + (selSession?._id === s._id ? ' sel' : '')}
                          onClick={() => openSession(s)}
                          title="Show this recording in full"
                        >
                          <td className="dim">{when(s.recordedAt)}</td>
                          <td className={s.sampleRateHz < 20 ? 'bad' : ''}>{s.sampleRateHz}</td>
                          <td>{s.waveformSampleCount}</td>
                          {/* HR and SpO2 come from s.device, which is what the
                              firmware sent. computed.hrBpm on older rows was
                              re-derived from the waveform, so reading device
                              keeps the column consistent across all sessions. */}
                          <td>{fx(s.device?.hrBpm)}</td>
                          <td>{fx(s.device?.spo2)}</td>
                          <td>{fx(c.rmssdMs)}</td>
                          <td>{fx(c.sdnnMs)}</td>
                          <td>{fx(c.lfhf, 2)}</td>
                          <td className="mono">
                            {ok ? `${d.vata} / ${d.pitta} / ${d.kapha}` : <span className="dim">not measurable</span>}
                          </td>
                          <td>{d.confidence ?? '—'}</td>
                          <td className="mono dim" title={fellBack
                            ? `This session predates the change and stored no ${HEADLINE_KEY} result, so its selected-at-scan-time figures (${s.algorithm || 'sdptg'}) are shown instead.`
                            : HEADLINE_LABEL}>
                            {head ? HEADLINE_LABEL : (s.algorithm || 'sdptg') + ' *'}
                          </td>
                          {/* The row itself opens the recording, so these stop the
                              click bubbling — otherwise deleting or downloading
                              would also re-open the row underneath. */}
                          <td className="row-btns tight" onClick={(e) => e.stopPropagation()}>
                            <a className="btn" href={api.waveformCsvUrl(s._id)}>CSV</a>
                            <button className="danger" onClick={() => removeSession(s._id)}>×</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </section>
      )}

      {busy && <div className="alert">Loading…</div>}
    </div>
  );
}

function Row({ k, v }) {
  return <div className="stat-row"><span className="k">{k}</span><span className="v">{v}</span></div>;
}
