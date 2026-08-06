// ===========================================================================
// TAVISA DSP  —  all of it validated before being ported here.
//
//   beat detection   adaptive multi-pass threshold
//   HRV              RMSSD / SDNN / HR from RR intervals, gated on sample rate
//   LF/HF            4Hz resampled tachogram -> Hanning -> DFT
//
// SDPTG (second-derivative wave ratios) has been removed. It was the only method
// here that derived dosha from pulse morphology alone; the dosha result now comes
// entirely from dsp-legacy.js, whose anchor tables are keyed on the typed
// profile. See the demographicShare each of those reports.
// ===========================================================================

// The firmware's PPG sampling rate. A complete 300s scan is 15000 samples, so a
// recording's true span is samples/50 — which is how duration must be derived
// rather than assumed, or a truncated transfer reports a fictional low rate.
export const DEVICE_SAMPLE_RATE_HZ = 50;

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; }
function std(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
}
function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function cv(a) {
  const m = mean(a);
  return (Number.isFinite(m) && m !== 0) ? std(a) / Math.abs(m) : NaN;
}

// --------------------------------------------------------------------------
// RR artifact rejection.
//
// A fixed 30-200bpm band is not enough. When the detector misses one beat the
// resulting interval is roughly TWICE its neighbours — ~1300ms among ~650ms
// intervals — which sails through a 300-2000ms band and then lands in RMSSD as
// a ~650ms successive difference. A handful of those is all it takes to push
// RMSSD past 300ms and have the whole recording refused as "unreliable", even
// though the great majority of the beats were timed correctly.
//
// Standard HRV preprocessing rejects intervals that deviate too far from their
// LOCAL median, which tracks a drifting heart rate instead of assuming a fixed
// one. Rejected intervals are excluded rather than interpolated: a successive
// difference is only taken where BOTH of its intervals survived, so an artifact
// removes the two differences that touch it rather than inventing a value.
// --------------------------------------------------------------------------
const RR_MIN_MS = 300;          // 200bpm
const RR_MAX_MS = 2000;         //  30bpm
const RR_LOCAL_TOL = 0.30;      // reject >30% from the local median
const RR_LOCAL_WIN = 5;         // +/-5 intervals

function cleanRR(rr) {
  const keep = rr.map((v, i) => {
    const lo = Math.max(0, i - RR_LOCAL_WIN);
    const hi = Math.min(rr.length, i + RR_LOCAL_WIN + 1);
    const m = median(rr.slice(lo, hi));
    return Number.isFinite(m) && m > 0 && Math.abs(v - m) <= RR_LOCAL_TOL * m;
  });
  const accepted = rr.filter((_, i) => keep[i]);
  // Successive differences only across adjacent surviving pairs.
  const sqDiffs = [];
  for (let i = 1; i < rr.length; i++) {
    if (keep[i] && keep[i - 1]) sqDiffs.push((rr[i] - rr[i - 1]) ** 2);
  }
  return {
    accepted,
    sqDiffs,
    rejected: rr.length - accepted.length,
    keepRate: rr.length ? accepted.length / rr.length : 0,
  };
}

function rrFromBeats(beats, sampleIntervalMs) {
  const all = [];
  for (let i = 1; i < beats.length; i++) all.push((beats[i] - beats[i - 1]) * sampleIntervalMs);
  return { all, inBand: all.filter((v) => v >= RR_MIN_MS && v <= RR_MAX_MS) };
}

// --------------------------------------------------------------------------
// Beat detection: adaptive threshold, same approach as the live page so the
// features describe the same beats the user sees.
// --------------------------------------------------------------------------
function detectBeatsAtThreshold(buf, mult, minGap) {
  const n = buf.length;
  const m = mean(buf), s = std(buf);
  const thr = m + s * mult;
  const win = Math.min(2, Math.max(1, Math.floor(minGap / 2)));
  const beats = [];
  let last = -minGap;
  for (let i = 1; i < n - 1; i++) {
    if (buf[i] <= thr) continue;
    if (i - last < minGap) continue;
    let isMax = true;
    for (let w = Math.max(0, i - win); w <= Math.min(n - 1, i + win); w++) {
      if (buf[w] > buf[i]) { isMax = false; break; }
    }
    if (isMax) { beats.push(i); last = i; }
  }
  return beats;
}

