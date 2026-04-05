/**
 * Heuristic MIDI “pattern” features from note lists (post–midiParser).
 * Not music-theory ground truth — useful for gameplay / visualization rules.
 */

/**
 * @typedef {import('./midiParser.js').MidiNoteEvent} MidiNoteEvent
 */

/**
 * @typedef {{
 *   index: number,
 *   time: number,
 *   midi: number,
 *   duration: number,
 *   velocity: number,
 *   ioiSec: number | null,
 *   ioiBeats: number | null,
 *   densityWindow: number,
 *   sustainRatio: number | null,
 *   legatoOverlap: boolean,
 *   beatPhase: number,
 *   beatInBar: number,
 *   metricStrength: number,
 *   syncopationWeight: number,
 *   tripletAffinity: number,
 * }} PatternNoteRow
 */

/**
 * @typedef {{
 *   startIndex: number,
 *   endIndex: number,
 *   t0: number,
 *   t1: number,
 * }} PhraseSpan
 */

/**
 * @typedef {{
 *   secondsPerBeat: number,
 *   beatsPerBar: number,
 *   windowSec: number,
 *   phraseGapBeats: number,
 *   perNote: PatternNoteRow[],
 *   phrases: PhraseSpan[],
 *   summary: {
 *     noteCount: number,
 *     medianIoiBeats: number,
 *     meanIoiBeats: number,
 *     notesPerSecond: number,
 *     maxDensityWindow: number,
 *     meanSyncopationWeight: number,
 *     meanTripletAffinity: number,
 *     sustainedNoteFraction: number,
 *     phraseCount: number,
 *     burstWindowsFraction: number,
 *   },
 * }} MidiPatternFeaturesResult
 */

/**
 * @param {number[]} sorted
 */
function median(sorted) {
  if (!sorted.length) return NaN;
  const m = sorted.slice().sort((a, b) => a - b);
  const mid = Math.floor(m.length / 2);
  return m.length % 2 ? m[mid] : (m[mid - 1] + m[mid]) / 2;
}

/**
 * Metric strength 0–1 for simple meters: downbeat strongest, then beat 3 in 4/4.
 * @param {number} beatInBar 0 .. beatsPerBar-1
 * @param {number} beatsPerBar
 */
function metricStrengthSimple(beatsPerBar, beatInBar) {
  const b = ((beatInBar % beatsPerBar) + beatsPerBar) % beatsPerBar;
  if (b === 0) return 1;
  if (beatsPerBar === 4 && b === 2) return 0.65;
  if (beatsPerBar === 3 && b === 1) return 0.5;
  return 0.28;
}

/**
 * Compare how well IOI (in beats) matches triplet vs duple subdivision grids.
 * Returns roughly in [-1, 1]: positive → closer to triplet grid.
 * @param {number} ioiBeats
 */
function tripletVsStraightAffinity(ioiBeats) {
  if (!(ioiBeats > 0) || !Number.isFinite(ioiBeats)) return 0;
  let bestStraight = Infinity;
  for (let denom = 2; denom <= 32; denom *= 2) {
    const unit = 1 / denom;
    for (let m = 1; m <= denom * 16; m++) {
      const d = Math.abs(ioiBeats - m * unit);
      if (d < bestStraight) bestStraight = d;
    }
  }
  let bestTriplet = Infinity;
  for (const denom of [3, 6, 12, 24]) {
    const unit = 1 / denom;
    for (let m = 1; m <= denom * 16; m++) {
      const d = Math.abs(ioiBeats - m * unit);
      if (d < bestTriplet) bestTriplet = d;
    }
  }
  const tol = 0.06;
  return Math.max(-1, Math.min(1, (bestStraight - bestTriplet) / tol));
}

/**
 * @param {MidiNoteEvent[]} notes sorted by time ascending
 * @param {{
 *   secondsPerBeat?: number,
 *   beatsPerBar?: number,
 *   windowSec?: number,
 *   phraseGapBeats?: number,
 *   burstDensityNotesPerSec?: number,
 * }} [options]
 * @returns {MidiPatternFeaturesResult}
 */
