import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TavisaDevice, isSupported } from './lib/ble';
import { analyseRecording, stripGapMarkers, DEVICE_SAMPLE_RATE_HZ } from './lib/dsp';
import { legacyDoshaFull, legacyDoshaProfile } from './lib/dsp-legacy';
import { api } from './lib/api';
import { Stepper, DoshaBars, WaveformCanvas, WaveformDetail, HrvReliability, KvGrid, LogPanel } from './components/Common';
import History from './components/History';

const SCAN_SECONDS = 300;

// The dosha methods. SDPTG has been removed, so both remaining entries are the
// legacy anchor-table approach and both are explicit about how much of their
// output comes from the typed profile rather than the pulse.
// The object KEYS are stored in the database on every session, so they must not
// change. Only the labels are renamed — "with vitals" / "no vitals" said nothing
// about which vitals or why it mattered, so each label now names the inputs that
// actually differ between the two.
export const ALGORITHMS = {
  'legacy-full': {
    label: 'Using heart rate & SpO₂',
    blurb: 'Profile, heart rate, SpO₂ and the pulse. Hand-authored anchor tables interpolated per field '
         + '(age 18, gender 5, HR 17, weight 10, height 5, SpO₂ 15→30 if <92, waveform 30). '
         + 'Typed profile carries 38%, heart rate and SpO₂ 32%, the pulse shape 30%.',
    demographicShare: 38,
  },
  'legacy-profile': {
    label: 'Profile only, no heart rate or SpO₂',
    blurb: 'The same anchor tables with heart rate and SpO₂ removed and their 32% redistributed to the typed '
         + 'fields (age 25, gender 10, weight 20, height 15, waveform 30). The pulse still contributes only '
         + '30%, so dropping the vitals makes the result MORE dependent on the profile, not less: 70%.',
    demographicShare: 70,
  },
};
const fx = (v, d = 1, unit = '') => (Number.isFinite(v) ? v.toFixed(d) + unit : '—');