function detectBeats(buf, sampleIntervalMs) {
  if (buf.length < 5) return { beats: [], threshold: null };
  const minGap = Math.max(3, Math.floor((60000 / 180) / sampleIntervalMs));

  // Pick the threshold whose beat series is most SELF-CONSISTENT: the highest
  // fraction of intervals surviving local-median artifact rejection.
  //
  // This replaces "return the first threshold that finds 8 beats". That loop
  // started at the strictest multiplier and returned the moment it cleared a
  // fixed count of 8 — a count meaningful for the live page's few-second window
  // but trivially satisfied by a 300s recording, so a 300s trace always stopped
  // at mean+0.8*sigma and kept only the tallest peaks.
  //
  // Maximising the RAW number of beats (or of in-band intervals) is the obvious
  // alternative and it is wrong: on the reference recording it drives the
  // threshold negative, where false peaks split real intervals and bias HR from
  // ~96bpm up to ~107 against a device-reported 94.5. Keep-rate instead has a
  // genuine interior optimum — it climbs from 62% at +1.0 sigma to 80% at
  // +0.3 sigma and falls away to 68% by -0.3 sigma — because both missing real
  // beats and inventing false ones make the interval series less consistent.
  const CANDIDATES = [1.0, 0.8, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05, 0, -0.05, -0.15];
  const MIN_SCORED = 30;   // too few intervals to trust a keep-rate
  let best = [], bestMult = null, bestRate = -1, mostBeats = [], mostBeatsMult = null;
  for (const mult of CANDIDATES) {
    const b = detectBeatsAtThreshold(buf, mult, minGap);
    if (b.length > mostBeats.length) { mostBeats = b; mostBeatsMult = mult; }
    const { inBand } = rrFromBeats(b, sampleIntervalMs);
    if (inBand.length < MIN_SCORED) continue;
    const { keepRate, accepted } = cleanRR(inBand);
    if (accepted.length >= MIN_SCORED && keepRate > bestRate) {
      best = b; bestMult = mult; bestRate = keepRate;
    }
  }
  // Short or sparse recordings never reach MIN_SCORED intervals. Fall back to
  // the densest series so the caller can report why rather than seeing none.
  if (bestRate < 0) return { beats: mostBeats, threshold: mostBeatsMult };
  return { beats: best, threshold: bestMult };
}

// --------------------------------------------------------------------------
// Discrete Fourier transform over a frequency range, on a Hanning window.
// Returns { freq, power } pairs. Used for both the PPG spectrum and the
// RR-interval tachogram.
// --------------------------------------------------------------------------
function spectrum(sig, fs, fMax) {
  const n = sig.length;
  if (n < 16) return [];
  const m = mean(sig);
  const w = sig.map((v, i) => (v - m) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))));
  const half = Math.floor(n / 2);
  const out = [];
  for (let k = 1; k <= half; k++) {
    const freq = (k * fs) / n;
    if (freq > fMax) break;
    let re = 0, im = 0;
    for (let t = 0; t < n; t++) {
      const ang = (2 * Math.PI * k * t) / n;
      re += w[t] * Math.cos(ang);
      im -= w[t] * Math.sin(ang);
    }
    out.push({ freq, power: re * re + im * im });
  }
  return out;
}

function bandPower(spec, lo, hi) {
  let p = 0;
  for (const b of spec) if (b.freq >= lo && b.freq < hi) p += b.power;
  return p;
}

// Block-average downsample; also acts as an anti-alias prefilter.
function downsample(buf, targetN) {
  if (buf.length <= targetN) return buf.slice();
  const out = new Array(targetN);
  const ratio = buf.length / targetN;
  for (let i = 0; i < targetN; i++) {
    const s = Math.floor(i * ratio);
    const e = Math.max(s + 1, Math.floor((i + 1) * ratio));
    let sum = 0, c = 0;
    for (let j = s; j < e && j < buf.length; j++) { sum += buf[j]; c++; }
    out[i] = c ? sum / c : buf[Math.min(s, buf.length - 1)];
  }
  return out;
}

