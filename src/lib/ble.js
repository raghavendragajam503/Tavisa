// ===========================================================================
// TAVISA Web Bluetooth client
// ---------------------------------------------------------------------------
// Wraps the device's GATT service behind an event-emitter style API so React
// components never touch Web Bluetooth directly.
//
// PROTOCOL (as implemented by the firmware)
//   Service  4fafc201-1fb5-459e-8fcc-c5c9c331914b
//   Notify   hr, spo2, dosha, hrv, bmi   -> CSV text
//            waveform                    -> binary, see markers below
//   Write    userdata                    -> profile CSV, then biomarkers CSV
//
//   Waveform control packets — identified by the 0xFF LEAD BYTE, not by length,
//   because some of them carry a payload:
//     FF 01  live/session start      FF 02  session end
//     FF 03  bulk transfer start
//     FF 04  bulk transfer end (older firmware revision)
//     FF 05  bulk header, 26-byte payload, field layout not yet decoded
//     FF 06  aux stream: 2-byte BIG-endian index + 3-byte records, sent AFTER
//            the waveform. NOT int16 samples — total length observed to be
//            divisible by 3 and not by 2. Never merge into the waveform.
//     FF 08  bulk transfer end (current revision)
//   Bulk chunks: 2-byte BIG-endian chunk index, then int16 LITTLE-endian samples,
//   120 samples per chunk. A chunk's lead byte is the high half of its index, so
//   it is never 0xFF for any realistic recording — hence the lead-byte test.
//
// The device requires the profile write BEFORE the biomarkers write, and it
// silently discards the whole profile if a special state is present without its
// required detail — so the caller must send well-formed values.
// ===========================================================================

export const SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';

export const CHAR_UUIDS = {
  hr: 'beb5483e-36e1-4688-b7f5-ea07361b26a8',
  spo2: 'beb5483f-36e1-4688-b7f5-ea07361b26a8',
  dosha: 'beb54840-36e1-4688-b7f5-ea07361b26a8',
  userdata: 'beb54841-36e1-4688-b7f5-ea07361b26a8',
  hrv: 'beb54842-36e1-4688-b7f5-ea07361b26a8',
  bmi: 'beb54843-36e1-4688-b7f5-ea07361b26a8',
  waveform: 'beb54844-36e1-4688-b7f5-ea07361b26a8',
  // Read on connect: fw=, proto=, dosha= and the nominal rates.
  deviceinfo: 'beb54847-36e1-4688-b7f5-ea07361b26a8',
  // Read/notify. Carries READY, PLACE_FINGER, MEASURING, ANALYSING, ERR:*,
  // PAUSED:* and the DONE,... frame.
  status: 'beb54848-36e1-4688-b7f5-ea07361b26a8',
};

// Bulk header (FF 05) field offsets, indexed from the first byte AFTER the
// two marker bytes. Verified against the serial log: [3..4] read 199.41 where
// the device reported fs_acq=199.41, and [20] read 0 where it reported qflags=0.
const HDR_ACQ_RATE_X100 = 3;   // uint16 BE, hundredths of a Hz
const HDR_WAVE_POINTS = 9;     // uint16 BE, samples the device actually stored
const HDR_DOSHA_FORMULA = 19;  // uint8
const HDR_QFLAGS = 20;         // uint8, bit0 = QF_WAVE_TRUNCATED
export const QF_WAVE_TRUNCATED = 0x01;

// The firmware streams bulk chunks back-to-back with no pacing gaps, so a pause
// this long means the transfer died rather than that it is merely slow. Without
// this, a truncated transfer leaves the UI waiting on an end marker forever.
// Two-stage patience, because a slow transfer and a dead one look identical for
// the first several seconds.
//
// The device sends chunks ~12ms apart, but this end has been observed running
// 300x behind when the browser throttles the tab — packets that took 3s each to
// surface still arrived and were still valid. A single 10s timeout that also set
// _waveMode back to 'idle' therefore did real damage: it declared a stall on a
// transfer that was merely slow, and from that moment every chunk that DID arrive
// was dropped on the floor because the mode no longer matched.
//
// So: warn but keep listening, and only give up after long enough that the device
// really cannot still be sending.
const BULK_QUIET_WARN_MS = 20000;
const BULK_GIVEUP_MS = 180000;
const BULK_STALL_MS = BULK_QUIET_WARN_MS;   // kept for the IBI watchdog's wording

