// Minimal Standard MIDI File (SMF) reader and writer. The reader flattens a
// file into note events (tick, note, duration, velocity); the writer turns
// note events back into a format-0 file, which is what procedural motifs need.

const DEFAULT_PPQ = 480;
const DEFAULT_BPM = 120;

function readVlq(buffer, cursor) {
  let value = 0;
  let byte;
  do {
    byte = buffer[cursor.offset++];
    if (byte === undefined) throw new Error('midi: truncated variable-length quantity');
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);
  return value;
}

function writeVlq(value) {
  const bytes = [value & 0x7f];
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return bytes;
}

/**
 * Parse a Standard MIDI File into `{ bpm, ppq, notes }` where each note is
 * `{ step, midi, dur, vel }` in ticks.
 *
 * @param {Buffer|Uint8Array} buffer
 */
export function decodeMidi(buffer) {
  if (buffer.length < 14 || buffer.toString('ascii', 0, 4) !== 'MThd') throw new Error('midi: not a Standard MIDI File');
  const headerLength = buffer.readUInt32BE(4);
  const division = buffer.readUInt16BE(12);
  if (division & 0x8000) throw new Error('midi: SMPTE time division unsupported');
  const ppq = division || DEFAULT_PPQ;
  let offset = 8 + headerLength;
  let bpm = DEFAULT_BPM;
  const notes = [];
  const active = new Map();

  const close = (midi, tick) => {
    const started = active.get(midi);
    if (!started) return;
    notes.push({ step: started.tick, midi, dur: Math.max(1, tick - started.tick), vel: started.vel });
    active.delete(midi);
  };

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32BE(offset + 4);
    if (id !== 'MTrk') {
      offset += 8 + length;
      continue;
    }
    const end = Math.min(buffer.length, offset + 8 + length);
    offset += 8;
    let tick = 0;
    let running = 0;
    const cursor = { offset };
    while (cursor.offset < end) {
      tick += readVlq(buffer, cursor);
      let status = buffer[cursor.offset];
      if (status & 0x80) {
        cursor.offset++;
        running = status;
      } else {
        status = running;
      }
      const type = status & 0xf0;
      if (type === 0x90) {
        const midi = buffer[cursor.offset++];
        const velocity = buffer[cursor.offset++];
        if (velocity > 0) active.set(midi, { tick, vel: velocity });
        else close(midi, tick);
      } else if (type === 0x80) {
        const midi = buffer[cursor.offset++];
        cursor.offset++;
        close(midi, tick);
      } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
        cursor.offset += 2;
      } else if (type === 0xc0 || type === 0xd0) {
        cursor.offset += 1;
      } else if (status === 0xff) {
        const meta = buffer[cursor.offset++];
        const size = readVlq(buffer, cursor);
        if (meta === 0x51 && size === 3) {
          bpm = Math.round(60000000 / ((buffer[cursor.offset] << 16) | (buffer[cursor.offset + 1] << 8) | buffer[cursor.offset + 2]));
        }
        cursor.offset += size;
      } else if (status === 0xf0 || status === 0xf7) {
        const size = readVlq(buffer, cursor);
        cursor.offset += size;
      } else {
        cursor.offset += 1;
      }
    }
    offset = end;
  }
  notes.sort((a, b) => a.step - b.step || a.midi - b.midi);
  return { bpm, ppq, notes };
}

/**
 * Encode `{ tick, dur, midi, vel }` events as a format-0 MIDI file.
 *
 * @param {Array<{tick: number, dur: number, midi: number, vel?: number}>} notes
 * @param {{ ppq?: number, bpm?: number }} [options]
 * @returns {Buffer}
 */
export function encodeMidi(notes, options = {}) {
  const ppq = options.ppq ?? DEFAULT_PPQ;
  const bpm = options.bpm ?? DEFAULT_BPM;
  const microsPerBeat = Math.round(60000000 / bpm);
  const events = [];
  for (const note of notes) {
    const start = Math.max(0, Math.round(note.tick ?? 0));
    const end = start + Math.max(1, Math.round(note.dur ?? 1));
    events.push([start, [0x90, note.midi & 0x7f, (note.vel ?? 96) & 0x7f]]);
    events.push([end, [0x80, note.midi & 0x7f, 0]]);
  }
  events.sort((a, b) => a[0] - b[0] || (a[1][0] === 0x80 ? -1 : 1));
  const body = [0x00, 0xff, 0x51, 0x03, (microsPerBeat >> 16) & 255, (microsPerBeat >> 8) & 255, microsPerBeat & 255];
  let last = 0;
  for (const [tick, data] of events) {
    body.push(...writeVlq(tick - last), ...data);
    last = tick;
  }
  body.push(0x00, 0xff, 0x2f, 0x00);
  const track = Buffer.from(body);
  const header = Buffer.alloc(14);
  header.write('MThd', 0, 'ascii');
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(1, 10);
  header.writeUInt16BE(ppq, 12);
  const chunk = Buffer.alloc(8);
  chunk.write('MTrk', 0, 'ascii');
  chunk.writeUInt32BE(track.length, 4);
  return Buffer.concat([header, chunk, track]);
}
