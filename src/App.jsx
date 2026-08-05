import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TavisaDevice, isSupported } from './lib/ble';
import { analyseRecording, stripGapMarkers, DEVICE_SAMPLE_RATE_HZ } from './lib/dsp';
import { legacyDoshaFull, legacyDoshaProfile } from './lib/dsp-legacy';
import { api } from './lib/api';
import { Stepper, DoshaBars, WaveformCanvas, WaveformDetail, SdptgCanvas, KvGrid, LogPanel } from './components/Common';
import History from './components/History';

const SCAN_SECONDS = 300;

// The three algorithms, so the same recording can be run through all of them.
// "sdptg" is the one to rely on; the two legacy entries exist for comparison
// and are honest about where their numbers come from.
export const ALGORITHMS = {
  sdptg: {
    label: 'SDPTG (new)',
    blurb: 'Waveform only — no demographics, no lookup tables. Cycles aligned on max dV/dt, '
         + 'ensemble-median pulse, then second-derivative ratios |b/a| → Vata, c/a → Pitta, e/a → Kapha. '
         + 'Refuses to output a value if it cannot measure.',
    demographicShare: 0,
  },
  'legacy-full': {
    label: 'Legacy — with vitals',
    blurb: 'age, gender, weight, height, HR, SpO₂ + FFT absolute frequency bands. Hand-authored anchor '
         + 'tables interpolated per field (age 18, gender 5, HR 17, weight 10, height 5, SpO₂ 15→30 if <92, '
         + 'waveform 30). Demographics carry 38% of the result.',
    demographicShare: 38,
  },
  'legacy-profile': {
    label: 'Legacy — no vitals',
    blurb: 'Same anchor tables with HR and SpO₂ removed, their weight redistributed '
         + '(age 25, gender 10, weight 20, height 15, waveform 30). Demographics carry 70% of the result.',
    demographicShare: 70,
  },
};
const fx = (v, d = 1, unit = '') => (Number.isFinite(v) ? v.toFixed(d) + unit : '—');

