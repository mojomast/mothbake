// motif: flatten a MIDI result into sixteenth-note steps a sequencer can play
// directly (`{ step, midi, dur, vel }`, step and dur in sixteenths).

import { decodeMidi } from '../decoders/midi.mjs';
import { requireFile } from './util.mjs';

export const type = 'motif';
export const defaultBucket = 'motifs';

export function bake(job, ctx) {
  const options = ctx.bake ?? {};
  const parsed = decodeMidi(requireFile(ctx, options.slot ?? 'result', type));
  const sixteenth = (parsed.ppq || 480) / 4;
  const maxNotes = options.maxNotes ?? 256;
  const transpose = Number.isFinite(options.transpose) ? Math.round(options.transpose) : 0;
  const notes = parsed.notes.slice(0, maxNotes).map((note) => ({
    step: Math.round(note.step / sixteenth),
    midi: note.midi + transpose,
    dur: Math.max(1, Math.round(note.dur / sixteenth)),
    vel: note.vel,
  }));
  return {
    bucket: options.bucket ?? defaultBucket,
    key: options.name ?? job.id,
    value: { bpm: parsed.bpm, ppq: parsed.ppq, notes },
  };
}
