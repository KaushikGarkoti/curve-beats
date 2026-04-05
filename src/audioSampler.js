import * as Tone from 'tone';
import { params } from './params.js';

// ── Instrument definitions ────────────────────────────────────────────────────

/** Salamander Grand Piano sample URLs (Tone.js CDN) */
const PIANO_URLS = {
  A0: 'A0.mp3', C1: 'C1.mp3', 'D#1': 'Ds1.mp3', 'F#1': 'Fs1.mp3',
  A1: 'A1.mp3', C2: 'C2.mp3', 'D#2': 'Ds2.mp3', 'F#2': 'Fs2.mp3',
  A2: 'A2.mp3', C3: 'C3.mp3', 'D#3': 'Ds3.mp3', 'F#3': 'Fs3.mp3',
  A3: 'A3.mp3', C4: 'C4.mp3', 'D#4': 'Ds4.mp3', 'F#4': 'Fs4.mp3',
  A4: 'A4.mp3', C5: 'C5.mp3', 'D#5': 'Ds5.mp3', 'F#5': 'Fs5.mp3',
  A5: 'A5.mp3', C6: 'C6.mp3', 'D#6': 'Ds6.mp3', 'F#6': 'Fs6.mp3',
  A6: 'A6.mp3', C7: 'C7.mp3',
};

/**
 * Available instruments.
 * Each entry has an `id`, human-readable `label`, and a `create` factory.
 * @type {Array<{ id: string, label: string, create: () => Tone.ToneAudioNode }>}
 */
export const INSTRUMENT_DEFS = [
  {
    id: 'piano',
    label: 'Grand Piano',
    create: () => new Tone.Sampler({
      urls: PIANO_URLS,
      baseUrl: 'https://tonejs.github.io/audio/salamander/',
    }).toDestination(),
  },
  {
    id: 'epliano',
    label: 'Electric Piano',
    create: () => new Tone.FMSynth({
      harmonicity: 8,
      modulationIndex: 2,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 1.2 },
      modulation: { type: 'square' },
      modulationEnvelope: { attack: 0.01, decay: 0.1, sustain: 0.3, release: 0.8 },
      volume: -8,
    }).toDestination(),
  },
  {
    id: 'marimba',
    label: 'Marimba',
    create: () => new Tone.AMSynth({
      harmonicity: 3,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.005, decay: 0.15, sustain: 0.0, release: 0.3 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.01, decay: 0.1, sustain: 0.0, release: 0.2 },
      volume: -6,
    }).toDestination(),
  },
  {
    id: 'bass',
    label: 'Bass Synth',
    create: () => new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      filter: { Q: 2, type: 'lowpass', rolloff: -24 },
      envelope: { attack: 0.02, decay: 0.1, sustain: 0.6, release: 0.3 },
      filterEnvelope: {
        attack: 0.02, decay: 0.2, sustain: 0.4, release: 0.4,
        baseFrequency: 200, octaves: 2,
      },
      volume: -6,
    }).toDestination(),
  },
  {
    id: 'pluck',
    label: 'Plucked String',
    create: () => new Tone.PluckSynth({
      attackNoise: 1,
      dampening: 4000,
      resonance: 0.98,
      volume: -4,
    }).toDestination(),
  },
  {
    id: 'pad',
    label: 'Pad / Strings',
    create: () => new Tone.DuoSynth({
      vibratoAmount: 0.5,
      vibratoRate: 5,
      harmonicity: 1.5,
      voice0: {
        oscillator: { type: 'sine' },
        envelope: { attack: 0.08, decay: 0.1, sustain: 0.8, release: 1.5 },
        filterEnvelope: { attack: 0.06, decay: 0.2, sustain: 0.5, release: 1.0, baseFrequency: 300, octaves: 3 },
      },
      voice1: {
        oscillator: { type: 'sine' },
        envelope: { attack: 0.1, decay: 0.1, sustain: 0.7, release: 1.5 },
        filterEnvelope: { attack: 0.06, decay: 0.2, sustain: 0.5, release: 1.0, baseFrequency: 300, octaves: 3 },
      },
      volume: -10,
    }).toDestination(),
  },
  {
    id: 'lead',
    label: 'Lead Synth',
    create: () => new Tone.Synth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.5 },
      volume: -10,
    }).toDestination(),
  },
  {
    id: 'bells',
    label: 'Bells',
    create: () => new Tone.AMSynth({
      harmonicity: 5.1,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.01, decay: 0.8, sustain: 0.0, release: 0.6 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.0, release: 0.3 },
      volume: -8,
    }).toDestination(),
  },
  {
    id: 'organ',
    label: 'Organ',
    create: () => new Tone.AMSynth({
      harmonicity: 2,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.01, decay: 0.01, sustain: 1.0, release: 0.1 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.01, decay: 0.01, sustain: 1.0, release: 0.1 },
      volume: -10,
    }).toDestination(),
  },
  {
    id: 'xylophone',
    label: 'Xylophone',
    create: () => new Tone.FMSynth({
      harmonicity: 12,
      modulationIndex: 0.5,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.3, sustain: 0.0, release: 0.2 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.001, decay: 0.2, sustain: 0.0, release: 0.1 },
      volume: -6,
    }).toDestination(),
  },
];