// --------------------------------------------------------------------------
// MAIN ENTRY POINT
// buffer          : array of raw waveform samples as received from the device
// recordedDurationMs : the true span those samples cover
// demographics    : { age, sex, weightKg, heightCm }
// --------------------------------------------------------------------------
function extractFeatures(buffer, recordedDurationMs, demographics = {}) {
  const n = buffer.length;
  const durationSec = recordedDurationMs / 1000;
  const sampleIntervalMs = n > 1 ? recordedDurationMs / (n - 1) : NaN;
  const fs = 1000 / sampleIntervalMs; // effective sample rate, Hz

  const f = {};   // features
  const q = {};   // signal quality

  // ---- provenance / quality ------------------------------------------------
  q.n_samples = n;
  q.duration_s = +durationSec.toFixed(2);
  q.sample_rate_hz = +fs.toFixed(3);
  // Below ~25Hz, beat timing quantization dominates HRV. Recorded so bad
  // rows can be filtered out of training rather than silently poisoning it.
  q.sample_rate_adequate_for_hrv = fs >= 25;
  q.flat_signal = std(buffer) === 0;

  const { beats, threshold } = detectBeats(buffer, sampleIntervalMs);
  q.beats_detected = beats.length;
  q.beat_threshold_multiplier = threshold;

  // ---- RR intervals --------------------------------------------------------
  const rrAll = [];
  for (let i = 1; i < beats.length; i++) rrAll.push((beats[i] - beats[i - 1]) * sampleIntervalMs);
  const rr = rrAll.filter(v => v >= 300 && v <= 2000);   // 30–200 bpm plausibility gate
  q.rr_total = rrAll.length;
  q.rr_accepted = rr.length;
  q.rr_accept_ratio = rrAll.length ? +(rr.length / rrAll.length).toFixed(4) : 0;

  const expectedBeats = durationSec > 0 ? durationSec * (1.2) : 0; // ~72bpm reference
  q.beat_yield = expectedBeats > 0 ? +(beats.length / expectedBeats).toFixed(4) : 0;

  // ---- time-domain HRV -----------------------------------------------------
  if (rr.length >= 3) {
    const mRR = mean(rr);
    f.mean_rr_ms = +mRR.toFixed(2);
    f.hr_bpm = +(60000 / mRR).toFixed(2);
    f.sdnn_ms = +std(rr).toFixed(2);
    const diffs = [];
    for (let i = 1; i < rr.length; i++) diffs.push(rr[i] - rr[i - 1]);
    f.rmssd_ms = +Math.sqrt(mean(diffs.map(d => d * d))).toFixed(2);
    f.pnn50 = +(diffs.filter(d => Math.abs(d) > 50).length / diffs.length).toFixed(4);
    f.cv_rr = +cv(rr).toFixed(4);          // scale-free variability
    f.median_rr_ms = +median(rr).toFixed(2);
    f.rr_range_ms = +(Math.max(...rr) - Math.min(...rr)).toFixed(2);
    // SD1/SD2 (Poincare) — standard nonlinear HRV descriptors
    const sd1 = Math.sqrt(0.5) * std(diffs);
    const sd2sq = 2 * Math.pow(std(rr), 2) - 0.5 * Math.pow(std(diffs), 2);
    f.sd1_ms = +sd1.toFixed(3);
    f.sd2_ms = sd2sq > 0 ? +Math.sqrt(sd2sq).toFixed(3) : null;
    f.sd1_sd2_ratio = (f.sd2_ms && f.sd2_ms !== 0) ? +(sd1 / f.sd2_ms).toFixed(4) : null;
  }

  // ---- frequency-domain HRV (tachogram resampled at 4Hz) -------------------
  if (rr.length >= 20) {
    const times = [0];
    for (const v of rr) times.push(times[times.length - 1] + v / 1000);
    const span = times[times.length - 1];
    if (span >= 60) {
      const rfs = 4;
      const m = Math.floor(span * rfs);
      if (m >= 32) {
        const res = new Array(m);
        for (let i = 0; i < m; i++) {
          const t = i / rfs;
          let j = 0;
          while (j < times.length - 2 && times[j + 1] < t) j++;
          const t0 = times[j], t1 = times[j + 1] ?? (t0 + 1);
          const v0 = rr[Math.min(j, rr.length - 1)], v1 = rr[Math.min(j + 1, rr.length - 1)];
          const fr = t1 > t0 ? Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) : 0;
          res[i] = v0 + (v1 - v0) * fr;
        }
        const spec = spectrum(res, rfs, 0.5);
        const vlf = bandPower(spec, 0.0033, 0.04);
        const lf = bandPower(spec, 0.04, 0.15);
        const hf = bandPower(spec, 0.15, 0.40);
        const tot = vlf + lf + hf;
        if (tot > 0) {
          f.hrv_vlf_rel = +(vlf / tot).toFixed(4);
          f.hrv_lf_rel = +(lf / tot).toFixed(4);
          f.hrv_hf_rel = +(hf / tot).toFixed(4);
          f.hrv_lf_hf = hf > 0 ? +(lf / hf).toFixed(4) : null;
          // normalized units (standard HRV convention, excludes VLF)
          const lfhfSum = lf + hf;
          f.hrv_lf_nu = lfhfSum > 0 ? +(lf / lfhfSum).toFixed(4) : null;
          f.hrv_hf_nu = lfhfSum > 0 ? +(hf / lfhfSum).toFixed(4) : null;
        }
      }
    }
  }

  // ---- PPG waveform spectrum (scale-invariant: relative shares only) -------
  {
    const targetN = Math.max(64, Math.min(n, Math.round(durationSec * 10)));
    const ds = downsample(buffer, targetN);
    const dsFs = ds.length / durationSec;
    const spec = spectrum(ds, dsFs, Math.min(6, dsFs / 2 - 0.01));
    const total = bandPower(spec, 0.05, 6);
    if (total > 0) {
      f.ppg_band_lt08_rel = +(bandPower(spec, 0.05, 0.8) / total).toFixed(4);
      f.ppg_band_08_15_rel = +(bandPower(spec, 0.8, 1.5) / total).toFixed(4);
      f.ppg_band_15_30_rel = +(bandPower(spec, 1.5, 3.0) / total).toFixed(4);
      f.ppg_band_30_60_rel = +(bandPower(spec, 3.0, 6.0) / total).toFixed(4);

      // dominant frequency and how peaked the spectrum is around it
      let peak = null;
      for (const b of spec) if (!peak || b.power > peak.power) peak = b;
      if (peak) {
        f.ppg_dominant_hz = +peak.freq.toFixed(4);
        f.ppg_dominant_rel = +(peak.power / total).toFixed(4);
        f.ppg_dominant_bpm = +(peak.freq * 60).toFixed(2);
      }
      // spectral centroid and entropy — shape descriptors, scale-free
      let wsum = 0, psum = 0;
      for (const b of spec) { wsum += b.freq * b.power; psum += b.power; }
      f.ppg_spectral_centroid_hz = psum > 0 ? +(wsum / psum).toFixed(4) : null;
      let ent = 0;
      for (const b of spec) {
        const p = b.power / psum;
        if (p > 0) ent -= p * Math.log(p);
      }
      f.ppg_spectral_entropy = +(ent / Math.log(spec.length || 2)).toFixed(4);

      // harmonic ratio: power at 2x dominant vs at dominant. Relates to how
      // sharp/notched the pulse is — a shape property, not an amplitude one.
      if (peak) {
        const h2 = bandPower(spec, peak.freq * 1.7, peak.freq * 2.3);
        const h1 = bandPower(spec, peak.freq * 0.7, peak.freq * 1.3);
        f.ppg_harmonic2_ratio = h1 > 0 ? +(h2 / h1).toFixed(4) : null;
      }
    }
  }

  // ---- pulse morphology (all normalized to be scale-invariant) -------------
  if (beats.length >= 3) {
    const amps = [], riseMs = [], widthMs = [], decayMs = [], riseFrac = [];
    for (let j = 0; j < beats.length; j++) {
      const bi = beats[j];
      const lo = j > 0 ? beats[j - 1] : Math.max(0, bi - 30);
      const hi = j < beats.length - 1 ? beats[j + 1] : Math.min(n - 1, bi + 30);
      let tb = bi, tv = buffer[bi];
      for (let i = lo + 1; i < bi; i++) if (buffer[i] < tv) { tv = buffer[i]; tb = i; }
      let ta = bi, tv2 = buffer[bi];
      for (let i = bi + 1; i < hi; i++) if (buffer[i] < tv2) { tv2 = buffer[i]; ta = i; }

      const amp = buffer[bi] - tv;
      if (!(amp > 0)) continue;
      amps.push(amp);
      const rt = (bi - tb) * sampleIntervalMs;
      const dt = (ta - bi) * sampleIntervalMs;
      riseMs.push(rt);
      decayMs.push(dt);
      widthMs.push((ta - tb) * sampleIntervalMs);
      if (rt + dt > 0) riseFrac.push(rt / (rt + dt));  // scale-free shape ratio
    }

    if (amps.length >= 3) {
      // NOTE: mean amplitude itself is deliberately NOT a feature — arbitrary
      // units. Only its variability (dimensionless) is meaningful.
      f.pulse_amp_cv = +cv(amps).toFixed(4);
      f.pulse_rise_ms = +mean(riseMs).toFixed(2);
      f.pulse_decay_ms = +mean(decayMs).toFixed(2);
      f.pulse_width_ms = +mean(widthMs).toFixed(2);
      f.pulse_rise_fraction = +mean(riseFrac).toFixed(4);
      f.pulse_rise_cv = +cv(riseMs).toFixed(4);
      f.pulse_width_cv = +cv(widthMs).toFixed(4);
      // crest time normalized by the cardiac cycle — classic PWA descriptor
      if (Number.isFinite(f.mean_rr_ms) && f.mean_rr_ms > 0) {
        f.pulse_rise_over_rr = +(mean(riseMs) / f.mean_rr_ms).toFixed(4);
        f.pulse_width_over_rr = +(mean(widthMs) / f.mean_rr_ms).toFixed(4);
      }
      q.pulses_measured = amps.length;
    }
  }

  // ---- demographics --------------------------------------------------------
  const { age, sex, weightKg, heightCm } = demographics;
  if (Number.isFinite(age)) f.age = age;
  if (sex) f.sex = String(sex).toLowerCase();
  if (Number.isFinite(weightKg)) f.weight_kg = weightKg;
  if (Number.isFinite(heightCm)) f.height_cm = heightCm;
  if (Number.isFinite(weightKg) && Number.isFinite(heightCm) && heightCm > 0) {
    f.bmi = +(weightKg / Math.pow(heightCm / 100, 2)).toFixed(2);
  }

  // ---- overall usability verdict ------------------------------------------
  q.usable = !!(
    !q.flat_signal &&
    q.sample_rate_adequate_for_hrv &&
    q.rr_accepted >= 20 &&
    q.rr_accept_ratio >= 0.5 &&
    Number.isFinite(f.hr_bpm) && f.hr_bpm >= 40 && f.hr_bpm <= 180
  );
  q.reject_reasons = [];
  if (q.flat_signal) q.reject_reasons.push('flat/constant signal');
  if (!q.sample_rate_adequate_for_hrv) q.reject_reasons.push(`sample rate ${q.sample_rate_hz}Hz below 25Hz minimum for HRV`);
  if (q.rr_accepted < 20) q.reject_reasons.push(`only ${q.rr_accepted} usable RR intervals (need 20)`);
  if (q.rr_accept_ratio < 0.5) q.reject_reasons.push(`only ${Math.round(q.rr_accept_ratio * 100)}% of intervals physiologically plausible`);
  if (!(Number.isFinite(f.hr_bpm) && f.hr_bpm >= 40 && f.hr_bpm <= 180)) q.reject_reasons.push('derived HR outside 40-180bpm');

  return { features: f, quality: q, beats };
}




