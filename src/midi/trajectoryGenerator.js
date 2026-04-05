import { buildSegments } from '../segments.js';
import { params } from '../params.js';

/**
 * @typedef {import('./midiParser.js').MidiNoteEvent} MidiNoteEvent
 */

/** Chord notes share the same onset time; the ball needs one landing per time, not zero-length gaps. */
const SIMULTANEOUS_ONSET_EPS = 1e-5;

/**
 * Keep first note at each onset (sorted input). Full `notes` is still returned for audio scheduling.
 * @param {MidiNoteEvent[]} notes sorted by time ascending
 */
function collapseSimultaneousOnsets(notes) {
  if (!notes.length) return [];
  const out = [notes[0]];
  for (let i = 1; i < notes.length; i++) {
    if (Math.abs(notes[i].time - out[out.length - 1].time) < SIMULTANEOUS_ONSET_EPS) continue;
    out.push(notes[i]);
  }
  return out;
}

/**
 * Build segmented trajectory from ordered note events.
 * Gap between note[i-1] and note[i] → segment i (same convention as segments.js).
 *
 * @param {MidiNoteEvent[]} notes sorted by time
 * @param {{ bounceThreshold?: number, secondsPerBeat?: number }} [options]
 */
export function generateTrajectoryFromNotes(notes, options = {}) {
  const bounceThreshold = options.bounceThreshold ?? params.trajectory.bounceThreshold;
  const secondsPerBeat  = options.secondsPerBeat ?? 60 / 120;

  const collapsed = collapseSimultaneousOnsets(notes);
  const eventTimes = collapsed.map(n => n.time);
  const { segments, landingPositions, landingTypes, eventUsesSustainedRail } = buildSegments(eventTimes, {
    bounceThreshold,
    secondsPerBeat,
    notes: collapsed.map(n => ({ duration: n.duration, midi: n.midi })),
  });

  const landingPitches = collapsed.map(n => n.midi);

  return {
    segments,
    eventTimes,
    landingTypes,
    landingPositions,
    landingPitches,
    eventUsesSustainedRail,
    notes,
  };
}
