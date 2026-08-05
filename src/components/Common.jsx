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

// Display high-pass: subtract a moving average, which removes everything slower
// than roughly 1/window.
//
// Measured on a stored 300s recording, 66.8% of the signal's power sits below
// 0.5Hz — baseline wander from finger pressure and perfusion drift — against
// 32.9% in the 0.5-4Hz pulse band. So the raw trace is mostly a picture of the
// baseline moving, with the pulse riding on it as a small ripple; that is why it
// reads as wobbly hills rather than beats. A 1.5s window inverts the ratio to
// 19.6% drift / 79.7% pulse.
//
// This is a DISPLAY transform only. The analysis pipeline has its own
// conditioning, and nothing here feeds it.
function movingAvgSubtract(d, win) {
  const n = d.length, half = win >> 1, out = new Float64Array(n);
  let sum = 0, lo = 0, hi = -1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
    while (hi < b) { hi++; sum += d[hi]; }
    while (lo < a) { sum -= d[lo]; lo++; }
    out[i] = d[i] - sum / (hi - lo + 1);
  }
  return out;
}

// Vertical scale from the TYPICAL PULSE amplitude: the median, across 2s blocks,
// of each block's peak-to-peak swing.
//
// Percentiles of the whole sample distribution do not work here. On the
// reference recording the median 2s pulse swing is 2062 counts while the 99th
// percentile of |deviation| is 3555 — a motion artifact is 5.6x the pulse, so
// scaling by the tail leaves real beats occupying under a tenth of the plot,
// which is exactly the "flat line with occasional spikes" problem. Taking the
// median across blocks ignores the artifact blocks entirely.
function pulseHalfAmplitude(series, rate) {
  const W = Math.max(10, Math.round(2 * rate));
  const p2p = [];
  for (let i = 0; i + W <= series.length; i += W) {
    let mn = Infinity, mx = -Infinity;
    for (let j = i; j < i + W; j++) {
      if (series[j] < mn) mn = series[j];
      if (series[j] > mx) mx = series[j];
    }
    p2p.push(mx - mn);
  }
  if (!p2p.length) return 1;
  p2p.sort((a, b) => a - b);
  const h = p2p.length >> 1;
  const median = p2p.length % 2 ? p2p[h] : (p2p[h - 1] + p2p[h]) / 2;
  return (median / 2) || 1;
}