export default function App() {
  const [view, setView] = useState('history');       // history is the landing view; "New scan" switches to scan
  // Pinned to legacy-full. The picker below is commented out, so this is the
  // single method the headline panel reports; the table lower down still runs
  // both on the same recording.
  const [algo, setAlgo] = useState('legacy-full');
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
  const [scanFailed, setScanFailed] = useState(null);   // { reason } when the device aborts
  const [deviceReport, setDeviceReport] = useState(null); // the firmware's own DONE tally
  const [transferLoss, setTransferLoss] = useState(null); // samples the transfer lost vs DONE
  const [ibiSeries, setIbiSeries] = useState(null);      // the RR interval record, sent before the waveform
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

  // Device vitals are held in a ref as well as in state.
  //
  // The bug this fixes: the firmware sends HR/SpO2/dosha in the same instant it
  // finishes the bulk transfer, so those notifications land WHILE handleRecording
  // is already running. State updates re-rendered the results page — which is why
  // SpO2 appeared there — but the payload posted to the API had already been built
  // from the deviceVals captured in that callback's closure, so the stored session
  // recorded spo2: null and History had nothing to show.
  const deviceValsRef = useRef({});
  const mergeDevice = useCallback((patch) => {
    // Ref first and synchronously, so a read during an in-flight save cannot see
    // a value older than the notification that already arrived.
    deviceValsRef.current = { ...deviceValsRef.current, ...patch };
    setDeviceVals(deviceValsRef.current);
  }, []);

  // The device emits its vitals around the same moment as the end of the
  // transfer, not before it, so give them a moment to land rather than saving a
  // record with holes in it.
  const waitForDeviceVitals = useCallback(async (timeoutMs = 3000) => {
    const started = Date.now();
    const have = () => Number.isFinite(deviceValsRef.current.hrBpm)
                    && Number.isFinite(deviceValsRef.current.spo2);
    while (!have() && Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return have();
  }, []);

  // The firmware's DONE frame arrives after the transfer, so it needs the same
  // treatment as the vitals: a ref to dodge the stale closure, and a short wait.
  // It carries fs_stored and dur_s, which are the only way to know how many
  // samples SHOULD have arrived — without it a short transfer is indistinguishable
  // from a short recording.
  const deviceReportRef = useRef(null);
  const waitForDeviceReport = useCallback(async (timeoutMs = 3000) => {
    const started = Date.now();
    while (!deviceReportRef.current && Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return deviceReportRef.current;
  }, []);
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

  // Instrument the receive side, because a clean stop mid-transfer with no gaps
  // and no end marker is what a browser that stopped draining its notification
  // queue looks like from the device's side. GATT notifications are
  // unacknowledged at the protocol level, so nothing is retransmitted and neither
  // end can tell the difference from a link drop without this.
  //
  // Chrome throttles background tabs and can freeze a discarded one outright,
  // which suspends delivery to characteristicvaluechanged without firing
  // gattserverdisconnected. Logging the transitions makes that visible in the
  // same log as the chunk counts.
  useEffect(() => {
    const onVis = () => {
      addLog(
        `Page became ${document.visibilityState}` +
        (document.visibilityState === 'hidden'
          ? ' — a hidden tab may stop draining BLE notifications; keep this window in front during a transfer.'
          : '.'),
        document.visibilityState === 'hidden' ? 'warn' : 'info'
      );
    };
    const onFreeze = () => addLog('Page FROZEN by the browser — BLE delivery is suspended.', 'error');
    const onResume = () => addLog('Page resumed after being frozen; anything sent meanwhile is lost.', 'warn');
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('freeze', onFreeze);
    document.addEventListener('resume', onResume);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('freeze', onFreeze);
      document.removeEventListener('resume', onResume);
    };
  }, [addLog]);

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
    dev.on('device-hr', (hr) => mergeDevice({ hrBpm: hr }));
    dev.on('device-spo2', (v) => mergeDevice({ spo2: v }));
    dev.on('device-bmi', (v) => mergeDevice({ bmi: v }));
    dev.on('device-dosha', (v) => mergeDevice({ vata: v.vata, pitta: v.pitta, kapha: v.kapha }));
    dev.on('device-hrv', (v) => mergeDevice({ rmssdMs: v.rmssd, sdnnMs: v.sdnn, lfhf: v.lfhf }));

    dev.on('session-start', () => { setScanning(true); setStep(4); startTimer(); });
    dev.on('session-end', () => { setScanning(false); stopTimer(); });
    // The interval series precedes the waveform and is the measurement of
    // record; the waveform is for display.
    dev.on('ibi-series', (s) => {
      setIbiSeries(s);
      addLog(`Interval series received: ${s.count} intervals in ${s.packets} packet(s).`, 'ok');
    });
    dev.on('bulk-start', () => { setBulkProgress({ samples: 0, chunks: 0 }); setStalled(null); });
    dev.on('bulk-progress', (p) => setBulkProgress(p));
    dev.on('bulk-complete', ({ waveform: raw, headerFields }) => {
      setBulkProgress(null);
      handleRecordingRef.current?.(raw, headerFields);
    });
    dev.on('bulk-stalled', ({ waveform: raw, chunks, headerFields }) => {
      setBulkProgress(null);
      setStalled({ waveform: raw, chunks, headerFields });
    });

    // The firmware can abandon a scan outright and send no waveform at all. If
    // the app keeps waiting for the transfer it waits forever, with the countdown
    // still running and nothing to show — so treat this as a terminal outcome and
    // send the operator back to the profile step.
    dev.on('scan-failed', ({ reason }) => {
      setScanning(false);
      stopTimer();
      setBulkProgress(null);
      setStalled(null);
      setScanFailed({ reason });
      setStep(2);
    });

    // The firmware's own tally of the scan it just finished. Logged so its beat
    // count, artefact rate and true sample rate can be compared against ours
    // rather than inferred from a serial console.
    dev.on('scan-done', (d) => {
      const bits = [];
      if (d.beatsDetected != null) bits.push(`beats ${d.beatsAccepted}/${d.beatsDetected}`);
      if (d.artefactPct != null) bits.push(`artefact ${d.artefactPct}%`);
      if (d.fsStoredHz != null) bits.push(`stored ${d.fsStoredHz}Hz`);
      if (d.durationSec != null) bits.push(`${d.durationSec}s`);
      if (bits.length) addLog('Device reports: ' + bits.join(', ') + '.', 'ok');
      deviceReportRef.current = d;
      setDeviceReport(d);
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
  const handleRecording = useCallback(async (raw, headerFields = null) => {
    // Strip the firmware's INT16_MIN gap sentinels first: they are not samples,
    // and left in place they inflate the signal's standard deviation, which
    // shifts the beat detector's threshold.
    const { cleaned, gapCount: gaps } = stripGapMarkers(raw);
    setGapCount(gaps);
    if (gaps) addLog(`Removed ${gaps} gap marker(s) — the finger came off mid-session.`, 'warn');

    setWaveform(cleaned);

    // The device's own account of the scan, if it has arrived. fs_stored and
    // dur_s are the only source of truth for how many samples SHOULD be here;
    // deriving duration purely from the sample count makes a transfer that lost
    // data indistinguishable from a genuinely shorter recording.
    const report = await waitForDeviceReport();
    // Measured stored rate, in preference order: the bulk header's fs_acq/2,
    // then the DONE frame's fs_stored, then the compiled-in nominal. The nominal
    // is half a percent out and varies per device, so it is a last resort.
    const rateHz = headerFields?.storedRateHz || report?.fsStoredHz || DEVICE_SAMPLE_RATE_HZ;
    const expected = report?.durationSec && report?.fsStoredHz
      ? Math.round(report.durationSec * report.fsStoredHz)
      : null;

    // Duration from the sample count at the firmware's REPORTED rate, not an
    // assumed integer one: 27041 samples at an assumed 100Hz reads as a clean
    // 270.4s recording, while at the reported 99.56Hz it is 271.6s of a scan the
    // device says ran for 300s.
    const durationMs = Math.round((cleaned.length / rateHz) * 1000);

    // Where the samples went missing, which is NOT the same question as how many.
    //
    // The device stores into a heap-capped vector and feeds it from a
    // non-blocking queue, so samples can be lost before they are ever stored. The
    // transmit loop derives its start index from the chunk index every iteration,
    // so it cannot skip a chunk — a short arrival with a matching wave_points is
    // therefore a complete transfer of an incomplete recording, not a lossy link.
    //
    //   stored (header wave_points / DONE wave_points) vs received  -> transit
    //   dur_s x fs_stored              vs stored                    -> acquisition
    //
    // QF_WAVE_TRUNCATED distinguishes the heap cap from a silent queue drop.
    const stored = report?.wavePoints ?? headerFields?.wavePoints ?? null;
    if (expected && cleaned.length < expected * 0.99) {
      const missing = expected - cleaned.length;
      const inTransit = stored != null ? Math.max(0, stored - cleaned.length) : null;
      const atAcquisition = stored != null ? Math.max(0, expected - stored) : null;
      const truncated = report?.waveTruncated ?? headerFields?.waveTruncated ?? null;
      setTransferLoss({
        expected, received: cleaned.length, missing, stored, inTransit, atAcquisition, truncated,
        rateHz, missingSec: missing / rateHz, pct: +((100 * missing) / expected).toFixed(1),
      });
      addLog(
        `Short recording: ${cleaned.length} of ${expected} samples expected from ` +
        `${report.durationSec}s x ${report.fsStoredHz}Hz` +
        (stored != null ? `; the device stored ${stored}` : '') +
        `. ${missing} samples (${(missing / rateHz).toFixed(1)}s, ${((100 * missing) / expected).toFixed(1)}%) ` +
        `are absent` +
        (atAcquisition ? `, ${atAcquisition} of them never recorded` : '') +
        (inTransit ? ` and ${inTransit} lost in transit` : '') +
        `. ${truncated
          ? 'QF_WAVE_TRUNCATED is set: the device hit its heap cap.'
          : 'QF_WAVE_TRUNCATED is clear, so this is not the heap cap — most likely dropped by the '
            + 'non-blocking sample queue, or the session ended before 300s.'}`,
        'error'
      );
    } else if (!report && cleaned.length < SCAN_SECONDS * rateHz * 0.95) {
      // No DONE frame to check against, so fall back to the nominal scan length.
      addLog(
        `Partial recording: ${cleaned.length} of ~${SCAN_SECONDS * rateHz} samples ` +
        `(${(durationMs / 1000).toFixed(0)}s of pulse, not ${SCAN_SECONDS}s). Analysed at ` +
        `${rateHz}Hz — shorter recordings widen the HRV confidence interval, and LF/HF needs 60s of beats.`,
        'warn'
      );
    }
    const result = analyseRecording(cleaned, durationMs);

    // Wait for the vitals BEFORE they are needed. legacy-full weights heart rate
    // at 17% and SpO2 at 15%, so computing it early substitutes anchor-table
    // defaults for two measured inputs and quietly costs 15 confidence points.
    const gotVitals = await waitForDeviceVitals();
    const dv = deviceValsRef.current;
    if (!gotVitals) {
      addLog(
        `Device HR/SpO₂ did not arrive within 3s (HR ${fx(dv.hrBpm)}, SpO₂ ${fx(dv.spo2)}) — ` +
        `storing without them, so the dosha result loses those inputs.`,
        'warn'
      );
    }

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
        // Heart rate is taken as the device reports it, not re-derived from the
        // beat series. RMSSD/SDNN/LF-HF still come from the waveform, since the
        // device does not transmit an interval series to take them from.
        hr: dv.hrBpm ?? null,
        spo2: dv.spo2 ?? null,
      }),
      'legacy-profile': legacyDoshaProfile(profileArgs),
    };
    setAnalysis(result);

    addLog(
      `Analysed ${result.sampleCount} samples at ${result.sampleRateHz}Hz — ${result.beats.length} beats.`,
      'ok'
    );
    if (result.hrv?.rmssd != null) {
      addLog(`HRV from waveform — RMSSD ${fx(result.hrv.rmssd)}ms, SDNN ${fx(result.hrv.sdnn)}ms. HR ${fx(dv.hrBpm)}bpm, SpO₂ ${fx(dv.spo2)}% from the device.`, 'ok');
    } else if (result.hrv?.reason) {
      addLog('HRV not measurable — ' + result.hrv.reason, 'warn');
    }
    if (result.unavailableReason) {
      addLog('Waveform analysis limited — ' + result.unavailableReason, 'warn');
    }
    const head = result.legacy?.[algo];
    if (head) {
      addLog(`Dosha (${ALGORITHMS[algo].label}) — V ${head.vata} P ${head.pitta} K ${head.kapha} (conf ${head.confidence}).`, 'ok');
    }

    setStep(5);
    await persist(cleaned, durationMs, result, gaps);
    // deviceVals is deliberately NOT a dependency — vitals are read through the
    // ref, so this callback no longer needs rebuilding on every notification.
  }, [addLog, savedPatient, form, waitForDeviceVitals]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the refs the BLE listeners read pointed at the current closures.
  useEffect(() => { handleRecordingRef.current = handleRecording; }, [handleRecording]);
  useEffect(() => { scanningRef.current = scanning; }, [scanning]);

  const persist = async (wf, durationMs, result, gaps) => {
    if (!savedPatient) { setSaveState({ ok: false, msg: 'No patient record — nothing saved.' }); return; }
    setSaveState({ pending: true });
    try {
      // computed.* records the SELECTED method's dosha, which is now always one
      // of the legacy pair. The sdptg sub-document is no longer written; old
      // sessions keep theirs, since the schema still accepts it.
      const v = result.legacy?.[algo] || null;
      const saved = await api.saveSession({
        patient: savedPatient._id,
        durationMs,
        waveform: wf,
        gapCount: gaps,
        computed: {
          // Read from the ref, not from state: a notification that arrived while
          // this save was being assembled is already in the ref, but would not be
          // in the deviceVals this closure captured.
          hrBpm: deviceValsRef.current.hrBpm ?? null,
          rmssdMs: result.hrv?.rmssd ?? null,
          sdnnMs: result.hrv?.sdnn ?? null,
          lfhf: result.hrv?.lfhf ?? null,
          beatsDetected: result.beats.length,
          rrAccepted: result.hrv?.rrCount ?? null,
          vata: v?.vata ?? null,
          pitta: v?.pitta ?? null,
          kapha: v?.kapha ?? null,
          confidence: v?.confidence ?? null,
          unavailableReason: result.unavailableReason || result.hrv?.reason || null,
        },
        device: deviceValsRef.current,
        algorithm: algo,
        allAlgorithms: {
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
    // Resending the profile is the first half of recovering from an aborted scan,
    // so clear the failure notice here rather than leaving it up through the retry.
    setScanFailed(null);
    setDeviceReport(null);
    try {
      const patient = await api.savePatient({ ...form, biomarkers: biomarkersForSave(bio) });
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
      // The device wire protocol needs actual numbers regardless of what's
      // stored, so zeros still go out over the air when skipped.
      const devicePayload = skip ? {} : numericBio(bio);
      await devRef.current.sendBiomarkers(devicePayload);
      if (skip) addLog('Biomarkers skipped — zeros sent so the device can proceed.', 'warn');
      if (savedPatient && !skip) {
        const p = await api.savePatient({ ...form, biomarkers: biomarkersForSave(bio) });
        setSavedPatient(p);
      }
      setStep(4);
    } catch (e) {
      addLog(e.message, 'error');
    }
  };

  const startNewScan = () => {
    // Clear the ref alongside the state, or the next scan inherits the previous
    // patient's vitals if the device is slow to send its own.
    deviceValsRef.current = {};
    setAnalysis(null); setWaveform(null); setDeviceVals({});
    setSaveState(null); setGapCount(0); setStalled(null); setBulkProgress(null);
    setScanFailed(null); setDeviceReport(null); setTransferLoss(null); setIbiSeries(null);
    deviceReportRef.current = null; setStep(2);
  };

  // ---- derived ----------------------------------------------------------
  const bmi = useMemo(() => {
    const w = Number(form.weightKg), h = Number(form.heightCm);
    return w > 0 && h > 0 ? +(w / Math.pow(h / 100, 2)).toFixed(1) : null;
  }, [form.weightKg, form.heightCm]);

  // Resolve the selected algorithm to a single {vata,pitta,kapha,confidence}.
  const selected = useMemo(() => {
    if (!analysis) return null;
    return analysis.legacy?.[algo] || null;
  }, [analysis, algo]);

  // Retained for the commented-out device comparison below; nothing renders it
  // while that block is hidden.
  const delta = useMemo(() => buildDelta(deviceVals, analysis?.hrv, selected), [deviceVals, analysis, selected]);

  // =====================================================================
  return (
    <div className="wrap">
      <header>
        <div>
          <div className="mark">TAVISA <span>Console</span></div>
          <div className="tag">
            {apiOk === false && <span className="pill err">API offline</span>}
            {apiOk === true && <span className="pill ok">API online</span>}
          </div>
        </div>
        <div className="header-right">
          {/* History first — it is the landing view. */}
          <button className={view === 'history' ? 'primary' : ''} onClick={() => setView('history')}>History</button>
          <button className={view === 'scan' ? 'primary' : ''} onClick={() => setView('scan')}>New scan</button>
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
              {scanFailed && (
                <div className="alert err">
                  <strong>The device aborted the scan: {scanFailed.reason}.</strong> No waveform was recorded, so
                  there is nothing to salvage.
                  {scanFailed.reason === 'TOO_NOISY' && (
                    <> The signal was too noisy to measure — usually finger movement, too light a touch, or cold
                    hands. Have the patient rest their hand flat and hold still before starting again.</>
                  )}
                  <div className="hint" style={{ marginTop: 8 }}>
                    The firmware discarded the profile and biomarkers along with the aborted session, so both must
                    be sent again: <b>Save &amp; send profile</b> below, then the biomarkers step, then rescan.
                  </div>
                </div>
              )}
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
                  arrived in {stalled.chunks} chunks, then nothing.
                  {stalled.headerFields?.wavePoints != null ? (
                    <> The device said it had stored {stalled.headerFields.wavePoints} samples, so{' '}
                    {Math.round((stalled.waveform.length / stalled.headerFields.wavePoints) * 100)}% came
                    through and <b>{stalled.headerFields.wavePoints - stalled.waveform.length} recorded samples
                    were never sent</b>. That is loss on the link or a transmit loop exiting early — not samples
                    the device failed to record{stalled.headerFields.qflags === 0 && ', and qflags is 0 so it is '
                    + 'not the heap cap'}.</>
                  ) : (
                    <> No bulk header arrived, so there is nothing to reconcile the count against.</>
                  )}
                  {stalled.gaps > 0 && (
                    <> {stalled.gaps} chunk(s) also went missing mid-stream, from a gap in the chunk index.</>
                  )}
                  <div className="hint" style={{ marginTop: 8 }}>
                    The device sends its end marker only after the chunk loop completes, so if it reported DONE
                    the marker was transmitted and this end did not receive it. Check that this window stayed in
                    front for the whole transfer — a hidden or frozen tab stops draining BLE notifications, which
                    looks exactly like this: a clean stop, no scattered gaps, no end marker.
                  </div>
                  {ibiSeries && (
                    <div className="alert" style={{ marginTop: 8 }}>
                      <strong>The interval series arrived intact — {ibiSeries.count} intervals.</strong> That is
                      the record RMSSD, SDNN and LF/HF come from, over the full session. The waveform is for
                      display, so discarding this partial one loses nothing measurable.
                    </div>
                  )}
                  <div className="row-btns" style={{ marginTop: 10 }}>
                    <button
                      className="primary"
                      onClick={() => { const w = stalled.waveform, h = stalled.headerFields; setStalled(null); handleRecording(w, h); }}
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
                <h2>Results</h2>
                <div className="compare-grid single">
                  {/* Device column hidden — showing computed values only.
                      deviceVals is still received, logged and stored with the
                      session, so restoring this block brings the comparison back
                      with no other change.
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
                  */}

                  <div className="compare-col">
                    <div className="col-head ours">
                      {ALGORITHMS[algo].label}
                      {/* Algorithm picker hidden while the headline is pinned to one method.
                      <select className="algo-select" value={algo} onChange={(e) => setAlgo(e.target.value)}>
                        {Object.entries(ALGORITHMS).map(([k, a]) =>
                          <option key={k} value={k}>{a.label}</option>)}
                      </select>
                      */}
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
                    <Row k="Heart rate" v={fx(deviceVals.hrBpm, 1, ' bpm (device)')} />
                    <Row k="SpO₂" v={fx(deviceVals.spo2, 1, ' % (device)')} />
                    <Row k="BMI" v={bmi ?? '—'} />
                    <div className="sec">HRV</div>
                    <Row k="RMSSD" v={fx(analysis?.hrv?.rmssd)} />
                    <Row k="SDNN" v={fx(analysis?.hrv?.sdnn)} />
                    <Row k="LF/HF" v={fx(analysis?.hrv?.lfhf, 2)} />
                    <HrvReliability hrv={analysis?.hrv} />
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

                {/* Device-vs-ours agreement box hidden along with the device column —
                    every line in it is a comparison against a value no longer shown.
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
                */}

                {analysis && (
                  <div className="algo-compare">
                    <div className="sec">Both methods on this same recording</div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr><th>Algorithm</th><th>Vata</th><th>Pitta</th><th>Kapha</th>
                              <th>Conf</th><th>From demographics</th></tr>
                        </thead>
                        <tbody>
                          {Object.entries(ALGORITHMS).map(([k, a]) => {
                            const r = analysis.legacy?.[k];
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
                      Same waveform, same profile, both methods. The rightmost column is how much of each
                      result comes from the typed profile rather than the pulse.
                    </p>
                  </div>
                )}

                {saveState && (
                  <div className={'alert ' + (saveState.ok ? 'ok' : saveState.pending ? '' : 'err')}>
                    {saveState.pending ? 'Saving session…' : saveState.msg}
                  </div>
                )}
              </section>

              {analysis && (
                <section className="panel">
                  <h2>{deviceReport ? 'Signal quality — as reported by the device' : 'Measured signal quality'}</h2>
                  {transferLoss && (
                    <div className="alert err">
                      <strong>{transferLoss.pct}% of the recording is missing.</strong>{' '}
                      A {deviceReport?.durationSec}s scan at {deviceReport?.fsStoredHz}&nbsp;Hz should be{' '}
                      {transferLoss.expected} samples;{' '}
                      {transferLoss.stored != null && <>the device stored {transferLoss.stored} and </>}
                      {transferLoss.received} arrived.
                      {transferLoss.atAcquisition > 0 && (
                        <> <b>{transferLoss.atAcquisition} were never recorded</b> — lost at acquisition, before
                        any transfer.{' '}
                        {transferLoss.truncated
                          ? 'QF_WAVE_TRUNCATED is set: the device hit its heap cap for the waveform buffer.'
                          : 'QF_WAVE_TRUNCATED is clear, so this is not the heap cap — most likely the '
                            + 'non-blocking sample queue dropping under load, or a session that ended early.'}</>
                      )}
                      {transferLoss.inTransit > 0 && (
                        <> {transferLoss.inTransit} were stored but did not arrive.</>
                      )}
                      {' '}Every figure below describes the {(analysis.durationMs / 1000).toFixed(1)}s that is
                      present, which is why the app's counts read lower than the device's.
                    </div>
                  )}
                  {deviceReport && (
                    <div className="delta-box" style={{ marginTop: 0, marginBottom: 12 }}>
                      <div>
                        <b>Device</b> {deviceReport.beatsAccepted}/{deviceReport.beatsDetected} intervals kept,
                        artefact {deviceReport.artefactPct}%
                        {Number.isFinite(deviceVals.rmssdMs) && <> · RMSSD {fx(deviceVals.rmssdMs)}ms</>}
                        {Number.isFinite(deviceVals.sdnnMs) && <> · SDNN {fx(deviceVals.sdnnMs)}ms</>}
                        {Number.isFinite(deviceVals.lfhf) && <> · LF/HF {fx(deviceVals.lfhf, 2)}</>}
                        <br />
                        <b>App</b> {analysis.hrv?.rrCount}/{analysis.hrv?.rrTotal} intervals kept,
                        discarded {analysis.hrv?.rrDiscardedPct}%
                        {Number.isFinite(analysis.hrv?.rmssd) && <> · RMSSD {fx(analysis.hrv.rmssd)}ms</>}
                        {Number.isFinite(analysis.hrv?.sdnn) && <> · SDNN {fx(analysis.hrv.sdnn)}ms</>}
                        {Number.isFinite(analysis.hrv?.lfhf) && <> · LF/HF {fx(analysis.hrv.lfhf, 2)}</>}
                      </div>
                      <div className="dim">
                        Two independent interval series with two different accept rules, so these will not match.
                        The device detects beats on the {deviceReport.fsAcqHz}&nbsp;Hz acquired stream and applies
                        its own criterion; the app re-derives intervals from the {deviceReport.fsStoredHz}&nbsp;Hz
                        stored waveform and rejects anything more than 30% from its local median. The device's
                        interval series is the measurement of record — once its 3-byte record format is known the
                        app will report from that instead, and there will be one set of numbers rather than two.
                      </div>
                    </div>
                  )}
                  {/* The device's own tally is the measurement of record, so it is
                      what this panel reports. The app's re-derived counts remain in
                      the comparison box above; they are a cross-check, not the
                      figures to read off. Falls back to the computed values only
                      when no DONE frame arrived. */}
                  {deviceReport ? (
                    <KvGrid rows={{
                      'sample rate (Hz)': deviceReport.fsStoredHz ?? '—',
                      'acquisition rate (Hz)': deviceReport.fsAcqHz ?? '—',
                      'duration (s)': deviceReport.durationSec ?? '—',
                      'intervals detected': deviceReport.beatsDetected ?? '—',
                      'intervals accepted': deviceReport.beatsAccepted ?? '—',
                      'artefact': deviceReport.artefactPct != null ? `${deviceReport.artefactPct}%` : '—',
                      'qflags': deviceReport.qflags != null
                        ? `${deviceReport.qflags}${deviceReport.waveTruncated ? ' (WAVE TRUNCATED)' : ''}`
                        : '—',
                      'samples received': analysis.sampleCount,
                      ...(transferLoss ? { 'samples expected': transferLoss.expected } : {}),
                      'gap markers removed': gapCount,
                    }} />
                  ) : (
                    <>
                      <KvGrid rows={{
                        'sample rate (Hz)': analysis.sampleRateHz,
                        'samples': analysis.sampleCount,
                        'beats detected': analysis.beats.length,
                        'intervals total': analysis.hrv?.rrTotal ?? '—',
                        'outside 30-200bpm': analysis.hrv?.rrOutOfBand ?? '—',
                        'rejected vs local median': analysis.hrv?.rrRejected ?? '—',
                        'intervals used': analysis.hrv?.rrCount ?? '—',
                        'discarded total': analysis.hrv?.rrDiscardedPct != null
                          ? `${analysis.hrv.rrDiscardedPct}%` : '—',
                        'gap markers removed': gapCount,
                      }} />
                      <p className="hint">
                        No status frame arrived from the device, so these are the app's own counts re-derived from
                        the waveform rather than the device's report.
                      </p>
                    </>
                  )}
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
// For persisting to the database — a blank field means "not entered", not a
// clinical zero (0 cholesterol, 0 HbA1c, …), so it's stored as null instead of
// being coerced to 0. Only used for api.savePatient; the device still gets
// numericBio()'s zeros above, because the firmware protocol requires a number.
function biomarkersForSave(bio) {
  const val = (v) => {
    const n = Number(v);
    return v === '' || v == null || !Number.isFinite(n) ? null : n;
  };
  return {
    hba1c: val(bio.hba1c),
    totalChol: val(bio.totalChol),
    ldl: val(bio.ldl),
    hdl: val(bio.hdl),
    crp: val(bio.crp),
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