export function computeMidiPatternFeatures(notes, options = {}) {
  const secondsPerBeat = options.secondsPerBeat ?? 0.5;
  const beatsPerBar = Math.max(1, options.beatsPerBar ?? 4);
  const windowSec = Math.max(0.02, options.windowSec ?? 0.35);
  const phraseGapBeats = Math.max(0.25, options.phraseGapBeats ?? 2);
  const burstDensityNotesPerSec = options.burstDensityNotesPerSec ?? 10;

  const n = notes.length;
  /** @type {PatternNoteRow[]} */
  const perNote = [];

  if (!n) {
    return {
      secondsPerBeat,
      beatsPerBar,
      windowSec,
      phraseGapBeats,
      perNote: [],
      phrases: [],
      summary: {
        noteCount: 0,
        medianIoiBeats: NaN,
        meanIoiBeats: NaN,
        notesPerSecond: 0,
        maxDensityWindow: 0,
        meanSyncopationWeight: 0,
        meanTripletAffinity: 0,
        sustainedNoteFraction: 0,
        phraseCount: 0,
        burstWindowsFraction: 0,
      },
    };
  }

  const t0 = notes[0].time;
  const t1 = notes[n - 1].time + notes[n - 1].duration;
  const spanSec = Math.max(1e-6, t1 - t0);

  /** @type {number[]} */
  const ioiBeatsList = [];

  for (let i = 0; i < n; i++) {
    const note = notes[i];
    const vel =
      note && typeof /** @type {{ velocity?: number }} */ (note).velocity === 'number'
        ? /** @type {{ velocity?: number }} */ (note).velocity
        : 0.78;

    const ioiSec = i < n - 1 ? notes[i + 1].time - note.time : null;
    const ioiBeats =
      ioiSec != null && ioiSec > 0 ? ioiSec / secondsPerBeat : null;
    if (ioiBeats != null && ioiBeats > 0) ioiBeatsList.push(ioiBeats);

    let densityWindow = 1;
    const tw = windowSec * 0.5;
    const lo = note.time - tw;
    const hi = note.time + tw;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const t = notes[j].time;
      if (t >= lo && t <= hi) densityWindow += 1;
    }

    let sustainRatio = null;
    if (ioiSec != null && ioiSec > 1e-8) {
      sustainRatio = Math.min(4, note.duration / ioiSec);
    } else {
      sustainRatio = 1;
    }

    const prev = i > 0 ? notes[i - 1] : null;
    const legatoOverlap =
      !!prev && prev.time + prev.duration > note.time + 1e-6;

    const beatFloat = note.time / secondsPerBeat;
    const beatPhase = beatFloat - Math.floor(beatFloat);
    const beatIndex = Math.floor(beatFloat);
    const beatInBar = ((beatIndex % beatsPerBar) + beatsPerBar) % beatsPerBar;
    const mStrength = metricStrengthSimple(beatsPerBar, beatInBar);

    const velNorm = Math.max(0, Math.min(1, vel));
    /** Emphasis on weak metric positions + off-center phase within the beat. */
    const offMetric = velNorm * (1 - mStrength);
    const offPhase = velNorm * (1 - Math.cos(4 * Math.PI * beatPhase)) * 0.5;
    const syncopationWeight = 0.55 * offMetric + 0.45 * offPhase;

    const tripletAffinity =
      ioiBeats != null && ioiBeats > 0 ? tripletVsStraightAffinity(ioiBeats) : 0;

    perNote.push({
      index: i,
      time: note.time,
      midi: note.midi,
      duration: note.duration,
      velocity: vel,
      ioiSec,
      ioiBeats,
      densityWindow,
      sustainRatio,
      legatoOverlap,
      beatPhase,
      beatInBar,
      metricStrength: mStrength,
      syncopationWeight,
      tripletAffinity,
    });
  }

  /** @type {PhraseSpan[]} */
  const phrases = [];
  let start = 0;
  for (let i = 1; i < n; i++) {
    const gapBeats = (notes[i].time - notes[i - 1].time) / secondsPerBeat;
    if (gapBeats >= phraseGapBeats) {
      phrases.push({
        startIndex: start,
        endIndex: i - 1,
        t0: notes[start].time,
        t1: notes[i - 1].time + notes[i - 1].duration,
      });
      start = i;
    }
  }
  phrases.push({
    startIndex: start,
    endIndex: n - 1,
    t0: notes[start].time,
    t1: notes[n - 1].time + notes[n - 1].duration,
  });

  const medianIoiBeats = median(ioiBeatsList);
  const meanIoiBeats =
    ioiBeatsList.length > 0
      ? ioiBeatsList.reduce((a, b) => a + b, 0) / ioiBeatsList.length
      : NaN;

  const notesPerSecond = (n - 1 > 0 ? (n - 1) / spanSec : n / spanSec);
  const maxDensityWindow = Math.max(...perNote.map(r => r.densityWindow), 1);

  const meanSyncopationWeight =
    perNote.reduce((s, r) => s + r.syncopationWeight, 0) / n;
  const meanTripletAffinity =
    perNote.reduce((s, r) => s + r.tripletAffinity, 0) / n;

  const sustainedNoteFraction =
    perNote.filter(r => (r.sustainRatio ?? 0) >= 0.85).length / n;

  let burstWindows = 0;
  for (const r of perNote) {
    if (r.densityWindow / windowSec >= burstDensityNotesPerSec) burstWindows += 1;
  }
  const burstWindowsFraction = burstWindows / n;

  return {
    secondsPerBeat,
    beatsPerBar,
    windowSec,
    phraseGapBeats,
    perNote,
    phrases,
    summary: {
      noteCount: n,
      medianIoiBeats,
      meanIoiBeats,
      notesPerSecond,
      maxDensityWindow,
      meanSyncopationWeight,
      meanTripletAffinity,
      sustainedNoteFraction,
      phraseCount: phrases.length,
      burstWindowsFraction,
    },
  };
}