export function WaveformDetail({ data, sampleRateHz = 50, beats, height = 300 }) {
  const [winSec, setWinSec] = useState(25);
  const [startSec, setStartSec] = useState(0);
  const [showBeats, setShowBeats] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [detrend, setDetrend] = useState(true);
  const [fitY, setFitY] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playSec, setPlaySec] = useState(null);
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

  // The plotted series and its scale, recomputed only when the source or the
  // detrend setting changes.
  const norm = useMemo(() => {
    if (!data || data.length < 2) return null;
    // 1.5s at the recording's own rate, so the cutoff stays put if the rate does.
    const win = Math.max(3, Math.round(1.5 * sampleRateHz));
    const series = detrend ? movingAvgSubtract(data, win) : data;

    let sum = 0;
    for (let i = 0; i < series.length; i++) sum += series[i];
    const m = sum / series.length;

    // A typical pulse then fills ~56% of the half-height, and the ~5% of samples
    // that exceed the axis are motion artifacts clipped by the plot rect. That
    // reads as an honest flat top rather than silently shrinking every beat to
    // accommodate a few excursions; "fit y" is there when the artifact is what
    // you want to look at.
    const scale = pulseHalfAmplitude(series, sampleRateHz);
    return { series, m, scale, yMax: 1.8 };
  }, [data, detrend, sampleRateHz]);

  // ---- transport ----------------------------------------------------------
  useEffect(() => {
    if (!playing) return;
    let raf, last = performance.now();
    const tick = (now) => {
      // Real time, 1:1 with the recording — one wall-clock second advances the
      // playhead one recorded second, which the sample rate then maps to samples.
      const dt = (now - last) / 1000;
      last = now;
      setPlaySec((p) => {
        const next = (p ?? 0) + dt;
        if (next >= totalSec) { setPlaying(false); return totalSec; }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, totalSec]);

  // While playing, the window is pinned to END at the playhead, so the newest
  // sample is always at the right edge and the trace travels leftwards — a
  // patient monitor in scroll mode. The start is deliberately allowed to go
  // negative for the first window's worth, so the trace enters from the right
  // on an empty plot instead of growing left-to-right first; tick labels below
  // skip anything before zero rather than printing negative times.
  const viewStart = playing && playSec != null ? playSec - winSec : start;

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      // Hand the view back to the user where the sweep left it, so pausing
      // does not make the trace jump.
      setStartSec(clampStart(Math.max(0, (playSec ?? 0) - winSec)));
      return;
    }
    if (playSec == null || playSec >= totalSec - 1e-6) setPlaySec(0);
    setPlaying(true);
  };

  // Clearing the playhead restores the whole trace.
  const stopPlay = () => { setPlaying(false); setPlaySec(null); };

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

    const i0 = Math.max(0, Math.floor(viewStart * sampleRateHz));
    const i1 = Math.min(data.length, Math.ceil((viewStart + winSec) * sampleRateHz));
    if (i1 - i0 < 2) return;

    // Whole-recording range by default so the scale does not move as you pan;
    // "fit" trades that comparability for filling the plot.
    let yMax = norm.yMax;
    if (fitY) {
      let peak = 0;
      for (let i = i0; i < i1; i++) {
        const a = Math.abs((norm.series[i] - norm.m) / norm.scale);
        if (a > peak) peak = a;
      }
      yMax = Math.max(0.05, Math.ceil(peak * 20) / 20);
    }

    const px = (t) => ML + ((t - viewStart) / winSec) * pw;
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
    for (let t = Math.ceil(viewStart / xStep) * xStep; t <= viewStart + winSec + 1e-9; t += xStep) {
      // The window hangs off the left of the recording while the sweep fills the
      // first screen; there is nothing before zero to label.
      if (t < -1e-9) continue;
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

    // While a playhead exists the trace is DRAWN UP TO IT rather than pre-drawn
    // with a line sliding over it — the sweep of a monitor, where the pulse
    // appears as it is played back.
    const drawEnd = playSec == null ? i1
      : Math.max(i0, Math.min(i1, Math.floor(playSec * sampleRateHz) + 1));

    ctx.beginPath();
    ctx.lineWidth = hair;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = line;
    for (let i = i0; i < drawEnd; i++) {
      const t = i / sampleRateHz;
      const a = (norm.series[i] - norm.m) / norm.scale;
      i === i0 ? ctx.moveTo(px(t), py(a)) : ctx.lineTo(px(t), py(a));
    }
    ctx.stroke();

    if (showBeats && beats?.length) {
      ctx.fillStyle = mint;
      for (const b of beats) {
        if (b < i0 || b >= drawEnd) continue;
        const a = (norm.series[b] - norm.m) / norm.scale;
        ctx.beginPath();
        ctx.arc(px(b / sampleRateHz), py(a), 2.6 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Leading edge of the sweep.
    if (playSec != null && playSec >= viewStart && playSec <= viewStart + winSec) {
      const x = snap(px(playSec));
      ctx.strokeStyle = mint;
      ctx.lineWidth = Math.max(1, Math.round(1.5 * dpr));
      ctx.globalAlpha = 0.75;
      ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + ph); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }, [data, norm, viewStart, winSec, sampleRateHz, beats, showBeats, height, fitY, playSec]);

  if (!data || data.length < 2) return <p className="hint">No waveform to plot.</p>;

  return (
    <div className="wave-detail">
      <div className="row-btns tight" style={{ marginBottom: 8 }}>
        <button className={playing ? 'primary' : ''} onClick={togglePlay}>
          {playing ? '❚❚ pause' : '▶ play'}
        </button>
        <button onClick={stopPlay} disabled={playSec == null}>■ stop</button>
        <span className="dim mono">
          {playSec != null ? `${playSec.toFixed(1)}s` : '—'} / {totalSec.toFixed(0)}s
        </span>
        <span style={{ flex: 1 }} />
        <button className={detrend ? 'primary' : ''} onClick={() => setDetrend((v) => !v)}>detrend</button>
        <button className={fitY ? 'primary' : ''} onClick={() => setFitY((v) => !v)}>fit y</button>
      </div>

      <div className="row-btns tight" style={{ marginBottom: 8 }}>
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