// ── State ─────────────────────────────────────────────────────────────────────

/** Lazy-created instrument instances, keyed by instrument id. */
const instrumentCache = /** @type {Map<string, Tone.ToneAudioNode>} */ (new Map());

/**
 * Per-track instrument assignment.
 * Key: String(trackIndex). Value: instrument id.
 * Falls back to 'piano' if not set.
 */
const trackInstrumentMap = /** @type {Map<string, string>} */ (new Map());

// ── Instrument management ─────────────────────────────────────────────────────

/**
 * Create and cache an instrument instance. For 'piano' (Sampler) also waits
 * for all audio buffers to load.
 * @param {string} id
 * @returns {Promise<Tone.ToneAudioNode>}
 */
export async function ensureInstrumentLoaded(id) {
  if (instrumentCache.has(id)) return /** @type {Tone.ToneAudioNode} */ (instrumentCache.get(id));
  const def = INSTRUMENT_DEFS.find(d => d.id === id);
  if (!def) return ensureInstrumentLoaded('piano');
  const inst = def.create();
  instrumentCache.set(id, inst);
  if (id === 'piano') {
    await Tone.loaded();
  }
  return inst;
}

/** @returns {Tone.ToneAudioNode | null} */
export function getSampler() {
  return instrumentCache.get('piano') ?? null;
}

/** Backwards-compatible alias used by main.js before playback. */
export async function ensureSamplerLoaded() {
  return ensureInstrumentLoaded('piano');
}

// ── Per-track assignment ──────────────────────────────────────────────────────

/**
 * Assign an instrument to a track.
 * @param {number | string} trackIndex
 * @param {string} instrumentId
 */
export function setTrackInstrument(trackIndex, instrumentId) {
  trackInstrumentMap.set(String(trackIndex), instrumentId);
}

/**
 * Get the currently assigned instrument id for a track (defaults to 'piano').
 * @param {number | string} trackIndex
 * @returns {string}
 */
export function getTrackInstrument(trackIndex) {
  return trackInstrumentMap.get(String(trackIndex)) ?? 'piano';
}

/** Clear all per-track assignments (called when a new MIDI file is loaded). */
export function resetTrackInstruments() {
  trackInstrumentMap.clear();
}

// ── Playback helpers ──────────────────────────────────────────────────────────

/**
 * Trigger a single note on the given instrument, handling API differences.
 * @param {Tone.ToneAudioNode} inst
 * @param {string | number} freq   frequency string or Hz
 * @param {number} duration        seconds
 * @param {number} audioTime       Tone audio-context time
 */
function triggerNote(inst, freq, duration, audioTime) {
  if (inst instanceof Tone.PluckSynth) {
    // PluckSynth has no release — just attack
    inst.triggerAttack(freq, audioTime);
  } else {
    // @ts-ignore — all other instruments share triggerAttackRelease
    inst.triggerAttackRelease(freq, duration, audioTime);
  }
}

// ── Scheduling ────────────────────────────────────────────────────────────────

/**
 * Cancel any existing Transport schedule and re-schedule all notes.
 * Each note is routed to the instrument assigned to its trackIndex.
 * The instrument is resolved at *playback time* (not schedule time), so
 * mid-session instrument changes take effect without rescheduling.
 *
 * @param {{ time: number, duration: number, midi: number, trackIndex?: number }[]} notes
 */
export function scheduleMidiNotes(notes) {
  Tone.Transport.cancel();
  const a = params.audio;
  for (const n of notes) {
    const trackKey = String(n.trackIndex ?? 0);
    const when = n.time;
    const clampedDur = Math.min(Math.max(n.duration, a.minNoteDuration), a.maxNoteDuration);
    Tone.Transport.schedule((audioTime) => {
      // Resolve instrument at playback time so live changes are reflected
      const instrumentId = getTrackInstrument(trackKey);
      const inst = instrumentCache.get(instrumentId) ?? instrumentCache.get('piano');
      if (!inst) return;
      const freq = Tone.Frequency(n.midi, 'midi').toFrequency();
      triggerNote(inst, freq, clampedDur, audioTime);
    }, when);
  }
}

// ── Transport control ─────────────────────────────────────────────────────────

export async function startPlayback() {
  await Tone.start();
  await ensureSamplerLoaded();
  Tone.Transport.start();
}

export function pausePlayback() {
  Tone.Transport.pause();
}

export function stopPlayback() {
  Tone.Transport.stop();
  Tone.Transport.seconds = 0;
}

/**
 * Jump the Transport timeline (paused). Caller should reschedule MIDI and restart
 * if playback was running.
 * @param {number} seconds
 */
export function seekTransportSeconds(seconds) {
  Tone.Transport.pause();
  Tone.Transport.seconds = Math.max(0, seconds);
}

export function getTransportSeconds() {
  return Tone.Transport.seconds;
}

export function getTransportState() {
  return Tone.Transport.state;
}
