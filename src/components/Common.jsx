import { useEffect, useMemo, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Wizard stepper — same five stages as the HTML console.
// ---------------------------------------------------------------------------
export const STEPS = [
  { n: 1, label: 'Connect' },
  { n: 2, label: 'Profile' },
  { n: 3, label: 'Biomarkers' },
  { n: 4, label: '300s scan' },
  { n: 5, label: 'Results' },
];

export function Stepper({ current, onJump }) {
  return (
    <div className="stepper">
      {STEPS.map((s, i) => (
        <div key={s.n} className="step-wrap">
          <button
            className={'step-chip' + (s.n === current ? ' active' : '') + (s.n < current ? ' done' : '')}
            // Only completed stages are re-enterable; jumping forward would
            // skip the device handshake the firmware requires in order.
            disabled={s.n > current}
            onClick={() => s.n < current && onJump?.(s.n)}
          >
            <span className="step-num">{s.n}</span>
            {s.label}
          </button>
          {i < STEPS.length - 1 && <span className="step-line" />}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dosha bars. Bars are scaled to the largest of the three rather than to 100,
// so the visual difference between values stays readable.
// ---------------------------------------------------------------------------
export function DoshaBars({ vata, pitta, kapha }) {
  const vals = [vata, pitta, kapha];
  const have = vals.every((v) => Number.isFinite(v));
  const max = have ? Math.max(...vals, 1) : 1;
  const rows = [
    ['Vata', vata, 'vata'],
    ['Pitta', pitta, 'pitta'],
    ['Kapha', kapha, 'kapha'],
  ];
  return (
    <div className="dosha-bars">
      {rows.map(([name, val, cls]) => (
        <div className={'dosha-item ' + cls} key={name}>
          <div className="dosha-head">
            <span>{name}</span>
            <span className="mono">{Number.isFinite(val) ? val.toFixed(1) : '—'}</span>
          </div>
          <div className="dosha-track">
            <div
              className="dosha-fill"
              style={{ width: Number.isFinite(val) ? `${(val / max) * 100}%` : '0%' }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Waveform canvas. Auto-scales to the data; optional beat markers.
// ---------------------------------------------------------------------------
export function WaveformCanvas({ data, beats, height = 140, color = '--amber', playhead = null }) {
  const ref = useRef(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(300, rect.width) * dpr;
    cv.height = height * dpr;
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    if (!data || data.length < 2) return;

    let mn = data[0], mx = data[0];
    for (const v of data) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const range = mx - mn || 1;
    const x = (i) => (i / (data.length - 1)) * w;
    const y = (v) => h - ((v - mn) / range) * (h * 0.84) - h * 0.08;

    const css = getComputedStyle(document.documentElement);
    ctx.beginPath();
    ctx.lineWidth = 1.4 * dpr;
    ctx.strokeStyle = css.getPropertyValue(color).trim() || '#e3a548';
    for (let i = 0; i < data.length; i++) i ? ctx.lineTo(x(i), y(data[i])) : ctx.moveTo(x(i), y(data[i]));
    ctx.stroke();

    if (beats?.length) {
      ctx.fillStyle = css.getPropertyValue('--mint').trim() || '#6ee7b7';
      for (const b of beats) {
        if (b < 0 || b >= data.length) continue;
        ctx.beginPath();
        ctx.arc(x(b), y(data[b]), 1.7 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (playhead !== null && playhead >= 0) {
      ctx.beginPath();
      ctx.strokeStyle = css.getPropertyValue('--mint').trim() || '#6ee7b7';
      ctx.lineWidth = 2 * dpr;
      ctx.moveTo(x(playhead), 0);
      ctx.lineTo(x(playhead), h);
      ctx.stroke();
    }
  }, [data, beats, height, color, playhead]);

  return <canvas ref={ref} className="wave-canvas" style={{ height }} />;
}

// ---------------------------------------------------------------------------
// Zoomed waveform with real axes — time in seconds against normalised signal
// amplitude, over a window you pan through.
//
// The full-recording canvas above squeezes 300s into a few hundred pixels, so
// ~460 pulses land under 1px each and individual beat morphology is invisible.
// This view plots one window at a time at a readable scale.
//
// Amplitude AND the y range are both fixed once over the whole recording:
// zero-mean, divided by the 99th-percentile absolute deviation. Rescaling per
// window would make every window fill the plot and so hide the amplitude changes
// that show where finger pressure drifted — the thing worth seeing. The
// percentile rather than the peak keeps one spike from flattening the rest.
// ---------------------------------------------------------------------------
const WINDOW_CHOICES = [5, 10, 25, 60];
const MIN_WIN_SEC = 2;
// Plot margins in CSS pixels. Kept out of the draw pass because the pointer
// handlers need the same geometry to convert a drag in pixels into seconds.
const M = { L: 58, R: 14, T: 12, B: 34 };

function niceStep(span, wanted) {
  for (const s of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120]) if (span / s <= wanted) return s;
  return 300;
}

// A 1px line drawn on an integer coordinate straddles two device pixels and the
// browser renders it as two half-intensity rows — the blur that makes an
// otherwise clean grid look muddy. Snapping to a half-pixel puts it on exactly
// one row.
const snap = (v) => Math.round(v) + 0.5;

export function WaveformDetail({ data, sampleRateHz = 50, beats, height = 300 }) {
  const [winSec, setWinSec] = useState(25);
  const [startSec, setStartSec] = useState(0);
  const [showBeats, setShowBeats] = useState(true);
  const [dragging, setDragging] = useState(false);
  const ref = useRef(null);
  const dragRef = useRef(null);

  const totalSec = data && data.length ? data.length / sampleRateHz : 0;
  const maxStart = Math.max(0, totalSec - winSec);
  const start = Math.min(startSec, maxStart);

  const clampStart = (s, w = winSec) => Math.min(Math.max(0, s), Math.max(0, totalSec - w));

  // ---- drag to pan, wheel to zoom ----------------------------------------
  // Panning by dragging the trace is the interaction people expect from a chart;
  // the slider stays as a way to jump across 300s at once.
  const plotWidthCss = () => {
    const cv = ref.current;
    const w = cv ? cv.getBoundingClientRect().width : 0;
    return Math.max(1, w - M.L - M.R);
  };

  const onPointerDown = (e) => {
    if (maxStart <= 0) return;
    dragRef.current = { x: e.clientX, start };
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    // Drag left => move forward in time, so the trace follows the cursor.
    const dt = ((d.x - e.clientX) / plotWidthCss()) * winSec;
    setStartSec(clampStart(d.start + dt));
  };

  const endDrag = (e) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  // React registers `wheel` as a PASSIVE listener on its root container, so
  // preventDefault() from an onWheel prop is ignored and the page scrolls while
  // you zoom. The listener has to be attached natively to opt out of passive.
  const wheelRef = useRef(null);
  useEffect(() => { wheelRef.current = onWheel; });
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const h = (e) => wheelRef.current?.(e);
    cv.addEventListener('wheel', h, { passive: false });
    return () => cv.removeEventListener('wheel', h);
  }, []);

  function onWheel(e) {
    if (!totalSec) return;
    e.preventDefault();
    const cv = ref.current;
    const rect = cv.getBoundingClientRect();
    // Anchor the zoom on the timestamp under the cursor so it does not drift.
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left - M.L) / plotWidthCss()));
    const tAt = start + frac * winSec;
    const next = Math.max(MIN_WIN_SEC, Math.min(totalSec, winSec * (e.deltaY > 0 ? 1.2 : 1 / 1.2)));
    setWinSec(next);
    setStartSec(clampStart(tAt - frac * next, next));
  }

  // Normalisation constants over the whole recording, computed once.
  const norm = useMemo(() => {
    if (!data || data.length < 2) return null;
    let sum = 0;
    for (const v of data) sum += v;
    const m = sum / data.length;
    const devs = new Float64Array(data.length);
    for (let i = 0; i < data.length; i++) devs[i] = Math.abs(data[i] - m);
    const sorted = Array.from(devs).sort((a, b) => a - b);
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] || 1;
    const scale = p99 || 1;
    // One y range for the whole recording. Fitting the axis to each window would
    // undo the point of normalising globally: every window would fill the plot
    // and a weak-pulse stretch would look identical to a strong one.
    const peak = sorted[sorted.length - 1] / scale;
    return { m, scale, yMax: Math.max(0.2, Math.ceil(peak * 10) / 10) };
  }, [data]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !norm || !data) return;
    const rect = cv.getBoundingClientRect();
    // Round the backing store to whole device pixels. A fractional width (common
    // at the 125%/150% display scaling Windows defaults to) makes the browser
    // resample the whole canvas, which softens every line in it.
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(Math.max(320, rect.width) * dpr);
    cv.height = Math.round(height * dpr);
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    const css = getComputedStyle(document.documentElement);
    const line = css.getPropertyValue('--amber').trim() || '#e3a548';
    const mint = css.getPropertyValue('--mint').trim() || '#6ee7b7';
    const ink = css.getPropertyValue('--muted').trim() || '#8fa69c';

    const ML = Math.round(M.L * dpr), MR = Math.round(M.R * dpr);
    const MT = Math.round(M.T * dpr), MB = Math.round(M.B * dpr);
    const pw = W - ML - MR, ph = H - MT - MB;
    const hair = Math.max(1, Math.round(dpr));   // exactly one device pixel

    const i0 = Math.max(0, Math.floor(start * sampleRateHz));
    const i1 = Math.min(data.length, Math.ceil((start + winSec) * sampleRateHz));
    if (i1 - i0 < 2) return;

    // Symmetric, whole-recording y range so zero sits on the centre line and
    // the scale does not move as you pan.
    const yMax = norm.yMax;

    const px = (t) => ML + ((t - start) / winSec) * pw;
    const py = (a) => MT + ph / 2 - (a / yMax) * (ph / 2);

    ctx.font = `${Math.round(11 * dpr)}px ui-monospace, monospace`;
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = hair;

    // y grid + labels
    const yStep = yMax / 2;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let a = -yMax; a <= yMax + 1e-9; a += yStep) {
      const y = snap(py(a));
      ctx.globalAlpha = 0.22;
      ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(W - MR, y); ctx.stroke();
      ctx.globalAlpha = 0.9;
      ctx.fillText(a.toFixed(2), ML - 8 * dpr, y);
    }

    // x grid + labels
    const xStep = niceStep(winSec, 7);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const decimals = xStep < 1 ? 1 : 0;
    for (let t = Math.ceil(start / xStep) * xStep; t <= start + winSec + 1e-9; t += xStep) {
      const x = snap(px(t));
      ctx.globalAlpha = 0.22;
      ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + ph); ctx.stroke();
      ctx.globalAlpha = 0.9;
      ctx.fillText(t.toFixed(decimals), x, MT + ph + 8 * dpr);
    }

    // zero line, brighter than the grid — the trace is centred on it
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(ML, snap(py(0))); ctx.lineTo(W - MR, snap(py(0)));
    ctx.stroke();

    // axis frame
    ctx.globalAlpha = 0.55;
    ctx.strokeRect(snap(ML), snap(MT), Math.round(pw), Math.round(ph));
    ctx.globalAlpha = 1;

    // axis titles
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.fillText('Time (s)', ML + pw / 2, H - 14 * dpr);
    ctx.save();
    ctx.translate(14 * dpr, MT + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Signal amplitude', 0, 0);
    ctx.restore();

    // the trace, clipped to the plot area
    ctx.save();
    ctx.beginPath();
    ctx.rect(ML, MT, pw, ph);
    ctx.clip();

    ctx.beginPath();
    ctx.lineWidth = hair;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = line;
    for (let i = i0; i < i1; i++) {
      const t = i / sampleRateHz;
      const a = (data[i] - norm.m) / norm.scale;
      i === i0 ? ctx.moveTo(px(t), py(a)) : ctx.lineTo(px(t), py(a));
    }
    ctx.stroke();

    if (showBeats && beats?.length) {
      ctx.fillStyle = mint;
      for (const b of beats) {
        if (b < i0 || b >= i1) continue;
        const a = (data[b] - norm.m) / norm.scale;
        ctx.beginPath();
        ctx.arc(px(b / sampleRateHz), py(a), 2.6 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }, [data, norm, start, winSec, sampleRateHz, beats, showBeats, height]);

  if (!data || data.length < 2) return <p className="hint">No waveform to plot.</p>;

  const step = winSec / 2;   // half-window overlap, so nothing falls between views
  const beatsHere = beats?.length
    ? beats.filter((b) => b >= start * sampleRateHz && b < (start + winSec) * sampleRateHz).length
    : 0;

  return (
    <div className="wave-detail">
      <div className="row-btns tight" style={{ marginBottom: 8 }}>
        <button onClick={() => setStartSec(clampStart(start - step))} disabled={start <= 0}>◀ back</button>
        <button onClick={() => setStartSec(clampStart(start + step))} disabled={start >= maxStart}>
          forward ▶
        </button>
        <span className="dim mono">
          {start.toFixed(1)}–{Math.min(totalSec, start + winSec).toFixed(1)}s of {totalSec.toFixed(0)}s
        </span>
        <span style={{ flex: 1 }} />
        <span className="dim mono">window</span>
        {WINDOW_CHOICES.map((s) => (
          <button
            key={s}
            className={Math.abs(winSec - s) < 0.01 ? 'primary' : ''}
            onClick={() => { setWinSec(s); setStartSec(clampStart(start, s)); }}
            disabled={s > totalSec}
          >
            {s}s
          </button>
        ))}
        {beats?.length > 0 && (
          <button className={showBeats ? 'primary' : ''} onClick={() => setShowBeats((v) => !v)}>beats</button>
        )}
      </div>

      <canvas
        ref={ref}
        className="wave-canvas"
        style={{ height, cursor: maxStart > 0 ? (dragging ? 'grabbing' : 'grab') : 'default', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />

      <input
        type="range" min={0} max={maxStart} step={0.1} value={start}
        onChange={(e) => setStartSec(clampStart(Number(e.target.value)))}
        disabled={maxStart <= 0}
        style={{ width: '100%', marginTop: 6 }}
        aria-label="Scroll through the recording"
      />

      <p className="hint">
        <strong>Drag the trace</strong> to pan, <strong>scroll</strong> to zoom around the cursor, or use the
        slider to jump. Window {winSec.toFixed(winSec < 10 ? 1 : 0)}s.
        Amplitude is zero-mean and divided by the 99th-percentile deviation of the <em>whole</em> recording, and
        the y range is fixed across windows — a flat stretch really is a weak pulse, not a rescaled one.
        {beats?.length > 0 && ` ${beatsHere} detected beat(s) in this window.`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SDPTG curve with the a-b-c-d-e waves marked, so the extraction can be
// checked by eye rather than trusted.
// ---------------------------------------------------------------------------
export function SdptgCanvas({ curve, sdptg, height = 180 }) {
  const ref = useRef(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !curve?.length) return;
    const rect = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(300, rect.width) * dpr;
    cv.height = height * dpr;
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height, pad = 14 * dpr;
    ctx.clearRect(0, 0, w, h);

    let mx = 0;
    for (const v of curve) mx = Math.max(mx, Math.abs(v));
    if (!(mx > 0)) mx = 1;
    const x = (i) => pad + (i / (curve.length - 1)) * (w - 2 * pad);
    const y = (v) => h / 2 - (v / mx) * (h / 2 - pad);

    const css = getComputedStyle(document.documentElement);
    ctx.strokeStyle = css.getPropertyValue('--line').trim();
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.moveTo(pad, h / 2); ctx.lineTo(w - pad, h / 2); ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = '#9ca8ff';
    ctx.lineWidth = 1.8 * dpr;
    for (let i = 0; i < curve.length; i++) i ? ctx.lineTo(x(i), y(curve[i])) : ctx.moveTo(x(i), y(curve[i]));
    ctx.stroke();

    if (!sdptg) return;
    const marks = [
      ['a', sdptg.a_index, false], ['b', sdptg.b_index, true],
      ['c', sdptg.c_index, false], ['d', sdptg.d_index, true],
      ['e', sdptg.e_index, false],
    ];
    ctx.font = `${11 * dpr}px ui-monospace, monospace`;
    for (const [label, idx, neg] of marks) {
      if (idx == null || idx < 0 || idx >= curve.length) continue;
      ctx.fillStyle = neg ? '#f0665a' : '#6ee7b7';
      ctx.beginPath();
      ctx.arc(x(idx), y(curve[idx]), 4 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(label, x(idx) + 5 * dpr, y(curve[idx]) + (neg ? 14 : -6) * dpr);
    }
  }, [curve, sdptg, height]);

  return <canvas ref={ref} className="wave-canvas" style={{ height }} />;
}

// ---------------------------------------------------------------------------
// Key/value grid for measured values.
// ---------------------------------------------------------------------------
export function KvGrid({ rows }) {
  return (
    <div className="kv">
      {Object.entries(rows).map(([k, v]) => (
        <div key={k}>
          <span className="k">{k}</span>
          <span className="v">{v === null || v === undefined || v === '' ? '—' : String(v)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection log.
// ---------------------------------------------------------------------------
export function LogPanel({ entries }) {
  const boxRef = useRef(null);
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [entries]);

  return (
    <details className="panel log-panel">
      <summary>Connection log ({entries.length})</summary>
      <div className="logbox" ref={boxRef}>
        {entries.length === 0 && <div className="dim">Nothing logged yet.</div>}
        {entries.map((e, i) => (
          <div key={i} className={'log-line ' + (e.level || 'info')}>
            <span className="log-time">[{e.at.toLocaleTimeString()}]</span> {e.message}
          </div>
        ))}
      </div>
    </details>
  );
}