export default function App() {
  const [view, setView] = useState('scan');          // scan | history
  const [algo, setAlgo] = useState('sdptg');         // which algorithm drives the result
  const [step, setStep] = useState(1);
  const [log, setLog] = useState([]);
  const [status, setStatus] = useState('idle');      // idle | connected | error
  const [connecting, setConnecting] = useState(false);
  const [missingChars, setMissingChars] = useState([]);
  const [apiOk, setApiOk] = useState(null);

  // patient form
  const [form, setForm] = useState({
    patientId: '', name: '', age: 30, gender: 'male',
    weightKg: 70, heightCm: 170, specialState: '', stateDetail: '',
  });
  const [bio, setBio] = useState({ hba1c: '', totalChol: '', ldl: '', hdl: '', crp: '' });
  const [savedPatient, setSavedPatient] = useState(null);

  // scan state
  const [scanning, setScanning] = useState(false);
  const [remaining, setRemaining] = useState(SCAN_SECONDS);
  const [overtime, setOvertime] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null);
  const [stalled, setStalled] = useState(null);      // partial waveform, transfer died

  // results
  const [deviceVals, setDeviceVals] = useState({});
  const [analysis, setAnalysis] = useState(null);
  const [waveform, setWaveform] = useState(null);
  const [gapCount, setGapCount] = useState(0);
  const [showDetail, setShowDetail] = useState(false);
  const [saveState, setSaveState] = useState(null);

  const devRef = useRef(null);
  // A ref, not just the `connecting` state: two clicks in the same tick both see
  // the pre-render state value, and one overlapping connect is enough to strand
  // the live GATT link behind a dead device object.
  const connectingRef = useRef(false);
  const timerRef = useRef(null);
  // BLE listeners are registered once, at connect time, so they close over that
  // render's values forever. Anything they read must come through a ref or they
  // see the state as it was before the profile was ever filled in.
  const handleRecordingRef = useRef(null);
  const scanningRef = useRef(false);
  const scanStartRef = useRef(0);

  const addLog = useCallback((message, level = 'info') => {
    setLog((l) => [...l, { message, level, at: new Date() }]);
  }, []);

  useEffect(() => {
    api.health()
      .then((h) => { setApiOk(true); addLog(`API reachable, database ${h.db}.`, 'ok'); })
      .catch((e) => { setApiOk(false); addLog(e.message, 'error'); });
  }, [addLog]);

  // ---- timer ------------------------------------------------------------
  const startTimer = useCallback(() => {
    clearInterval(timerRef.current);
    scanStartRef.current = Date.now();
    setOvertime(false);
    timerRef.current = setInterval(() => {
      const left = Math.ceil(SCAN_SECONDS - (Date.now() - scanStartRef.current) / 1000);
      setRemaining(left);
      // The device pauses its own countdown whenever the finger lifts, so wall
      // clock can legitimately exceed 300s. A 3s grace avoids a false alarm
      // caused by racing the end marker, which arrives in the same second.
      if (left < -3) setOvertime(true);
    }, 250);
  }, []);

  const stopTimer = useCallback(() => {
    clearInterval(timerRef.current);
    timerRef.current = null;
    setRemaining(SCAN_SECONDS);
    setOvertime(false);
  }, []);

  useEffect(() => () => clearInterval(timerRef.current), []);

  // ---- connect ----------------------------------------------------------
  const connect = async () => {
    if (connectingRef.current) {
      addLog('Already connecting — waiting for the current attempt to finish.', 'warn');
      return;
    }
    connectingRef.current = true;
    setConnecting(true);

    // Drop any previous link first, otherwise a second connect leaves the old
    // GATT session open and still notifying while the UI tracks the new object.
    if (devRef.current) await devRef.current.disconnect().catch(() => {});
    devRef.current = null;

    const dev = new TavisaDevice();

    dev.on('log', ({ message, level }) => addLog(message, level));
    dev.on('device-hr', (hr) => setDeviceVals((d) => ({ ...d, hrBpm: hr })));
    dev.on('device-spo2', (v) => setDeviceVals((d) => ({ ...d, spo2: v })));
    dev.on('device-bmi', (v) => setDeviceVals((d) => ({ ...d, bmi: v })));
    dev.on('device-dosha', (v) => setDeviceVals((d) => ({ ...d, ...{ vata: v.vata, pitta: v.pitta, kapha: v.kapha } })));
    dev.on('device-hrv', (v) => setDeviceVals((d) => ({ ...d, rmssdMs: v.rmssd, sdnnMs: v.sdnn, lfhf: v.lfhf })));

    dev.on('session-start', () => { setScanning(true); setStep(4); startTimer(); });
    dev.on('session-end', () => { setScanning(false); stopTimer(); });
    dev.on('bulk-start', () => { setBulkProgress({ samples: 0, chunks: 0 }); setStalled(null); });
    dev.on('bulk-progress', (p) => setBulkProgress(p));
    dev.on('bulk-complete', ({ waveform: raw }) => {
      setBulkProgress(null);
      handleRecordingRef.current?.(raw);
    });
    dev.on('bulk-stalled', ({ waveform: raw, chunks }) => {
      setBulkProgress(null);
      setStalled({ waveform: raw, chunks });
    });

    dev.on('disconnected', () => {
      setStatus('error');
      if (scanningRef.current) {
        const secs = Math.round((Date.now() - scanStartRef.current) / 1000);
        addLog(
          `Device disconnected ${secs}s into the ${SCAN_SECONDS}s scan — the recording was lost. ` +
          `This is a device-side dropout, most often low battery: the firmware deep-sleeps at <=10% ` +
          `and restarts itself if it detects charging while a low-battery warning is showing.`,
          'error'
        );
      }
      setScanning(false);
      stopTimer();
    });

    try {
      const { missing } = await dev.connect();
      // Only publish the instance once its characteristics are discovered — a
      // half-built device here is what makes writes fail with "did not expose
      // the userdata characteristic" on an apparently connected device.
      devRef.current = dev;
      setMissingChars(missing);
      setStatus('connected');
      if (missing.length === 0) setStep(2);
      else addLog(`Cannot proceed: missing ${missing.join(', ')}. This is a firmware GATT problem.`, 'error');
    } catch (e) {
      await dev.disconnect().catch(() => {});
      setStatus('error');
      addLog(e.message, 'error');
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    await devRef.current?.disconnect();
    devRef.current = null;
    setStatus('idle');
    setStep(1);
  };

  // ---- recording analysis + save ---------------------------------------
  const handleRecording = useCallback(async (raw) => {
    // Strip the firmware's INT16_MIN gap sentinels first: they are not samples,
    // and left in place they inflate the signal's standard deviation, which
    // shifts the beat detector's threshold.
    const { cleaned, gapCount: gaps } = stripGapMarkers(raw);
    setGapCount(gaps);
    if (gaps) addLog(`Removed ${gaps} gap marker(s) — the finger came off mid-session.`, 'warn');

    setWaveform(cleaned);
    // Duration comes from the sample count at the firmware's rate, NOT from a
    // hardcoded 300s. Asserting 300s for a truncated transfer is what produced
    // sessions labelled "2201 samples over 300s" -> 7.34Hz -> refused by the
    // 20Hz gate. The samples that did arrive were captured at 50Hz regardless of
    // how many of them made it, so this is the honest span; a full scan still
    // works out to exactly 300s.
    const durationMs = Math.round((cleaned.length / DEVICE_SAMPLE_RATE_HZ) * 1000);
    if (cleaned.length < SCAN_SECONDS * DEVICE_SAMPLE_RATE_HZ * 0.95) {
      addLog(
        `Partial recording: ${cleaned.length} of ~${SCAN_SECONDS * DEVICE_SAMPLE_RATE_HZ} samples ` +
        `(${(durationMs / 1000).toFixed(0)}s of pulse, not ${SCAN_SECONDS}s). Analysed at its true ` +
        `${DEVICE_SAMPLE_RATE_HZ}Hz — shorter recordings widen the HRV confidence interval, and LF/HF ` +
        `needs 60s of beats.`,
        'warn'
      );
    }
    const result = analyseRecording(cleaned, durationMs);

    // Every algorithm is run on the same recording, so switching between them
    // on the results screen never requires a re-scan.
    const profileArgs = {
      age: Number(form.age), gender: form.gender,
      weightKg: Number(form.weightKg), heightCm: Number(form.heightCm),
      waveform: cleaned, durationMs,
    };
    result.legacy = {
      'legacy-full': legacyDoshaFull({
        ...profileArgs,
        hr: result.hrv?.hr ?? deviceVals.hrBpm ?? null,
        spo2: deviceVals.spo2 ?? null,
      }),
      'legacy-profile': legacyDoshaProfile(profileArgs),
    };
    setAnalysis(result);

    addLog(
      `Analysed ${result.sampleCount} samples at ${result.sampleRateHz}Hz — ${result.beats.length} beats.`,
      'ok'
    );
    if (result.hrv?.rmssd != null) {
      addLog(`HRV from waveform — HR ${fx(result.hrv.hr)}bpm, RMSSD ${fx(result.hrv.rmssd)}ms, SDNN ${fx(result.hrv.sdnn)}ms.`, 'ok');
    } else if (result.hrv?.reason) {
      addLog('HRV not measurable — ' + result.hrv.reason, 'warn');
    }
    if (result.vascular) {
      addLog(`Vascular — V ${result.vascular.vata} P ${result.vascular.pitta} K ${result.vascular.kapha} (conf ${result.vascular.confidence}).`, 'ok');
    } else if (result.unavailableReason) {
      addLog('Vascular analysis not measurable — ' + result.unavailableReason, 'warn');
    }

    setStep(5);
    await persist(cleaned, durationMs, result, gaps);
  }, [addLog, savedPatient, deviceVals, form]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the refs the BLE listeners read pointed at the current closures.
  useEffect(() => { handleRecordingRef.current = handleRecording; }, [handleRecording]);
  useEffect(() => { scanningRef.current = scanning; }, [scanning]);

  const persist = async (wf, durationMs, result, gaps) => {
    if (!savedPatient) { setSaveState({ ok: false, msg: 'No patient record — nothing saved.' }); return; }
    setSaveState({ pending: true });
    try {
      const v = result.vascular;
      const saved = await api.saveSession({
        patient: savedPatient._id,
        durationMs,
        waveform: wf,
        gapCount: gaps,
        computed: {
          hrBpm: result.hrv?.hr ?? null,
          rmssdMs: result.hrv?.rmssd ?? null,
          sdnnMs: result.hrv?.sdnn ?? null,
          lfhf: result.hrv?.lfhf ?? null,
          beatsDetected: result.beats.length,
          rrAccepted: result.hrv?.rrCount ?? null,
          vata: v?.vata ?? null,
          pitta: v?.pitta ?? null,
          kapha: v?.kapha ?? null,
          confidence: v?.confidence ?? null,
          sdptg: v ? {
            b_a: v.sdptg.b_a, c_a: v.sdptg.c_a, d_a: v.sdptg.d_a, e_a: v.sdptg.e_a,
            agingIndex: v.sdptg.aging_index, crestTimeMs: v.morphology.crest_time_ms,
            cyclesUsed: v.quality.cycles_used, alignmentQuality: v.quality.alignment_quality,
          } : {},
          unavailableReason: result.unavailableReason || result.hrv?.reason || null,
        },
        device: deviceVals,
        algorithm: algo,
        allAlgorithms: {
          sdptg: v ? { vata: v.vata, pitta: v.pitta, kapha: v.kapha, confidence: v.confidence } : null,
          'legacy-full': result.legacy?.['legacy-full']
            ? { vata: result.legacy['legacy-full'].vata, pitta: result.legacy['legacy-full'].pitta,
                kapha: result.legacy['legacy-full'].kapha, confidence: result.legacy['legacy-full'].confidence }
            : null,
          'legacy-profile': result.legacy?.['legacy-profile']
            ? { vata: result.legacy['legacy-profile'].vata, pitta: result.legacy['legacy-profile'].pitta,
                kapha: result.legacy['legacy-profile'].kapha, confidence: result.legacy['legacy-profile'].confidence }
            : null,
        },
      });
      setSaveState({ ok: true, msg: 'Session saved.', id: saved._id });
      addLog('Session stored in the database.', 'ok');
    } catch (e) {
      setSaveState({ ok: false, msg: e.message });
      addLog('Could not save session: ' + e.message, 'error');
    }
  };

  // ---- step actions -----------------------------------------------------
  const sendProfile = async () => {
    if (!form.patientId.trim()) { addLog('Patient ID is required.', 'error'); return; }
    // Check the link before touching the API: otherwise every retry re-saves the
    // patient before failing on the write, which is what filled the log with
    // duplicate "Patient 1001 saved" lines.
    if (!devRef.current?.connected) {
      addLog('No connected device — reconnect before sending the profile.', 'error');
      setStatus('error');
      return;
    }
    try {
      const patient = await api.savePatient({ ...form, biomarkers: numericBio(bio) });
      setSavedPatient(patient);
      addLog(`Patient ${patient.patientId} saved (BMI ${patient.bmi}).`, 'ok');
      await devRef.current.sendProfile(form);
      setStep(3);
    } catch (e) {
      addLog(e.message, 'error');
    }
  };

  const sendBiomarkers = async (skip) => {
    if (!devRef.current?.connected) {
      addLog('No connected device — reconnect before sending biomarkers.', 'error');
      setStatus('error');
      return;
    }
    try {
      const payload = skip ? {} : numericBio(bio);
      await devRef.current.sendBiomarkers(payload);
      if (skip) addLog('Biomarkers skipped — zeros sent so the device can proceed.', 'warn');
      if (savedPatient && !skip) {
        const p = await api.savePatient({ ...form, biomarkers: payload });
        setSavedPatient(p);
      }
      setStep(4);
    } catch (e) {
      addLog(e.message, 'error');
    }
  };

  const startNewScan = () => {
    setAnalysis(null); setWaveform(null); setDeviceVals({});
    setSaveState(null); setGapCount(0); setStalled(null); setBulkProgress(null); setStep(2);
  };

  // ---- derived ----------------------------------------------------------
  const bmi = useMemo(() => {
    const w = Number(form.weightKg), h = Number(form.heightCm);
    return w > 0 && h > 0 ? +(w / Math.pow(h / 100, 2)).toFixed(1) : null;
  }, [form.weightKg, form.heightCm]);

  // Resolve the selected algorithm to a single {vata,pitta,kapha,confidence}.
  const selected = useMemo(() => {
    if (!analysis) return null;
    if (algo === 'sdptg') return analysis.vascular
      ? { ...analysis.vascular, algorithm: 'sdptg' }
      : { unavailable: true, reason: analysis.unavailableReason };
    return analysis.legacy?.[algo] || null;
  }, [analysis, algo]);

  const delta = useMemo(() => buildDelta(deviceVals, analysis?.hrv, selected), [deviceVals, analysis, selected]);

  // =====================================================================
  return (
    <div className="wrap">
      <header>
        <div>
          <div className="mark">TAVISA <span>Console</span></div>
          <div className="tag">
            // REACT + NODE + MONGODB
            {apiOk === false && <span className="pill err">API offline</span>}
            {apiOk === true && <span className="pill ok">API online</span>}
          </div>
        </div>
        <div className="header-right">
          <button className={view === 'scan' ? 'primary' : ''} onClick={() => setView('scan')}>New scan</button>
          <button className={view === 'history' ? 'primary' : ''} onClick={() => setView('history')}>History</button>
          {status === 'connected'
            ? <button onClick={disconnect}>Disconnect</button>
            : <span className={'pill ' + (status === 'error' ? 'err' : '')}>
                {status === 'error' ? 'Disconnected' : 'Not connected'}
              </span>}
        </div>
      </header>

      {view === 'history' ? (
        <History onLog={addLog} />
      ) : (
        <>
          <Stepper current={step} onJump={setStep} />

          {/* ---------------- STEP 1 : CONNECT ---------------- */}
          {step === 1 && (
            <section className="panel">
              <h2>Connect the device</h2>
              {!isSupported() && (
                <div className="alert err">
                  Web Bluetooth is unavailable in this browser. Use Chrome or Edge on desktop, or Chrome on
                  Android, served over <code>https://</code> or from <code>localhost</code>.
                </div>
              )}
              <p className="hint">
                Every measurement comes from the device. Power on the TAVISA, then connect — the wizard will
                walk through profile, biomarkers, the 300&nbsp;second recording, and the results.
              </p>
              <button
                className="primary big"
                onClick={connect}
                disabled={!isSupported() || connecting || status === 'connected'}
              >
                {connecting ? 'Connecting…' : status === 'connected' ? 'Connected' : 'Connect device'}
              </button>
              {missingChars.length > 0 && (
                <div className="alert err">
                  The device did not expose: {missingChars.join(', ')}. That is a firmware GATT table problem —
                  the service needs enough attribute handles for all seven characteristics.
                </div>
              )}
            </section>
          )}

          {/* ---------------- STEP 2 : PROFILE ---------------- */}
          {step === 2 && (
            <section className="panel">
              <h2>Patient profile</h2>
              <div className="grid4">
                <Field label="Patient ID *">
                  <input value={form.patientId} placeholder="e.g. S001"
                         onChange={(e) => setForm({ ...form, patientId: e.target.value })} />
                </Field>
                <Field label="Name">
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </Field>
                <Field label="Age">
                  <input type="number" value={form.age}
                         onChange={(e) => setForm({ ...form, age: e.target.value })} />
                </Field>
                <Field label="Gender">
                  <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                  </select>
                </Field>
                <Field label="Weight (kg)">
                  <input type="number" step="0.1" value={form.weightKg}
                         onChange={(e) => setForm({ ...form, weightKg: e.target.value })} />
                </Field>
                <Field label="Height (cm)">
                  <input type="number" step="0.1" value={form.heightCm}
                         onChange={(e) => setForm({ ...form, heightCm: e.target.value })} />
                </Field>
                <Field label="BMI (derived)">
                  <input value={bmi ?? '—'} readOnly className="readonly" />
                </Field>
                <Field label="Special state">
                  <select value={form.specialState}
                          onChange={(e) => setForm({ ...form, specialState: e.target.value, stateDetail: '' })}>
                    <option value="">None</option>
                    <option value="general wellness">General wellness</option>
                    <option value="pregnancy care">Pregnancy care</option>
                    <option value="menopausal wellness">Menopausal wellness</option>
                  </select>
                </Field>
              </div>

              {(form.specialState === 'pregnancy care' || form.specialState === 'menopausal wellness') && (
                <Field label="Stage (required — the device rejects the whole profile without it)">
                  <select value={form.stateDetail}
                          onChange={(e) => setForm({ ...form, stateDetail: e.target.value })}>
                    <option value="">— select —</option>
                    {form.specialState === 'pregnancy care'
                      ? ['first trimester', 'second trimester', 'third trimester'].map((o) =>
                          <option key={o} value={o}>{o}</option>)
                      : ['early stage', 'late stage'].map((o) =>
                          <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
              )}

              <button className="primary big" onClick={sendProfile}>Save &amp; send profile →</button>
              <p className="hint">
                Saved to the database and written to the device. The firmware requires the profile before
                biomarkers, and matches the state strings exactly.
              </p>
            </section>
          )}

          {/* ---------------- STEP 3 : BIOMARKERS ---------------- */}
          {step === 3 && (
            <section className="panel">
              <h2>Biomarkers</h2>
              <div className="grid4">
                {[['hba1c', 'HbA1c (%)'], ['totalChol', 'Total cholesterol'], ['ldl', 'LDL'],
                  ['hdl', 'HDL'], ['crp', 'CRP']].map(([k, lbl]) => (
                  <Field label={lbl} key={k}>
                    <input type="number" step="0.1" value={bio[k]} placeholder="optional"
                           onChange={(e) => setBio({ ...bio, [k]: e.target.value })} />
                  </Field>
                ))}
              </div>
              <div className="row-btns">
                <button className="primary" onClick={() => sendBiomarkers(false)}>Send biomarkers →</button>
                <button onClick={() => sendBiomarkers(true)}>Skip</button>
              </div>
              <p className="hint">
                These do not affect anything this app computes — they are stored with the patient and forwarded
                because the firmware waits for them before starting. Note the device derives its own LF/HF from
                these values rather than from the pulse, which is why its LF/HF is a constant when they are skipped.
              </p>
            </section>
          )}

          {/* ---------------- STEP 4 : SCAN ---------------- */}
          {step === 4 && (
            <section className="panel">
              <h2>300 second recording</h2>
              <div className="scan-row">
                <div className={'timer' + (overtime ? ' warn' : '')}>
                  {overtime ? `+${Math.abs(remaining)}s` : `${Math.max(0, remaining)}s`}
                </div>
                <div>
                  <div className="mono dim">{scanning ? 'Recording' : 'Waiting for the device'}</div>
                  <div className="hint">
                    {overtime
                      ? 'Still recording. The device pauses its own countdown whenever the finger lifts, so it runs longer than 300s of wall clock.'
                      : 'Place a finger on the sensor and hold still. The device streams the full waveform when it finishes.'}
                  </div>
                </div>
              </div>
              {bulkProgress && (
                <div className="alert">
                  Receiving waveform… {bulkProgress.samples} samples ({bulkProgress.chunks} chunks)
                </div>
              )}
              {stalled && (
                <div className="alert err">
                  <strong>The device stopped sending mid-transfer.</strong> {stalled.waveform.length} samples
                  arrived in {stalled.chunks} chunks, then nothing — a 300&nbsp;s recording should be about{' '}
                  {SCAN_SECONDS * DEVICE_SAMPLE_RATE_HZ} samples, so roughly{' '}
                  {Math.round((stalled.waveform.length / (SCAN_SECONDS * DEVICE_SAMPLE_RATE_HZ)) * 100)}% came
                  through. The end marker never arrived. This is device-side: most often low battery, or the
                  firmware's transmit loop giving up under BLE congestion.
                  <div className="row-btns" style={{ marginTop: 10 }}>
                    <button
                      className="primary"
                      onClick={() => { const wf = stalled.waveform; setStalled(null); handleRecording(wf); }}
                    >
                      Analyse the partial recording anyway
                    </button>
                    <button onClick={() => setStalled(null)}>Discard</button>
                  </div>
                  <div className="hint" style={{ marginTop: 8 }}>
                    It will be analysed at its true {DEVICE_SAMPLE_RATE_HZ}&nbsp;Hz over{' '}
                    {Math.round(stalled.waveform.length / DEVICE_SAMPLE_RATE_HZ)}&nbsp;s of pulse, so RMSSD and
                    SDNN are valid if enough beats are present. LF/HF needs 60&nbsp;s of beats and will stay
                    blank below that.
                  </div>
                </div>
              )}
            </section>
          )}

          {/* ---------------- STEP 5 : RESULTS ---------------- */}
          {step === 5 && (
            <>
              <section className="panel">
                <h2>Comparison</h2>
                <div className="compare-grid">
                  <div className="compare-col">
                    <div className="col-head dev">Device calculation</div>
                    <div className="col-sub">
                      <strong>As sent over BLE by the firmware.</strong><br />
                      Fields: BMI, HR, SpO₂. Method: fixed on-device lookup table. HRV from beat-to-beat
                      intervals; LF/HF from blood biomarkers, not the pulse.
                    </div>
                    <div className="sec">Vitals</div>
                    <Row k="Heart rate" v={fx(deviceVals.hrBpm, 1, ' bpm')} />
                    <Row k="SpO₂" v={fx(deviceVals.spo2, 1, ' %')} />
                    <Row k="BMI" v={fx(deviceVals.bmi, 1)} />
                    <div className="sec">PRV / HRV</div>
                    <Row k="RMSSD" v={fx(deviceVals.rmssdMs)} />
                    <Row k="SDNN" v={fx(deviceVals.sdnnMs)} />
                    <Row k="LF/HF" v={fx(deviceVals.lfhf, 2)} />
                    <div className="sec">Dosha</div>
                    <DoshaBars vata={deviceVals.vata} pitta={deviceVals.pitta} kapha={deviceVals.kapha} />
                  </div>

                  <div className="compare-col">
                    <div className="col-head ours">
                      Our calculation
                      <select className="algo-select" value={algo} onChange={(e) => setAlgo(e.target.value)}>
                        {Object.entries(ALGORITHMS).map(([k, a]) =>
                          <option key={k} value={k}>{a.label}</option>)}
                      </select>
                    </div>
                    <div className="col-sub">
                      <strong>Computed in this page.</strong><br />
                      {ALGORITHMS[algo].blurb}
                      {ALGORITHMS[algo].demographicShare > 0 && (
                        <><br /><span className="warn-text">
                          Note: {ALGORITHMS[algo].demographicShare}% of this result comes from hand-authored
                          anchor tables keyed on the profile you typed, not from the pulse.
                        </span></>
                      )}
                    </div>
                    <div className="sec">Vitals</div>
                    <Row k="Heart rate" v={fx(analysis?.hrv?.hr, 1, ' bpm')} />
                    <Row k="SpO₂" v={fx(deviceVals.spo2, 1, ' % (device)')} />
                    <Row k="BMI" v={bmi ?? '—'} />
                    <div className="sec">HRV</div>
                    <Row k="RMSSD" v={fx(analysis?.hrv?.rmssd)} />
                    <Row k="SDNN" v={fx(analysis?.hrv?.sdnn)} />
                    <Row k="LF/HF" v={fx(analysis?.hrv?.lfhf, 2)} />
                    <div className="sec">
                      Dosha
                      {selected && !selected.unavailable &&
                        <span className="conf">conf. {selected.confidence}</span>}
                    </div>
                    <DoshaBars
                      vata={selected?.unavailable ? null : selected?.vata}
                      pitta={selected?.unavailable ? null : selected?.pitta}
                      kapha={selected?.unavailable ? null : selected?.kapha} />
                    {selected?.unavailable && (
                      <div className="col-note err">
                        Not measurable: {selected.reason}. No value shown rather than an estimated one.
                      </div>
                    )}
                  </div>
                </div>

                {delta.length > 0 && (
                  <div className="delta-box">
                    {delta.map((d, i) => <div key={i} dangerouslySetInnerHTML={{ __html: d }} />)}
                    <div className="dim">
                      The device does not normalise its dosha to 100, so compare which dosha dominates rather
                      than the absolute values. SpO₂ is device-only: the single IR channel it transmits cannot
                      yield a ratio-of-ratios calculation here.
                    </div>
                  </div>
                )}

                {analysis && (
                  <div className="algo-compare">
                    <div className="sec">All three algorithms on this same recording</div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr><th>Algorithm</th><th>Vata</th><th>Pitta</th><th>Kapha</th>
                              <th>Conf</th><th>From demographics</th></tr>
                        </thead>
                        <tbody>
                          {Object.entries(ALGORITHMS).map(([k, a]) => {
                            const r = k === 'sdptg'
                              ? (analysis.vascular || null)
                              : analysis.legacy?.[k];
                            return (
                              <tr key={k} className={k === algo ? 'sel' : ''}>
                                <td>{a.label}</td>
                                {r
                                  ? <>
                                      <td className="mono">{r.vata}</td>
                                      <td className="mono">{r.pitta}</td>
                                      <td className="mono">{r.kapha}</td>
                                      <td className="mono">{r.confidence}</td>
                                    </>
                                  : <td colSpan={4} className="dim">not measurable</td>}
                                <td className={a.demographicShare > 50 ? 'bad' : ''}>
                                  {a.demographicShare}%
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="hint">
                      Same waveform, same profile, three methods. The rightmost column is how much of each
                      result comes from the typed profile rather than the pulse — which is the honest reason
                      to prefer SDPTG.
                    </p>
                  </div>
                )}

                {saveState && (
                  <div className={'alert ' + (saveState.ok ? 'ok' : saveState.pending ? '' : 'err')}>
                    {saveState.pending ? 'Saving session…' : saveState.msg}
                  </div>
                )}
              </section>

              {analysis?.vascular && (
                <section className="panel">
                  <h2>Measured pulse-wave indices</h2>
                  <p className="hint">
                    The raw measurements the result is built from — second-derivative (SDPTG) wave ratios of the
                    ensemble-averaged pulse. No hardcoded or demographic values. If alignment quality is low or
                    few cycles were averaged, treat everything above as unreliable however precise it looks.
                  </p>
                  <KvGrid rows={{
                    'sample rate (Hz)': analysis.sampleRateHz,
                    'samples': analysis.sampleCount,
                    'beats detected': analysis.beats.length,
                    'cycles averaged': analysis.vascular.quality.cycles_used,
                    'alignment quality': analysis.vascular.quality.alignment_quality,
                    'cycle length (ms)': analysis.vascular.morphology.cycle_ms,
                    'crest time (ms)': analysis.vascular.morphology.crest_time_ms,
                    'b/a (deceleration)': analysis.vascular.sdptg.b_a,
                    'c/a (tidal wave)': analysis.vascular.sdptg.c_a,
                    'd/a (dicrotic notch)': analysis.vascular.sdptg.d_a,
                    'e/a (rebound)': analysis.vascular.sdptg.e_a,
                    'aging index': analysis.vascular.sdptg.aging_index,
                    'gap markers removed': gapCount,
                  }} />
                  <div className="sec">SDPTG — second derivative</div>
                  <SdptgCanvas curve={analysis.vascular.sdptgCurve} sdptg={analysis.vascular.sdptg} />
                  <p className="hint">
                    Confirm by eye that <b>a</b> sits on the upstroke, <b>b</b> at the systolic peak, <b>c</b> on
                    the tidal shoulder, <b>d</b> at the dicrotic notch and <b>e</b> on the rebound. If they do
                    not, the ratios above are not trustworthy.
                  </p>
                </section>
              )}

              {waveform && (
                <section className="panel">
                  <h2>Full recording</h2>
                  <WaveformCanvas data={waveform} beats={analysis?.beats} height={130} />
                  <p className="hint">
                    {waveform.length} samples over{' '}
                    {analysis ? (analysis.durationMs / 1000).toFixed(0) : SCAN_SECONDS}s
                    {analysis && ` — ${analysis.sampleRateHz} Hz`}
                    {analysis && analysis.durationMs < SCAN_SECONDS * 1000 * 0.95 && ' · partial transfer'}
                    {gapCount > 0 && ` · ${gapCount} gap marker(s) removed`}
                  </p>

                  <div className="row-btns" style={{ marginTop: 10 }}>
                    <button
                      className={showDetail ? 'primary' : ''}
                      onClick={() => setShowDetail((v) => !v)}
                    >
                      {showDetail ? 'Hide detailed waveform' : 'Show detailed waveform'}
                    </button>
                    <span className="hint" style={{ margin: 0 }}>
                      Plots one window at a time against a time axis, at a scale where individual pulses are
                      actually visible.
                    </span>
                  </div>

                  {showDetail && (
                    <WaveformDetail
                      data={waveform}
                      beats={analysis?.beats}
                      sampleRateHz={analysis?.sampleRateHz || DEVICE_SAMPLE_RATE_HZ}
                      height={300}
                    />
                  )}
                </section>
              )}

              <button className="primary big" onClick={startNewScan}>Start a new scan</button>
            </>
          )}
        </>
      )}

      <LogPanel entries={log} />
    </div>
  );
}

// ---------------------------------------------------------------------------
function Field({ label, children }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}
function Row({ k, v }) {
  return <div className="stat-row"><span className="k">{k}</span><span className="v">{v}</span></div>;
}
function numericBio(bio) {
  return {
    hba1c: Number(bio.hba1c) || 0,
    totalChol: Number(bio.totalChol) || 0,
    ldl: Number(bio.ldl) || 0,
    hdl: Number(bio.hdl) || 0,
    crp: Number(bio.crp) || 0,
  };
}

// Quantify the gap between the two columns rather than leaving it to the eye.
function buildDelta(dev, hrv, sel) {
  const out = [];
  const ourHr = hrv?.hr ?? null;
  if (Number.isFinite(dev.hrBpm) && Number.isFinite(ourHr)) {
    const d = ourHr - dev.hrBpm;
    out.push(`<b>HR</b> device ${dev.hrBpm.toFixed(1)} vs ours ${ourHr.toFixed(1)} ` +
      `<span class="${Math.abs(d) <= 3 ? 'agree' : 'differ'}">${d >= 0 ? '+' : ''}${d.toFixed(1)} bpm</span>`);
  }
  const ourR = hrv?.rmssd ?? null;
  if (Number.isFinite(dev.rmssdMs) && Number.isFinite(ourR)) {
    const d = ourR - dev.rmssdMs;
    out.push(`<b>RMSSD</b> device ${dev.rmssdMs.toFixed(1)} vs ours ${ourR.toFixed(1)} ` +
      `<span class="${Math.abs(d) <= 10 ? 'agree' : 'differ'}">${d >= 0 ? '+' : ''}${d.toFixed(1)} ms</span>`);
  }
  const v = sel && !sel.unavailable ? sel : null;
  if (Number.isFinite(dev.vata) && v) {
    const top = (a) => a.slice().sort((x, y) => y[1] - x[1])[0][0];
    const devTop = top([['Vata', dev.vata], ['Pitta', dev.pitta], ['Kapha', dev.kapha]]);
    const ourTop = top([['Vata', v.vata], ['Pitta', v.pitta], ['Kapha', v.kapha]]);
    out.push(`<b>Dominant dosha</b> device says ${devTop}, ours says ${ourTop} ` +
      `<span class="${devTop === ourTop ? 'agree' : 'differ'}">${devTop === ourTop ? 'agree' : 'disagree'}</span>`);
  }
  return out;
}