const textOf = (dataView) => new TextDecoder().decode(dataView).trim();

// The firmware sends NAN as the literal text "nan" to mean "could not
// measure". parseFloat gives NaN; callers must render that as a dash rather
// than the string "NaN".
const num = (s) => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
};

export function isSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

export class TavisaDevice {
  constructor() {
    this.device = null;
    this.server = null;
    this.chars = {};
    this.listeners = {};

    this._waveMode = 'idle';        // idle | live | bulk
    this._bulkBuffer = [];
    this._bulkChunks = 0;
    this._bulkNextIndex = 0;       // expected chunk index, for gap detection
    this._bulkGaps = 0;
    this._bulkTimer = null;
    this._bulkHeader = null;       // FF 05 payload, verbatim
    this._auxBytes = 0;            // FF 06 stream, kept out of the waveform
    this._auxPackets = 0;
    this._ibiBytes = [];           // raw 3-byte IBI records, accumulated across FF 06 packets
    this._ibiTimer = null;
    this._lastRxAt = 0;             // for detecting a backed-up receive queue
    this._onGattDisconnect = null;
    this._disconnectHandled = false;
    this._sessionStart = 0;
  }

  // ---- tiny event emitter -------------------------------------------------
  on(event, fn) {
    (this.listeners[event] ||= []).push(fn);
    return this;
  }
  _emit(event, payload) {
    (this.listeners[event] || []).forEach((fn) => {
      try { fn(payload); } catch (e) { console.error('[ble] listener error', e); }
    });
  }
  _log(message, level = 'info') {
    this._emit('log', { message, level, at: new Date() });
  }