function computeHrvFromBeats(beats, sampleIntervalMs) {
  // SAMPLE-RATE GATE. Beat positions are found by sample index, so RR
  // intervals are quantised to the sample period. Below ~20Hz that
  // quantisation dominates: at 6.2Hz adjacent intervals can only differ by
  // multiples of 161ms, which forces RMSSD into the hundreds of ms no matter
  // what the heart is actually doing. Publishing that as a measurement is
  // worse than publishing nothing, so refuse instead.
  const fsHz = 1000 / sampleIntervalMs;
  if (!(fsHz >= 20)) {
    return { hr: null, rmssd: null, sdnn: null, lfhf: null, rrCount: 0,
             beatsFound: beats.length,
             reason: `sample rate ${fsHz.toFixed(1)}Hz is too low for HRV — beat timing is `
                   + `quantised to ${sampleIntervalMs.toFixed(0)}ms, which would dominate RMSSD `
                   + `(need 20Hz minimum, 50Hz+ for accuracy)` };
  }
  if (beats.length < 4) return { hr: null, rmssd: null, sdnn: null, lfhf: null, rrCount: 0, beatsFound: beats.length, reason: `only ${beats.length} beats detected (need at least 4)` };

  // Beat-to-beat intervals in ms, filtered to a plausible 30-200bpm range
  // to reject obvious false-positive beat detections.
  const { all: allIntervals, inBand: rr } = rrFromBeats(beats, sampleIntervalMs);
  if (rr.length < 3) {
    // Diagnose the likely cause: if the raw (unfiltered) intervals imply a
    // wildly non-physiological rate, the "Recording duration" field almost
    // certainly doesn't match how long this CSV actually spans, rather
    // than the beats themselves being wrong.
    const avgIntervalMs = mean(allIntervals);
    const impliedBpm = avgIntervalMs > 0 ? 60000 / avgIntervalMs : 0;
    let reason = `only ${rr.length} of ${allIntervals.length} beat-to-beat intervals were in a plausible 30-200bpm range (need at least 3).`;
    if (impliedBpm > 0 && (impliedBpm < 30 || impliedBpm > 200)) {
      reason += ` At the declared recording duration, detected beats imply ~${impliedBpm.toFixed(0)}bpm — check that "Recording duration" actually matches how long this CSV spans; a wrong duration here throws off every beat-to-beat time calculation.`;
    }
    return { hr: null, rmssd: null, sdnn: null, lfhf: null, rrCount: rr.length, beatsFound: beats.length, reason };
  }

  // Reject intervals that deviate from their local median before any statistic
  // is taken. A missed beat yields a double-length interval which the 30-200bpm
  // band cannot catch, and one such artifact contributes its full ~650ms twice
  // to RMSSD.
  const { accepted, sqDiffs, rejected, keepRate } = cleanRR(rr);
  if (accepted.length < 3 || sqDiffs.length < 2) {
    return { hr: null, rmssd: null, sdnn: null, lfhf: null, rrCount: accepted.length,
             beatsFound: beats.length, rrRejected: rejected,
             reason: `only ${accepted.length} of ${rr.length} beat-to-beat intervals survived `
                   + `artifact rejection — the beat series is too irregular to measure` };
  }

  const sdnn = std(accepted);
  const rmssd = Math.sqrt(mean(sqDiffs));

  // ---- Frequency domain: LF/HF via a resampled tachogram + direct DFT ----
  const times = [0];
  for (let i = 0; i < accepted.length; i++) times.push(times[times.length - 1] + accepted[i] / 1000);
  const totalSpan = times[times.length - 1];

  let lfhf = null;
  if (totalSpan >= 60 && rr.length >= 20) {
    const fs = 4; // 4 Hz resample rate — standard for short-term HRV frequency analysis
    const n = Math.floor(totalSpan * fs);
    if (n >= 16) {
      const resampled = new Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / fs;
        let j = 0;
        while (j < times.length - 2 && times[j + 1] < t) j++;
        const t0 = times[j], t1 = times[j + 1] !== undefined ? times[j + 1] : t0 + 1;
        const v0 = accepted[Math.min(j, accepted.length - 1)];
        const v1 = accepted[Math.min(j + 1, accepted.length - 1)];
        const frac = t1 > t0 ? Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) : 0;
        resampled[i] = v0 + (v1 - v0) * frac;
      }
      const rMean = mean(resampled);
      const windowed = resampled.map((v, i) => (v - rMean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))));

      let lfPower = 0, hfPower = 0;
      const half = Math.floor(n / 2);
      for (let k = 1; k <= half; k++) {
        const freq = k / (n / fs);
        let re = 0, im = 0;
        for (let t = 0; t < n; t++) {
          const angle = (2 * Math.PI * k * t) / n;
          re += windowed[t] * Math.cos(angle);
          im -= windowed[t] * Math.sin(angle);
        }
        const power = re * re + im * im;
        if (freq >= 0.04 && freq < 0.15) lfPower += power;
        else if (freq >= 0.15 && freq <= 0.4) hfPower += power;
      }
      if (hfPower > 0) lfhf = lfPower / hfPower;
    }
  }

  const hr = 60000 / mean(accepted); // real HR from the surviving intervals — independent of any device-reported average

  // Physiological plausibility. Adult RMSSD is typically 20-50ms, reaching
  // ~100ms in athletes; SDNN similar. Values in the hundreds indicate the
  // beat series is dominated by detection or timing artefacts, not variability.
  if (rmssd > 300 || sdnn > 300) {
    return { hr: null, rmssd: null, sdnn: null, lfhf: null, rrCount: accepted.length,
             beatsFound: beats.length, rrRejected: rejected,
             reason: `computed RMSSD ${rmssd.toFixed(0)}ms / SDNN ${sdnn.toFixed(0)}ms are far outside `
                   + `the physiological range (<300ms), so the beat series is unreliable — `
                   + `usually missed beats or too low a sample rate` };
  }
  return { hr, rmssd, sdnn, lfhf, rrCount: accepted.length, beatsFound: beats.length,
           rrRejected: rejected, keepRate: +keepRate.toFixed(3), reason: null };
}

