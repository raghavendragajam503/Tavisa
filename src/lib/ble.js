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
};

// The firmware streams bulk chunks back-to-back with no pacing gaps, so a pause
// this long means the transfer died rather than that it is merely slow. Without
// this, a truncated transfer leaves the UI waiting on an end marker forever.
const BULK_STALL_MS = 10000;

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
    this.device.addEventListener('gattserverdisconnected', () => {
      this._log('Device disconnected.', 'error');
      this._emit('disconnected');
    });

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
    this._emit('connected', { missing });
    return { missing };
  }

  async disconnect() {
    this._clearBulkWatchdog();
    this._waveMode = 'idle';
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
  async sendBiomarkers({ hba1c = 0, totalChol = 0, ldl = 0, hdl = 0, crp = 0 } = {}) {
    const csv = [hba1c, totalChol, ldl, hdl, crp].map((v) => Number(v) || 0).join(',');
    await this._write(csv);
    this._log('Sent biomarkers: ' + csv, 'ok');
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
    this._emit('device-hrv', { rmssd, sdnn, lfhf });
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

  _armBulkWatchdog() {
    this._clearBulkWatchdog();
    this._bulkTimer = setTimeout(() => {
      if (this._waveMode !== 'bulk') return;
      this._waveMode = 'idle';
      this._log(
        `Bulk transfer stalled — no chunk for ${BULK_STALL_MS / 1000}s. Received ` +
        `${this._bulkBuffer.length} samples in ${this._bulkChunks} chunks, and the ` +
        `end marker (FF 04) never arrived. The device stopped transmitting mid-transfer.`,
        'error'
      );
      this._emit('bulk-stalled', {
        waveform: this._bulkBuffer.slice(),
        chunks: this._bulkChunks,
        gaps: this._bulkGaps,
      });
    }, BULK_STALL_MS);
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
          this._log(`End-of-stream (FF ${marker.toString(16).padStart(2, '0')}) outside a bulk transfer — ignored.`);
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
          auxBytes: this._auxBytes,
        });
      } else if (marker === 0x05) {
        // 26-byte header opening the bulk phase. Field layout not yet known, so
        // it is captured verbatim for inspection rather than decoded on a guess.
        this._bulkHeader = this._hex(dataView, 2);
        this._log(`Bulk header (FF 05), ${len - 2} bytes: ${this._bulkHeader}`);
        this._emit('bulk-header', { hex: this._bulkHeader });
        this._armBulkWatchdog();
      } else if (marker === 0x06) {
        // A SECOND indexed stream, sent after the waveform: 2-byte BIG-endian
        // index then a payload whose total length across the run is divisible by
        // 3 and not by 2 — so these are 3-byte records, NOT int16 samples. They
        // must never be merged into the waveform.
        const index = dataView.getUint16(2, false);
        this._auxBytes += len - 4;
        this._auxPackets++;
        this._log(`Aux stream (FF 06) packet ${index}, ${len - 4} data bytes.`);
        this._emit('aux-packet', { index, hex: this._hex(dataView, 4) });
        this._armBulkWatchdog();
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