  // ---- connect ------------------------------------------------------------
  async connect() {
    if (!isSupported()) {
      throw new Error(
        'Web Bluetooth is unavailable. Use Chrome or Edge on desktop, or Chrome on Android, ' +
        'over https:// or from localhost.'
      );
    }

    // Characteristics from a previous GATT session belong to a dead connection;
    // writing to them throws, so they must never survive into a new connect.
    this.chars = {};

    this._log('Requesting device…');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    // Keep a reference so disconnect() can detach it. Chrome hands back the SAME
    // BluetoothDevice object for the same physical device, so every connect() was
    // stacking another listener on it and none were ever removed — which is why a
    // single drop logged "Device disconnected." three times after three connects.
    // Worse than noise: each stale instance's handler still ran, so a dead
    // TavisaDevice could reset status and stop the timer of the live one.
    this._onGattDisconnect = () => {
      if (this._disconnectHandled) return;      // one drop, one report
      this._disconnectHandled = true;
      this._clearBulkWatchdog();
      this._clearIbiWatchdog();
      this._waveMode = 'idle';
      this._log('Device disconnected.', 'error');
      this._emit('disconnected');
    };
    this._disconnectHandled = false;
    this.device.addEventListener('gattserverdisconnected', this._onGattDisconnect);

    this._log(`Connecting to ${this.device.name || 'TAVISA'}…`);
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(SERVICE_UUID);

    // Discover each characteristic independently: a firmware GATT table that is
    // one handle short drops the last characteristics silently, and the app
    // should report exactly which are missing rather than failing wholesale.
    const missing = [];
    for (const [key, uuid] of Object.entries(CHAR_UUIDS)) {
      try {
        this.chars[key] = await service.getCharacteristic(uuid);
        this._log(`Found characteristic "${key}".`);
      } catch {
        missing.push(key);
        this._log(`Missing characteristic "${key}" (${uuid}).`, 'error');
      }
    }

    // Enumerate EVERYTHING the service exposes, not only the UUIDs listed above.
    //
    // The firmware also emits a status frame ("DONE,beats=...", or
    // "FAILED:TOO_NOISY" when it aborts) and its UUID is not documented here. A
    // fixed list would silently ignore it, and a scan that fails would then leave
    // the app waiting for a transfer that is never coming. Subscribing to whatever
    // is actually present finds it regardless of UUID, and logs the UUID so it can
    // be pinned in CHAR_UUIDS once known.
    const known = new Set(Object.values(CHAR_UUIDS).map((u) => u.toLowerCase()));
    this.extraChars = [];
    try {
      for (const ch of await service.getCharacteristics()) {
        if (known.has(ch.uuid.toLowerCase())) continue;
        this.extraChars.push(ch.uuid);
        this._log(`Undocumented characteristic ${ch.uuid} — subscribing as a status source.`, 'warn');
        if (ch.properties?.notify || ch.properties?.indicate) {
          try {
            await ch.startNotifications();
            ch.addEventListener('characteristicvaluechanged',
              (e) => this._onStatusText(e.target.value, ch.uuid));
          } catch (e) {
            this._log(`Could not subscribe to ${ch.uuid}: ${e.message}`, 'warn');
          }
        }
        // Read once too: a status set before we connected would never notify.
        if (ch.properties?.read) {
          try {
            const v = await ch.readValue();
            if (v.byteLength) this._onStatusText(v, ch.uuid);
          } catch { /* not readable in practice; ignore */ }
        }
      }
    } catch (e) {
      this._log('Could not enumerate characteristics: ' + e.message, 'warn');
    }

    // Status is read as well as subscribed: a state set before we connected
    // (READY, or a FAILED from the previous scan) would otherwise never notify.
    if (this.chars.status) {
      await this.chars.status.startNotifications();
      this.chars.status.addEventListener('characteristicvaluechanged',
        (e) => this._onStatusText(e.target.value, CHAR_UUIDS.status));
      try {
        const v = await this.chars.status.readValue();
        if (v.byteLength) this._onStatusText(v, CHAR_UUIDS.status);
      } catch { /* notify-only in practice; ignore */ }
    }

    if (this.chars.deviceinfo) {
      try {
        const info = textOf(await this.chars.deviceinfo.readValue());
        this.deviceInfo = info;
        this._log(`Device info: ${info}`, 'ok');
        this._emit('device-info', { text: info });
      } catch (e) {
        this._log('Could not read device info: ' + e.message, 'warn');
      }
    }

    for (const [key, handler] of [
      ['hr', this._onHR], ['spo2', this._onSpO2], ['dosha', this._onDosha],
      ['hrv', this._onHRV], ['bmi', this._onBMI], ['waveform', this._onWaveform],
    ]) {
      const ch = this.chars[key];
      if (!ch) continue;
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', (e) => handler.call(this, e.target.value));
    }

    this._log('Connected and subscribed.', 'ok');
    this._emit('connected', { missing, extraChars: this.extraChars });
    return { missing, extraChars: this.extraChars };
  }

