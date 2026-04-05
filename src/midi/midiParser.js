import { Midi } from '@tonejs/midi';

/**
 * @typedef {{ index: number, name: string, noteCount: number }} MidiTrackSummary
 */

/**
 * @typedef {{ time: number, duration: number, midi: number, name: string, trackIndex: number }} MidiNoteEvent
 */

/** Select all non-percussion (pitched) tracks and merge their notes by time. */
export const MERGE_PITCHED_TRACKS = 'merge';

/**
 * @param {Array<{ time: number, duration: number, midi: number, name?: string, trackIndex?: number }>} raw
 * @param {number} [defaultTrackIndex]
 * @returns {MidiNoteEvent[]}
 */
function normalizeNoteEvents(raw, defaultTrackIndex = 0) {
  return raw
    .map(n => ({
      time:       n.time,
      duration:   n.duration,
      midi:       n.midi,
      name:       n.name ?? '',
      trackIndex: n.trackIndex ?? defaultTrackIndex,
    }))
    .sort((a, b) => a.time - b.time);
}

/**
 * Shift times so the earliest note onset is at 0 (removes leading silence for this track).
 * @param {MidiNoteEvent[]} notes sorted by time ascending
 * @returns {{ notes: MidiNoteEvent[], trimSeconds: number }}
 */
function trimLeadingSilence(notes) {
  if (!notes.length) {
    return { notes, trimSeconds: 0 };
  }
  const t0 = notes[0].time;
  if (t0 <= 0) {
    return { notes, trimSeconds: 0 };
  }
  return {
    notes: notes.map(n => ({
      ...n,
      time: n.time - t0,
    })),
    trimSeconds: t0,
  };
}

/**
 * @param {import('@tonejs/midi').Midi} midi
 */
function collectNotesFromMidiPitchedTracks(midi) {
  const raw = [];
  for (let trackIdx = 0; trackIdx < midi.tracks.length; trackIdx++) {
    const track = midi.tracks[trackIdx];
    if (track.instrument.percussion) continue;
    for (const n of track.notes) {
      raw.push({
        time:       n.time,
        duration:   n.duration,
        midi:       n.midi,
        name:       n.name ?? '',
        trackIndex: trackIdx,
      });
    }
  }
  return normalizeNoteEvents(raw);
}

/**
 * @param {import('@tonejs/midi').Midi} midi
 */
function countPitchedTracksMidi(midi) {
  return midi.tracks.filter(t => !t.instrument.percussion).length;
}

/**
 * @param {unknown} t track object from JSON export
 */
function isJsonTrackPitched(t) {
  if (t && typeof t === 'object' && /** @type {{ isPercussion?: boolean }} */ (t).isPercussion === true) {
    return false;
  }
  return true;
}

/**
 * @param {{ tracks: Array<{ notes?: unknown[], name?: string, isPercussion?: boolean }> }} data
 */
function collectNotesFromJsonPitchedTracks(data) {
  const raw = [];
  for (let trackIdx = 0; trackIdx < data.tracks.length; trackIdx++) {
    const t = data.tracks[trackIdx];
    if (!isJsonTrackPitched(t)) continue;
    const arr = Array.isArray(t.notes) ? t.notes : [];
    for (const n of arr) {
      raw.push({
        time:       /** @type {{ time: number }} */ (n).time,
        duration:   /** @type {{ duration: number }} */ (n).duration,
        midi:       /** @type {{ midi: number }} */ (n).midi,
        name:       String(/** @type {{ name?: string }} */ (n).name ?? ''),
        trackIndex: trackIdx,
      });
    }
  }
  return normalizeNoteEvents(raw);
}

/**
 * @param {{ tracks: Array<{ isPercussion?: boolean }> }} data
 */
function countPitchedTracksJson(data) {
  return data.tracks.filter(t => isJsonTrackPitched(t)).length;
}

/**
 * @param {number | typeof MERGE_PITCHED_TRACKS | undefined} selection
 * @param {number} nTracks
 * @param {number} defaultIdx
 */
function resolveMidiTrackSelection(selection, nTracks, defaultIdx) {
  if (selection === MERGE_PITCHED_TRACKS || selection === undefined) {
    return MERGE_PITCHED_TRACKS;
  }
  if (typeof selection === 'number' && Number.isFinite(selection)) {
    return Math.max(0, Math.min(Math.floor(selection), Math.max(0, nTracks - 1)));
  }
  return defaultIdx;
}

/**
 * Index of the track with the most notes (ties → lowest index).
 * @param {import('@tonejs/midi').Midi} midi
 */
export function getDefaultTrackIndex(midi) {
  let best = 0;
  let max = -1;
  midi.tracks.forEach((t, i) => {
    const n = t.notes.length;
    if (n > max) {
      max = n;
      best = i;
    }
  });
  return best;
}

/**
 * @param {import('@tonejs/midi').Midi} midi
 * @returns {MidiTrackSummary[]}
 */
export function getTrackSummariesFromMidi(midi) {
  return midi.tracks.map((t, i) => ({
    index:     i,
    name:      t.name?.trim() ? t.name : `Track ${i}`,
    noteCount: t.notes.length,
  }));
}

/**
 * Parse ArrayBuffer from a .mid file.
 * @param {ArrayBuffer} buffer
 * @param {number | typeof MERGE_PITCHED_TRACKS} [trackSelection] Single track index, or `MERGE_PITCHED_TRACKS` / omit to merge all pitched (non-drum) tracks.
 * @returns {{
 *   midi: import('@tonejs/midi').Midi,
 *   notes: MidiNoteEvent[],
 *   duration: number,
 *   trackName: string,
 *   trackIndex: number | typeof MERGE_PITCHED_TRACKS,
 *   defaultTrackIndex: number,
 *   pitchedTracksMerged: number,
 *   tracks: MidiTrackSummary[],
 *   secondsPerBeat: number,
 *   bpm: number,
 * }}
 */
