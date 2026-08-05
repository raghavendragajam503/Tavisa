// ===========================================================================
// LEGACY DOSHA ALGORITHMS  —  ports of page1-oldalg-full and page2-oldalg-profile
// ---------------------------------------------------------------------------
// Kept so results can be compared against the newer SDPTG method on the same
// recording. Reproduced FAITHFULLY, including their known weaknesses:
//
//   * The anchor tables below are hand-authored, not derived from data. There
//     is no evidence a 10-year-old is 65% Kapha rather than 55% or 75%. The
//     output looks precise to one decimal place but is arithmetic on guesses.
//
//   * The FFT waveform component uses ABSOLUTE frequency bands. A resting
//     adult's pulse fundamental (60-90bpm = 1.0-1.5Hz) always lands inside the
//     "Vata" band, so that component largely detects heart rate and relabels
//     it. Measured: the same pulse SHAPE swings 83.7 percentage points across
//     50-130bpm.
//
//   * FULL variant: demographics carry 38% of the result.
//     PROFILE variant: 70%, because HR and SpO2 are removed and their weight
//     is redistributed to age/gender/weight/height.
//
// Use LEGACY_* for comparison; prefer the SDPTG method in dsp.js for anything
// you intend to rely on.
// ===========================================================================

import { mean } from './dsp.js';

const AGE_ANCHORS = [
  // Classical Ayurvedic life-stage rule: Kapha dominant in youth,
  // Pitta in the productive/adult years, Vata increasing into old age.
  { x: 10, vec: [0.15, 0.20, 0.65] },
  { x: 35, vec: [0.20, 0.60, 0.20] },
  { x: 60, vec: [0.55, 0.25, 0.20] },
  { x: 80, vec: [0.70, 0.15, 0.15] },
];
// Gender has no strong universal Ayurvedic rule, so this is deliberately
// a light, minor factor (see genderWeight below) rather than a driver.
const GENDER_VEC = {
  male: [0.32, 0.40, 0.28],
  female: [0.36, 0.32, 0.32],
};
const HR_ANCHORS = [
  { x: 50, vec: [0.10, 0.20, 0.70] },
  { x: 70, vec: [0.20, 0.60, 0.20] },
  { x: 100, vec: [0.65, 0.25, 0.10] },
  { x: 130, vec: [0.75, 0.15, 0.10] },
];
const WEIGHT_ANCHORS = [
  // Lighter build leans Vata, moderate leans Pitta, heavier leans Kapha.
  { x: 45, vec: [0.65, 0.20, 0.15] },
  { x: 65, vec: [0.20, 0.60, 0.20] },
  { x: 90, vec: [0.15, 0.25, 0.60] },
  { x: 120, vec: [0.10, 0.15, 0.75] },
];
const HEIGHT_ANCHORS = [
  // Shorter/compact frame leans Kapha, medium leans Pitta, taller/lighter
  // frame leans Vata — the classical body-type associations by height.
  { x: 150, vec: [0.15, 0.20, 0.65] },
  { x: 165, vec: [0.20, 0.60, 0.20] },
  { x: 185, vec: [0.65, 0.25, 0.10] },
  { x: 200, vec: [0.75, 0.15, 0.10] },
];
const SPO2_ANCHORS = [
  { x: 85, vec: [0.75, 0.15, 0.10] },
  { x: 92, vec: [0.50, 0.30, 0.20] },
  { x: 96, vec: [0.25, 0.45, 0.30] },
  { x: 99, vec: [0.20, 0.45, 0.35] },
];