  async disconnect() {
    this._clearBulkWatchdog();
    this._clearIbiWatchdog();
    this._waveMode = 'idle';
    // Detach before dropping the link, so this instance stops reacting to a
    // device object that outlives it.
    if (this.device && this._onGattDisconnect) {
      this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnect);
      this._onGattDisconnect = null;
    }
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.chars = {};
  }

  get connected() {
    return !!this.device?.gatt?.connected;
  }

  // ---- writes -------------------------------------------------------------
  async _write(text) {
    const ch = this.chars.userdata;
    if (!ch) throw new Error('The device did not expose the userdata characteristic, so nothing can be sent.');
    const bytes = new TextEncoder().encode(text);
    // writeValue is deprecated; prefer the explicit form where available.
    if (typeof ch.writeValueWithResponse === 'function') await ch.writeValueWithResponse(bytes);
    else await ch.writeValue(bytes);
  }

  /**
   * Profile must be sent first. specialState, when present, must be exactly
   * one of the strings the firmware compares against, and pregnancy/menopause
   * REQUIRE a detail or the device discards the entire profile without saying so.
   */
  async sendProfile({ age, gender, weightKg, heightCm, specialState = '', stateDetail = '' }) {
    const tokens = [age, gender, weightKg, heightCm];
    if (specialState) {
      tokens.push(specialState);
      if (specialState === 'pregnancy care' || specialState === 'menopausal wellness') {
        if (!stateDetail) {
          throw new Error(`"${specialState}" requires a stage — the device would silently reject the profile.`);
        }
        tokens.push(stateDetail);
      }
    }
    const csv = tokens.join(',');
    await this._write(csv);
    this._log('Sent profile: ' + csv, 'ok');
    return csv;
  }

  /** Biomarkers second. Zeros are valid and mean "not provided". */
  async sendBiomarkers({ hba1c, totalChol, ldl, hdl, crp } = {}) {
    // An omitted lab is sent as an EMPTY field, not as 0.
    //
    // Zero is a value: 0 mg/dL LDL or 0% HbA1c are not "unknown", they are
    // impossible readings, and the device has no way to tell the difference. Five
    // zeros looked to the firmware like five supplied labs. Blank fields keep
    // "not measured" distinct from "measured as zero", so nothing entered sends
    // ",,,," and a partly filled form sends e.g. "5.4,,,,".
    const field = (v) => {
      if (v === null || v === undefined || v === '') return '';
      const n = Number(v);
      return Number.isFinite(n) ? String(n) : '';
    };
    const csv = [hba1c, totalChol, ldl, hdl, crp].map(field).join(',');
    await this._write(csv);
    const supplied = csv.split(',').filter((s) => s !== '').length;
    this._log(`Sent biomarkers: "${csv}" (${supplied} of 5 supplied).`, 'ok');
    return csv;
  }

  // ---- notification handlers ---------------------------------------------
  _onHR(v) {
    const hr = num(textOf(v));
    this._emit('device-hr', hr);
    this._log(hr === null ? 'Device reported HR as not-measurable.' : `Device HR ${hr.toFixed(1)} bpm.`);
  }
  _onSpO2(v) {
    const spo2 = num(textOf(v));
    this._emit('device-spo2', spo2);
    this._log(spo2 === null ? 'Device reported SpO₂ as not-measurable.' : `Device SpO₂ ${spo2.toFixed(1)} %.`);
  }
  _onBMI(v) {
    this._emit('device-bmi', num(textOf(v)));
  }
  _onDosha(v) {
    const [vata, pitta, kapha] = textOf(v).split(',').map(num);
    this._emit('device-dosha', { vata, pitta, kapha });
    this._log(`Device dosha — V ${vata} P ${pitta} K ${kapha}.`);
  }
  _onHRV(v) {
    const [rmssd, sdnn, lfhf] = textOf(v).split(',').map(num);
    // Logged, not just emitted: these are the device's own figures from its own
    // accepted interval series, and without them in the log there is nothing to
    // compare the app's waveform-derived numbers against.
    const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
    this._log(`Device HRV — RMSSD ${f(rmssd)}ms, SDNN ${f(sdnn)}ms, LF/HF ${f(lfhf, 2)}.`);
    this._emit('device-hrv', { rmssd, sdnn, lfhf });
  }

  // ---- status frames ------------------------------------------------------
  // Text frames from the firmware's status characteristic. Two forms matter:
  //
  //   STATUS: DONE,beats=374/424,artefact=11.8,fs_acq=199.41,fs_stored=99.70,dur_s=300,...
  //   FAILED:TOO_NOISY
  //
  // FAILED is the important one: the device abandons the scan and sends NO
  // waveform, so anything waiting on the transfer waits forever. The scan has to
  // be restarted from the profile write, because the firmware discards the
  // profile and lab frame along with the aborted session.
  _onStatusText(dataView, uuid) {
    const text = textOf(dataView);
    if (!text) return;
    this._log(`Status: ${text}`);
    this._emit('status', { text, uuid });

    const body = text.replace(/^STATUS:\s*/i, '').trim();

    if (/^FAILED/i.test(body)) {
      // "FAILED:TOO_NOISY" -> reason "TOO_NOISY". Any other FAILED code is
      // surfaced verbatim rather than swallowed as an unknown.
      const reason = (body.split(/[:,]/)[1] || 'UNSPECIFIED').trim();
      this._waveMode = 'idle';
      this._clearBulkWatchdog();
      this._log(`Scan FAILED (${reason}) — the device aborted and will send no waveform.`, 'error');
      this._emit('scan-failed', { reason, text });
      return;
    }

    if (/^DONE/i.test(body)) {
      // Parse the key=value tail so the app can use the firmware's own duration
      // and sample rate instead of assuming them, and compare beat counts.
      const fields = {};
      for (const part of body.split(',').slice(1)) {
        const [k, v] = part.split('=');
        if (k && v !== undefined) fields[k.trim()] = v.trim();
      }
      const beats = /^(\d+)\s*\/\s*(\d+)$/.exec(fields.beats || '');
      const num = (k) => (fields[k] != null ? parseFloat(fields[k]) : null);
      const qflags = num('qflags');
      this._emit('scan-done', {
        text,
        fields,
        beatsAccepted: beats ? +beats[1] : null,
        beatsDetected: beats ? +beats[2] : null,
        artefactPct: num('artefact'),
        fsStoredHz: num('fs_stored'),
        fsAcqHz: num('fs_acq'),
        durationSec: num('dur_s'),
        qflags,
        // Set when the device ran out of heap mid-scan and stopped appending
        // samples. Distinguishes "never recorded" from "lost on the way here".
        waveTruncated: qflags != null ? !!(qflags & QF_WAVE_TRUNCATED) : null,
        // Present once the firmware adds them; ignored gracefully until then.
        chunksSent: num('chunks_sent'),
        chunksTotal: num('chunks_total'),
        wavePoints: num('wave_points'),
        waveDropped: num('wave_dropped'),
      });
    }
  }

  _hex(dataView, from) {
    const out = [];
    for (let i = from; i < dataView.byteLength; i++) {
      out.push(dataView.getUint8(i).toString(16).padStart(2, '0'));
    }
    return out.join(' ');
  }

  // ---- bulk transfer watchdog ---------------------------------------------
  _clearBulkWatchdog() {
    clearTimeout(this._bulkTimer);
    this._bulkTimer = null;
  }

  _clearIbiWatchdog() {
    if (this._ibiTimer) { clearTimeout(this._ibiTimer); this._ibiTimer = null; }
  }

  // The interval series is the measurement of record, so a partial one must be
  // surfaced rather than held in a buffer waiting for an end marker that is not
  // coming. Without this, 160 of 370 intervals sat in _ibiBytes and the operator
  // saw nothing at all.
  _armIbiWatchdog() {
    this._clearIbiWatchdog();
    this._ibiTimer = setTimeout(() => {
      if (!this._ibiBytes.length) return;
      const count = Math.floor(this._ibiBytes.length / 3);
      this._log(
        `Interval series incomplete — ${count} intervals in ${this._auxPackets} packet(s), then nothing for ` +
        `${BULK_STALL_MS / 1000}s and no end-of-stream marker. The device sends the series before the waveform, ` +
        `so if it stopped arriving here the waveform behind it was never reached either.`,
        'error'
      );
      this._emit('ibi-stalled', {
        records: this._ibiBytes.length >= 3 ? this._sliceIbiRecords() : [],
        count,
        bytes: this._ibiBytes.slice(),
        packets: this._auxPackets,
      });
    }, BULK_STALL_MS);
  }

  _sliceIbiRecords() {
    const out = [];
    for (let i = 0; i + 2 < this._ibiBytes.length; i += 3) {
      out.push([this._ibiBytes[i], this._ibiBytes[i + 1], this._ibiBytes[i + 2]]);
    }
    return out;
  }

  _armBulkWatchdog() {
    this._clearBulkWatchdog();

    // Stage 1: quiet for a while. Say so, but stay in bulk mode so anything that
    // arrives late is still accepted.
    this._bulkTimer = setTimeout(() => {
      if (this._waveMode !== 'bulk') return;
      const stored = this._bulkHeaderFields?.wavePoints ?? null;
      const chunksExpected = stored != null ? Math.ceil(stored / 120) : null;
      this._log(
        `No waveform chunk for ${BULK_QUIET_WARN_MS / 1000}s — ${this._bulkBuffer.length} samples in ` +
        `${this._bulkChunks} chunks so far` +
        (chunksExpected ? ` (${this._bulkChunks}/${chunksExpected}, ${((100 * this._bulkChunks) / chunksExpected).toFixed(0)}%)` : '') +
        `. Still listening: the device may simply be slow, or this end may be behind on its notification ` +
        `queue. Keep this window in front. Giving up after ${BULK_GIVEUP_MS / 1000}s of silence.`,
        'warn'
      );
      this._emit('bulk-slow', {
        samples: this._bulkBuffer.length,
        chunks: this._bulkChunks,
        chunksExpected,
      });

      // Stage 2: long enough that the device cannot still be transmitting.
      this._bulkTimer = setTimeout(() => {
        if (this._waveMode !== 'bulk') return;
        this._waveMode = 'idle';
        this._log(
          `Bulk transfer abandoned — no chunk for ${BULK_GIVEUP_MS / 1000}s. Received ` +
          `${this._bulkBuffer.length} samples in ${this._bulkChunks} chunks` +
          (stored != null
            ? ` of the ${stored} the device stored (${this._bulkChunks}/${chunksExpected} chunks)`
            : '') + '.',
          'error'
        );
        this._emit('bulk-stalled', {
          waveform: this._bulkBuffer.slice(),
          chunks: this._bulkChunks,
          gaps: this._bulkGaps,
          headerFields: this._bulkHeaderFields || null,
        });
      }, BULK_GIVEUP_MS - BULK_QUIET_WARN_MS);
    }, BULK_QUIET_WARN_MS);
  }

  _onWaveform(dataView) {
    const len = dataView.byteLength;

    // Control packets, identified by the 0xFF lead byte ALONE — not by length.
    // A chunk's first byte is the high half of its big-endian index, so 0xFF
    // there would mean chunk >= 65280, i.e. ~7.9M samples: impossible. Matching
    // on `len === 2` instead let the firmware's longer FF 05 packet fall through
    // to the chunk branch, where its index read as 65285 and its payload bytes
    // were pushed into the waveform as samples.
    if (len >= 2 && dataView.getUint8(0) === 0xff) {
      const marker = dataView.getUint8(1);
      if (marker === 0x01) {
        this._waveMode = 'live';
        this._sessionStart = Date.now();
        this._log('Session started — device is recording.', 'ok');
        this._emit('session-start');
      } else if (marker === 0x02) {
        this._waveMode = 'idle';
        const wallMs = Date.now() - this._sessionStart;
        this._log('Session ended.', 'ok');
        this._emit('session-end', { wallClockMs: wallMs });
      } else if (marker === 0x03) {
        this._waveMode = 'bulk';
        this._bulkBuffer = [];
        this._bulkChunks = 0;
        this._bulkNextIndex = 0;
        this._bulkGaps = 0;
        this._bulkHeader = null;
        this._auxBytes = 0;
        this._auxPackets = 0;
        this._log('Bulk waveform transfer started.');
        this._emit('bulk-start');
        this._armBulkWatchdog();
      } else if (marker === 0x04 || marker === 0x08) {
        // FF 08 is what this firmware revision sends to close a bulk transfer;
        // FF 04 is kept because the older revision used it. Treating only FF 04
        // as the end left every completed transfer waiting on a marker that
        // never came, so the watchdog reported a "stall" 10s after the device
        // had in fact finished and gone quiet.
        //
        // The mode guard matters: FF 08 also closes the FF 06 aux stream, which
        // the device sends BEFORE the FF 03 that opens the waveform. Without it
        // that first FF 08 completed an empty transfer, so a 0-sample recording
        // was analysed and pushed to the API before the real waveform arrived.
        if (this._waveMode !== 'bulk') {
          // Not stray: this closes the IBI series, which precedes the waveform.
          if (this._ibiBytes.length) {
            const records = [];
            for (let i = 0; i + 2 < this._ibiBytes.length; i += 3) {
              records.push([this._ibiBytes[i], this._ibiBytes[i + 1], this._ibiBytes[i + 2]]);
            }
            const spare = this._ibiBytes.length % 3;
            this._log(
              `IBI series complete — ${records.length} intervals in ${this._auxPackets} packet(s)` +
              (spare ? `, plus ${spare} trailing byte(s) that do not form a record` : '') + '.',
              'ok'
            );
            this._emit('ibi-series', {
              records,
              count: records.length,
              bytes: this._ibiBytes.slice(),
              packets: this._auxPackets,
            });
            this._clearIbiWatchdog();
            this._ibiBytes = [];
            this._auxPackets = 0;
            this._auxBytes = 0;
            return;
          }
          this._log(`End-of-stream (FF ${marker.toString(16).padStart(2, '0')}) with nothing buffered — ignored.`);
          return;
        }
        this._waveMode = 'idle';
        this._clearBulkWatchdog();
        this._log(`Bulk transfer complete — ${this._bulkBuffer.length} samples in ${this._bulkChunks} chunks.`, 'ok');
        if (this._bulkGaps) {
          this._log(`${this._bulkGaps} chunk(s) were lost in transit — the waveform has holes.`, 'warn');
        }
        if (this._auxPackets) {
          const records = this._auxBytes % 3 === 0 ? `${this._auxBytes / 3} 3-byte records` : `${this._auxBytes} bytes`;
          this._log(`Aux stream (FF 06): ${this._auxPackets} packet(s), ${records} — not yet decoded.`);
        }
        this._emit('bulk-complete', {
          waveform: this._bulkBuffer.slice(),
          chunks: this._bulkChunks,
          gaps: this._bulkGaps,
          header: this._bulkHeader,
          headerFields: this._bulkHeaderFields || null,
          auxBytes: this._auxBytes,
        });
      } else if (marker === 0x05) {
        // Header opening the bulk phase. wave_points is the decisive field: it is
        // how many samples the device actually STORED, so comparing it against
        // both what arrives and against dur_s x fs_stored separates a transfer
        // that lost data from a recording that never held it.
        this._bulkHeader = this._hex(dataView, 2);
        const at = (i) => 2 + i;                       // payload index -> packet offset
        const h = {
          hex: this._bulkHeader,
          acqRateHz: len > at(HDR_ACQ_RATE_X100) + 1
            ? +(dataView.getUint16(at(HDR_ACQ_RATE_X100), false) / 100).toFixed(2) : null,
          wavePoints: len > at(HDR_WAVE_POINTS) + 1
            ? dataView.getUint16(at(HDR_WAVE_POINTS), false) : null,
          doshaFormulaId: len > at(HDR_DOSHA_FORMULA) ? dataView.getUint8(at(HDR_DOSHA_FORMULA)) : null,
          qflags: len > at(HDR_QFLAGS) ? dataView.getUint8(at(HDR_QFLAGS)) : null,
        };
        // The stored stream is the acquired one decimated by 2, so the MEASURED
        // stored rate is fs_acq/2. Verified against three runs: 199.41/2 = 99.70,
        // 199.12/2 = 99.56, 198.90/2 = 99.45 — each matching the firmware's own
        // fs_stored exactly. This is what duration must be derived from; a
        // hardcoded 100Hz is wrong by half a percent and drifts per device.
        h.storedRateHz = h.acqRateHz != null ? +(h.acqRateHz / 2).toFixed(3) : null;
        h.waveTruncated = h.qflags != null ? !!(h.qflags & QF_WAVE_TRUNCATED) : null;
        this._bulkHeaderFields = h;
        this._log(
          `Bulk header: ${h.wavePoints} samples stored, acquired at ${h.acqRateHz}Hz, ` +
          `dosha formula ${h.doshaFormulaId}, qflags ${h.qflags}` +
          (h.waveTruncated ? ' — WAVE TRUNCATED: the device ran out of heap and dropped samples.' : '.')
        );
        if (h.waveTruncated) this._log('QF_WAVE_TRUNCATED is set — samples were lost at acquisition, not in transit.', 'error');
        this._emit('bulk-header', h);
        this._armBulkWatchdog();
      } else if (marker === 0x06) {
        // THE IBI SERIES — the beat-to-beat interval record, sent BEFORE the
        // waveform. 2-byte BIG-endian index, then 3-byte records.
        //
        // Confirmed by count: 5 packets carrying 1179 data bytes is 393 records,
        // exactly the "Intervals detected: 393" the firmware reported for that
        // scan. This is the scientific record RMSSD/SDNN/LF-HF are derived from,
        // over the full session and with an accept/reject flag per interval; the
        // waveform is for display. Treating it as an opaque "aux stream" and
        // deriving HRV from the waveform instead was simply wrong.
        const index = dataView.getUint16(2, false);
        this._auxBytes += len - 4;
        this._auxPackets++;
        for (let i = 4; i < len; i++) this._ibiBytes.push(dataView.getUint8(i));

        // The device sends these ~10ms apart. A gap of seconds means this end is
        // not draining its notification queue, which is invisible otherwise
        // because notifications are unacknowledged and nothing is retransmitted.
        const now = Date.now();
        if (this._lastRxAt) {
          const gap = now - this._lastRxAt;
          if (gap > 500) {
            this._log(
              `${gap}ms since the previous packet — the device sends these about 10ms apart, so this end is ` +
              `${Math.round(gap / 10)}x behind. Notifications are being queued faster than they are consumed.`,
              'warn'
            );
          }
        }
        this._lastRxAt = now;

        this._log(`IBI series packet ${index}, ${len - 4} bytes (${(len - 4) / 3} intervals).`);
        this._emit('ibi-packet', { index, hex: this._hex(dataView, 4) });
        this._armIbiWatchdog();
      } else {
        const hex = this._hex(dataView, 2);
        this._log(
          `Unknown waveform control packet FF ${marker.toString(16).padStart(2, '0')}` +
          (hex ? ` with ${len - 2} payload byte(s): ${hex}` : ' (no payload)') +
          '. Ignored — not treated as samples.',
          'warn'
        );
        this._emit('unknown-marker', { marker, payload: hex });
      }
      return;
    }

    // Bulk chunk: 2-byte BIG-endian index, then int16 LITTLE-endian samples.
    if (this._waveMode === 'bulk' && len > 2) {
      // The index exists so lost notifications can be spotted; a silent gap here
      // is indistinguishable from a short recording once the samples are merged.
      const index = dataView.getUint16(0, false);
      if (index !== this._bulkNextIndex) {
        const lost = index - this._bulkNextIndex;
        if (lost > 0) {
          this._bulkGaps += lost;
          this._log(`Chunk index jumped ${this._bulkNextIndex} → ${index}: ${lost} chunk(s) lost.`, 'warn');
        } else {
          this._log(`Out-of-order chunk index ${index} (expected ${this._bulkNextIndex}).`, 'warn');
        }
      }
      this._bulkNextIndex = index + 1;

      this._bulkChunks++;
      for (let off = 2; off + 1 < len; off += 2) {
        this._bulkBuffer.push(dataView.getInt16(off, true));
      }
      this._emit('bulk-progress', {
        samples: this._bulkBuffer.length,
        chunks: this._bulkChunks,
        lastIndex: index,
      });
      this._armBulkWatchdog();
    }
  }
}