export function parseMidiBuffer(buffer, trackSelection) {
  const midi = new Midi(buffer);
  const summaries = getTrackSummariesFromMidi(midi);
  const defaultIdx = getDefaultTrackIndex(midi);
  const nTracks = midi.tracks.length;
  const sel = resolveMidiTrackSelection(trackSelection, nTracks, defaultIdx);

  let normalized;
  let trackName;
  /** @type {number | typeof MERGE_PITCHED_TRACKS} */
  let idx;
  let pitchedTracksMerged = 0;

  if (sel === MERGE_PITCHED_TRACKS) {
    normalized = collectNotesFromMidiPitchedTracks(midi);
    pitchedTracksMerged = countPitchedTracksMidi(midi);
    trackName = 'All pitched tracks (merged)';
    idx = MERGE_PITCHED_TRACKS;
  } else {
    const track = midi.tracks[sel];
    normalized = normalizeNoteEvents(track.notes, sel);
    trackName = track.name?.trim() ? track.name : summaries[sel].name;
    idx = sel;
    pitchedTracksMerged = track.instrument.percussion ? 0 : 1;
  }

  const { notes, trimSeconds } = trimLeadingSilence(normalized);

  const bpm = midi.header.tempos[0]?.bpm ?? 120;
  const secondsPerBeat = 60 / bpm;

  const duration = Math.max(0, midi.duration - trimSeconds);

  return {
    midi,
    notes,
    duration,
    trackName,
    trackIndex: idx,
    defaultTrackIndex: defaultIdx,
    pitchedTracksMerged,
    tracks: summaries,
    secondsPerBeat,
    bpm,
  };
}

/**
 * @param {{ tracks: Array<{ notes?: unknown[], name?: string }> }} data
 */
function getDefaultTrackIndexFromJson(data) {
  let best = 0;
  let max = -1;
  data.tracks.forEach((t, i) => {
    const n = Array.isArray(t.notes) ? t.notes.length : 0;
    if (n > max) {
      max = n;
      best = i;
    }
  });
  return best;
}

/**
 * @param {{ tracks: Array<{ notes?: unknown[], name?: string }> }} data
 * @returns {MidiTrackSummary[]}
 */
function getTrackSummariesFromJson(data) {
  return data.tracks.map((t, i) => ({
    index:     i,
    name:      t.name && String(t.name).trim() ? String(t.name) : `Track ${i}`,
    noteCount: Array.isArray(t.notes) ? t.notes.length : 0,
  }));
}

/**
 * Parse bundled JSON export (`src/midis/midi.json`). Not the same shape as
 * Tone.js `Midi.fromJSON` — this matches the serialized export used in-repo.
 *
 * @param {{ tracks: Array<{ notes?: unknown[], name?: string, isPercussion?: boolean }>, header?: { bpm?: number, name?: string }, tempo?: Array<{ bpm?: number }>, duration?: number }} data
 * @param {number | typeof MERGE_PITCHED_TRACKS} [trackSelection] Single track index, or merge all pitched tracks.
 * @returns {{
 *   midi: null,
 *   notes: MidiNoteEvent[],
 *   duration: number,
 *   trackName: string,
 *   trackIndex: number | typeof MERGE_PITCHED_TRACKS,
 *   defaultTrackIndex: number,
 *   pitchedTracksMerged: number,
 *   tracks: MidiTrackSummary[],
 *   secondsPerBeat: number,
 *   bpm: number,
 * }}
 */
export function parseMidiJsonExport(data, trackSelection) {
  if (!data?.tracks?.length) {
    throw new Error('Invalid MIDI JSON: missing tracks');
  }

  const summaries = getTrackSummariesFromJson(data);
  const defaultIdx = getDefaultTrackIndexFromJson(data);
  const nTracks = data.tracks.length;
  const sel = resolveMidiTrackSelection(trackSelection, nTracks, defaultIdx);

  let normalized;
  let trackName;
  /** @type {number | typeof MERGE_PITCHED_TRACKS} */
  let idx;
  let pitchedTracksMerged = 0;

  if (sel === MERGE_PITCHED_TRACKS) {
    normalized = collectNotesFromJsonPitchedTracks(data);
    pitchedTracksMerged = countPitchedTracksJson(data);
    trackName = 'All pitched tracks (merged)';
    idx = MERGE_PITCHED_TRACKS;
  } else {
    const raw = /** @type {Array<{ time: number, duration: number, midi: number, name?: string }>} */ (
      data.tracks[sel]?.notes ?? []
    );
    normalized = normalizeNoteEvents(raw, sel);
    trackName =
      summaries[sel].name ||
      data.header?.name ||
      '(unnamed)';
    idx = sel;
    const t = data.tracks[sel];
    pitchedTracksMerged = t && isJsonTrackPitched(t) ? 1 : 0;
  }

  const { notes, trimSeconds } = trimLeadingSilence(normalized);

  const bpm =
    data.header?.bpm ??
    data.tempo?.[0]?.bpm ??
    120;
  const secondsPerBeat = 60 / bpm;

  let duration = typeof data.duration === 'number' ? data.duration : 0;
  if (duration > 0) {
    duration = Math.max(0, duration - trimSeconds);
  }
  if (!duration && notes.length) {
    duration = Math.max(...notes.map(n => n.time + n.duration));
  }

  return {
    midi: null,
    notes,
    duration,
    trackName: trackName || '(unnamed)',
    trackIndex: idx,
    defaultTrackIndex: defaultIdx,
    pitchedTracksMerged,
    tracks: summaries,
    secondsPerBeat,
    bpm,
  };
}