function lerpVec(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function anchorInterp(value, points) {
  if (!Number.isFinite(value)) return [1 / 3, 1 / 3, 1 / 3];
  if (value <= points[0].x) return points[0].vec.slice();
  for (let i = 0; i < points.length - 1; i++) {
    if (value <= points[i + 1].x) {
      const t = (value - points[i].x) / (points[i + 1].x - points[i].x);
      return lerpVec(points[i].vec, points[i + 1].vec, t);
    }
  }
  return points[points.length - 1].vec.slice();
}

function downsampleForFft(buffer, targetN) {
  if (buffer.length <= targetN) return buffer.slice();
  const out = new Array(targetN);
  const ratio = buffer.length / targetN;
  for (let i = 0; i < targetN; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0, count = 0;
    for (let j = start; j < end && j < buffer.length; j++) { sum += buffer[j]; count++; }
    out[i] = count > 0 ? sum / count : buffer[Math.min(start, buffer.length - 1)];
  }
  return out;
}

function computeFrequencyDosha(buffer, recordedDurationMsValue) {
  const n0 = buffer.length;
  if (n0 < 32) return null;
  const durationSec = (recordedDurationMsValue || 300000) / 1000;

  // Block-average downsample before the DFT — this keeps compute cost
  // bounded regardless of raw sample density (the boxcar averaging also
  // naturally anti-aliases content above our bands of interest), while
  // frequency RESOLUTION stays tied to total recording duration, not
  // sample count, so nothing meaningful is lost for the 0-3Hz range we
  // actually care about here.
  const TARGET_FS = 10; // Hz — comfortably above the 3.0Hz band ceiling
  const targetN = Math.max(64, Math.min(n0, Math.round(durationSec * TARGET_FS)));
  const buf = downsampleForFft(buffer, targetN);
  const n = buf.length;
  const fs = n / durationSec;

  const m = mean(buf);
  const windowed = buf.map((v, i) => (v - m) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))));

  let kaphaPower = 0, vataPower = 0, pittaPower = 0;
  const half = Math.floor(n / 2);
  for (let k = 1; k <= half; k++) {
    const freq = (k * fs) / n;
    if (freq > 3.5) break; // nothing above this matters for the three bands
    let re = 0, im = 0;
    for (let t = 0; t < n; t++) {
      const angle = (2 * Math.PI * k * t) / n;
      re += windowed[t] * Math.cos(angle);
      im -= windowed[t] * Math.sin(angle);
    }
    const power = re * re + im * im;
    if (freq < 0.05) continue; // skip near-DC baseline offset — not physiological
    else if (freq < 0.8) kaphaPower += power;
    else if (freq < 1.5) vataPower += power;
    else if (freq <= 3.0) pittaPower += power;
  }

  const total = vataPower + pittaPower + kaphaPower;
  if (total <= 0) return null;
  return {
    vata: vataPower / total,
    pitta: pittaPower / total,
    kapha: kaphaPower / total,
    vataPower, pittaPower, kaphaPower,
  };
}
// ---------------------------------------------------------------------------
// FULL variant — the page1 weighting. Uses HR and SpO2.
// ---------------------------------------------------------------------------
export function legacyDoshaFull({ age, gender, weightKg, heightCm, hr, spo2, waveform, durationMs }) {
  const freq = waveform && waveform.length > 10 ? computeFrequencyDosha(waveform, durationMs) : null;

  const ageVec = anchorInterp(age, AGE_ANCHORS);
  const genderVec = GENDER_VEC[String(gender).toLowerCase()] || [1 / 3, 1 / 3, 1 / 3];
  const weightVec = anchorInterp(weightKg, WEIGHT_ANCHORS);
  const heightVec = anchorInterp(heightCm, HEIGHT_ANCHORS);
  const hrVec = anchorInterp(hr, HR_ANCHORS);
  const spo2Vec = anchorInterp(spo2, SPO2_ANCHORS);

  let waveVec, waveWeight;
  if (freq) { waveVec = [freq.vata, freq.pitta, freq.kapha]; waveWeight = 30; }
  else { waveVec = [1 / 3, 1 / 3, 1 / 3]; waveWeight = 8; }

  const aw = 18, gw = 5, rw = 17, ww = 10, hw = 5;
  const sw = (Number.isFinite(spo2) && spo2 < 92) ? 30 : 15;
  const total = aw + gw + rw + ww + hw + sw + waveWeight;

  const comp = (i) =>
    aw * ageVec[i] + gw * genderVec[i] + rw * hrVec[i] +
    ww * weightVec[i] + hw * heightVec[i] + sw * spo2Vec[i] + waveWeight * waveVec[i];

  const vata = Math.round((comp(0) / total) * 1000) / 10;
  const pitta = Math.round((comp(1) / total) * 1000) / 10;
  const kapha = Math.round((100 - vata - pitta) * 10) / 10;

  let confidence = 55;
  if (freq) confidence += 30; else confidence -= 15;
  if (Number.isFinite(age) && age > 0 && age <= 110 && weightKg > 0 && heightCm > 0) confidence += 10;
  if (Number.isFinite(hr) && hr >= 40 && hr <= 180 &&
      Number.isFinite(spo2) && spo2 >= 70 && spo2 <= 100) confidence += 15;
  else confidence -= 10;
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  return {
    algorithm: 'legacy-full',
    vata, pitta, kapha, confidence,
    freqDosha: freq,
    factors: 'age 18, gender 5, HR 17, weight 10, height 5, SpO₂ ' + sw + ', waveform ' + waveWeight,
    demographicShare: +(((aw + gw + ww + hw) / total) * 100).toFixed(1),
  };
}

// ---------------------------------------------------------------------------
// PROFILE variant — the page2 weighting. No HR, no SpO2.
// ---------------------------------------------------------------------------
export function legacyDoshaProfile({ age, gender, weightKg, heightCm, waveform, durationMs }) {
  const freq = waveform && waveform.length > 10 ? computeFrequencyDosha(waveform, durationMs) : null;

  const ageVec = anchorInterp(age, AGE_ANCHORS);
  const genderVec = GENDER_VEC[String(gender).toLowerCase()] || [1 / 3, 1 / 3, 1 / 3];
  const weightVec = anchorInterp(weightKg, WEIGHT_ANCHORS);
  const heightVec = anchorInterp(heightCm, HEIGHT_ANCHORS);

  let waveVec, waveWeight;
  if (freq) { waveVec = [freq.vata, freq.pitta, freq.kapha]; waveWeight = 30; }
  else { waveVec = [1 / 3, 1 / 3, 1 / 3]; waveWeight = 15; }

  const aw = 25, gw = 10, ww = 20, hw = 15;
  const total = aw + gw + ww + hw + waveWeight;

  const comp = (i) =>
    aw * ageVec[i] + gw * genderVec[i] + ww * weightVec[i] + hw * heightVec[i] + waveWeight * waveVec[i];

  const vata = Math.round((comp(0) / total) * 1000) / 10;
  const pitta = Math.round((comp(1) / total) * 1000) / 10;
  const kapha = Math.round((100 - vata - pitta) * 10) / 10;

  let confidence = 55;
  if (freq) confidence += 30; else confidence -= 15;
  if (Number.isFinite(age) && age > 0 && age <= 110 && weightKg > 0 && heightCm > 0) confidence += 15;
  else confidence -= 10;
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  return {
    algorithm: 'legacy-profile',
    vata, pitta, kapha, confidence,
    freqDosha: freq,
    factors: 'age 25, gender 10, weight 20, height 15, waveform ' + waveWeight + ' (no HR/SpO₂)',
    demographicShare: +(((aw + gw + ww + hw) / total) * 100).toFixed(1),
  };
}

export { computeFrequencyDosha, anchorInterp };
