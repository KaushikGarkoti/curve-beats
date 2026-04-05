/**
 * EVENT SYSTEM
 * ------------
 * Beat events are defined by absolute times derived from a rhythmic gap sequence.
 *
 * The gap sequence drives the state machine in segments.js:
 *   gap < bounce threshold (default 0.7 s) → BOUNCE arc
 *   gap ≥ threshold                       → ROLL glide
 *
 * Rhythm pattern (groups of quick bounces separated by longer silences):
 *
 *   ┌─ 4 bounces (0.38 s) ──┐  long roll (1.2 s)
 *   ├─ 3 bounces (0.38 s) ──┤  medium roll (0.9 s)
 *   ├─ 5 bounces (0.32 s) ──┤  long roll (1.4 s)
 *   ├─ 4 bounces (0.40 s) ──┤  short roll (0.80 s)
 *   └─ 6 bounces (0.28 s) ──┘  closing roll (1.5 s)
 *
 * Total: 22 bounce events + 5 roll events = 27 events ≈ 13.5 s
 */

// Each number is the time gap (seconds) between consecutive events.
// The cumulative sum of these gaps gives the absolute event times.
const GAP_SEQUENCE = [
  // — group 1: four bounces —
  0.38, 0.38, 0.38, 0.38,
  // — long roll —
  1.20,
  // — group 2: three bounces —
  0.38, 0.38, 0.38,
  // — medium roll —
  0.90,
  // — group 3: five tight bounces —
  0.32, 0.32, 0.32, 0.32, 0.32,
  // — long roll —
  1.40,
  // — group 4: four bounces —
  0.40, 0.40, 0.40, 0.40,
  // — short roll —
  0.80,
  // — group 5: six fast bounces —
  0.28, 0.28, 0.28, 0.28, 0.28, 0.28,
  // — closing roll —
  1.50,
];

/**
 * Convert the gap sequence into absolute event times.
 * The i-th time is the moment the i-th beat fires.
 * @returns {number[]}
 */
export function generateEventTimes() {
  const times = [];
  let t = 0;
  for (const gap of GAP_SEQUENCE) {
    t = +(t + gap).toFixed(4); // avoid floating-point drift
    times.push(t);
  }
  return times;
}

/**
 * Track which events have already fired (prevents double-triggering).
 * @returns {Set<number>}
 */
export function createEventTracker() {
  return new Set();
}

/**
 * Return all event indices whose time falls in [t, t + window)
 * and have not yet fired.
 *
 * @param {number[]}    eventTimes
 * @param {Set<number>} fired
 * @param {number}      t       current playback time (seconds)
 * @param {number}      window  detection window in seconds (≈ 2 frames at 60 fps)
 * @returns {{ index: number, time: number }[]}
 */
export function pollEvents(eventTimes, fired, t, window = 0.04) {
  const hits = [];
  for (let i = 0; i < eventTimes.length; i++) {
    if (fired.has(i)) continue;
    const diff = t - eventTimes[i];
    if (diff >= 0 && diff < window) {
      fired.add(i);
      hits.push({ index: i, time: eventTimes[i] });
    }
  }
  return hits;
}