// ===========================================================================
// PUBLIC ENTRY POINT
// Runs the whole chain on one recording and returns everything the UI needs.
// ===========================================================================
export function analyseRecording(buffer, durationMs) {
  const n = buffer.length;
  const sampleIntervalMs = n > 1 ? durationMs / (n - 1) : 50;
  const fsHz = 1000 / sampleIntervalMs;

  const out = {
    sampleCount: n,
    durationMs,
    sampleRateHz: +fsHz.toFixed(2),
    beats: [],
    hrv: null,
    unavailableReason: null,
  };

  if (n < 200) {
    out.unavailableReason = `only ${n} samples — need at least 200`;
    return out;
  }

  const { beats } = detectBeats(buffer, sampleIntervalMs);
  out.beats = beats;

  // ---- HRV (has its own sample-rate gate inside) ----
  out.hrv = computeHrvFromBeats(beats, sampleIntervalMs);

  return out;
}

// The firmware inserts INT16_MIN as a gap marker where the finger came off.
// It is a protocol sentinel, not a sample: leaving it in inflates the signal's
// standard deviation (38% for one marker, 135% for five), which shifts the
// beat detector's mean+k*sigma threshold and renders as a full-scale spike.
export function stripGapMarkers(buffer) {
  const cleaned = [];
  let gapCount = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === -32768) { gapCount++; continue; }
    cleaned.push(buffer[i]);
  }
  return { cleaned, gapCount };
}

// Parses the "index,value" CSV the pages and the API both emit, as well as a
// plain one-number-per-line file.
export function parseCsvNumbers(text) {
  let lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length);
  if (!lines.length) return [];
  const first = lines[0].split(',').map((s) => s.trim()).filter((s) => s.length);
  if (first.length && first.some((p) => !Number.isFinite(Number(p)))) lines = lines.slice(1);
  if (!lines.length) return [];
  const rows = lines.map((l) => {
    const p = l.split(',').map((s) => s.trim()).filter((s) => s.length);
    return { p, nums: p.map(Number) };
  });
  const twoCol = rows.every((r) => r.p.length === 2 && r.nums.every(Number.isFinite));
  if (twoCol && rows.every((r, i) => r.nums[0] === i || r.nums[0] === i + 1)) {
    return rows.map((r) => r.nums[1]);
  }
  return text.split(/[\s,]+/).filter((s) => s.length).map(Number).filter(Number.isFinite);
}

export { detectBeats, computeHrvFromBeats, mean, std };
