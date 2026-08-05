import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { analyseRecording, DEVICE_SAMPLE_RATE_HZ } from '../lib/dsp';
import { legacyDoshaFull, legacyDoshaProfile } from '../lib/dsp-legacy';
import { DoshaBars, WaveformCanvas, WaveformDetail, SdptgCanvas, KvGrid } from './Common';

const fx = (v, d = 1, u = '') => (Number.isFinite(v) ? v.toFixed(d) + u : '—');
const when = (d) => (d ? new Date(d).toLocaleString() : '—');

export default function History({ onLog }) {
  const [patients, setPatients] = useState([]);
  const [search, setSearch] = useState('');
  const [selPatient, setSelPatient] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [selSession, setSelSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

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
    setSelPatient(p); setSelSession(null); setBusy(true); setError(null);
    try {
      const r = await api.listSessions({ patient: p._id, limit: 100 });
      setSessions(r.items);
      onLog?.(`Loaded ${r.items.length} stored session(s) for ${p.patientId}.`);
    } catch (e) {
      setError(e.message); onLog?.(e.message, 'error');
    } finally { setBusy(false); }
  };

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
            hr: reanalysed.hrv?.hr ?? full.device?.hrBpm ?? null,
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
        <section className="panel">
          <h2>Sessions — {selPatient.patientId}</h2>
          <KvGrid rows={{
            'name': selPatient.name || '—',
            'age': selPatient.age,
            'gender': selPatient.gender,
            'weight (kg)': selPatient.weightKg,
            'height (cm)': selPatient.heightCm,
            'BMI': selPatient.bmi ?? '—',
            'special state': selPatient.specialState || 'none',
            'stage': selPatient.stateDetail || '—',
          }} />

          {sessions.length === 0
            ? <p className="hint">No stored recordings for this patient.</p>
            : (
              <div className="table-wrap" style={{ marginTop: 14 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Recorded</th><th>Fs (Hz)</th><th>Samples</th>
                      <th>HR</th><th>RMSSD</th><th>SDNN</th><th>LF/HF</th>
                      <th>V / P / K</th><th>Conf</th><th>Algorithm</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => {
                      const c = s.computed || {};
                      const ok = Number.isFinite(c.vata);
                      return (
                        <tr key={s._id} className={selSession?._id === s._id ? 'sel' : ''}>
                          <td className="dim">{when(s.recordedAt)}</td>
                          <td className={s.sampleRateHz < 20 ? 'bad' : ''}>{s.sampleRateHz}</td>
                          <td>{s.waveformSampleCount}</td>
                          <td>{fx(c.hrBpm)}</td>
                          <td>{fx(c.rmssdMs)}</td>
                          <td>{fx(c.sdnnMs)}</td>
                          <td>{fx(c.lfhf, 2)}</td>
                          <td className="mono">
                            {ok ? `${c.vata} / ${c.pitta} / ${c.kapha}` : <span className="dim">not measurable</span>}
                          </td>
                          <td>{c.confidence ?? '—'}</td>
                          <td className="mono dim">{s.algorithm || 'sdptg'}</td>
                          <td className="row-btns tight">
                            <button onClick={() => openSession(s)}>View</button>
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

      {/* ---------- one stored session in full ---------- */}
      {selSession && (
        <>
          <section className="panel">
            <h2>Recording — {when(selSession.recordedAt)}</h2>

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
              <span className="hint" style={{ margin: 0 }}>
                One window at a time against a time axis, at a scale where individual pulses are visible.
              </span>
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
            <h2>Comparison</h2>
            <div className="compare-grid">
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

              <div className="compare-col">
                <div className="col-head ours">Our calculation</div>
                <div className="col-sub">
                  Re-computed just now from the stored raw waveform, so algorithm improvements apply
                  retroactively to old recordings.
                </div>
                <Row k="Heart rate" v={fx(selSession.reanalysed?.hrv?.hr, 1, ' bpm')} />
                <Row k="SpO₂" v={fx(selSession.device?.spo2, 1, ' % (device)')} />
                <Row k="RMSSD" v={fx(selSession.reanalysed?.hrv?.rmssd)} />
                <Row k="SDNN" v={fx(selSession.reanalysed?.hrv?.sdnn)} />
                <Row k="LF/HF" v={fx(selSession.reanalysed?.hrv?.lfhf, 2)} />
                <div className="sec">
                  Dosha
                  {selSession.reanalysed?.vascular &&
                    <span className="conf">conf. {selSession.reanalysed.vascular.confidence}</span>}
                </div>
                <DoshaBars
                  vata={selSession.reanalysed?.vascular?.vata}
                  pitta={selSession.reanalysed?.vascular?.pitta}
                  kapha={selSession.reanalysed?.vascular?.kapha} />
                {!selSession.reanalysed?.vascular && (
                  <div className="col-note err">
                    Not measurable: {selSession.reanalysed?.unavailableReason
                      || selSession.computed?.unavailableReason || 'insufficient data'}.
                  </div>
                )}
              </div>
            </div>

            {selSession.legacy && selSession.reanalysed && (
              <div className="algo-compare">
                <div className="sec">All three algorithms, re-run on this stored recording</div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Algorithm</th><th>Vata</th><th>Pitta</th><th>Kapha</th><th>Conf</th>
                          <th>Stored at scan time</th></tr>
                    </thead>
                    <tbody>
                      {[['sdptg', 'SDPTG (new)', selSession.reanalysed.vascular],
                        ['legacy-full', 'Legacy — with vitals', selSession.legacy['legacy-full']],
                        ['legacy-profile', 'Legacy — no vitals', selSession.legacy['legacy-profile']]
                      ].map(([key, label, r]) => {
                        const stored = selSession.allAlgorithms?.[key];
                        return (
                          <tr key={key} className={selSession.algorithm === key ? 'sel' : ''}>
                            <td>{label}{selSession.algorithm === key && <span className="dim"> (selected)</span>}</td>
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

            {/* stored-vs-now, which reveals whether the algorithm has changed */}
            {Number.isFinite(selSession.computed?.vata) && selSession.reanalysed?.vascular && (
              <div className="delta-box">
                <div>
                  <b>Stored at scan time</b> {selSession.computed.vata} / {selSession.computed.pitta} / {selSession.computed.kapha}
                  &nbsp;·&nbsp; <b>re-computed now</b> {selSession.reanalysed.vascular.vata} / {selSession.reanalysed.vascular.pitta} / {selSession.reanalysed.vascular.kapha}
                </div>
                <div className="dim">
                  A difference here means the analysis code changed since this recording was stored. The raw
                  waveform is the source of truth, which is why it is kept.
                </div>
              </div>
            )}
          </section>

          {selSession.reanalysed?.vascular && (
            <section className="panel">
              <h2>Measured pulse-wave indices</h2>
              <KvGrid rows={{
                'sample rate (Hz)': selSession.reanalysed.sampleRateHz,
                'beats detected': selSession.reanalysed.beats.length,
                'cycles averaged': selSession.reanalysed.vascular.quality.cycles_used,
                'alignment quality': selSession.reanalysed.vascular.quality.alignment_quality,
                'cycle length (ms)': selSession.reanalysed.vascular.morphology.cycle_ms,
                'crest time (ms)': selSession.reanalysed.vascular.morphology.crest_time_ms,
                'b/a': selSession.reanalysed.vascular.sdptg.b_a,
                'c/a': selSession.reanalysed.vascular.sdptg.c_a,
                'd/a': selSession.reanalysed.vascular.sdptg.d_a,
                'e/a': selSession.reanalysed.vascular.sdptg.e_a,
                'aging index': selSession.reanalysed.vascular.sdptg.aging_index,
              }} />
              <div className="sec">SDPTG — second derivative</div>
              <SdptgCanvas
                curve={selSession.reanalysed.vascular.sdptgCurve}
                sdptg={selSession.reanalysed.vascular.sdptg} />
            </section>
          )}
        </>
      )}

      {busy && <div className="alert">Loading…</div>}
    </div>
  );
}

function Row({ k, v }) {
  return <div className="stat-row"><span className="k">{k}</span><span className="v">{v}</span></div>;
}
