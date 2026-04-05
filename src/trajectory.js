/**
 * Trajectory public API — mutable bundle (swap MIDI → regenerate in place).
 */

import * as THREE from 'three';
import { getTrajectoryPoint, sampleTrajectoryPolyline } from './segments.js';

/** @type {import('./segments.js').Segment[]} */
let segments = [];
/** @type {number[]} */
export let eventTimes = [];
/** @type {('BOUNCE'|'ROLL')[]} */
export let landingTypes = [];
/** @type {number[]} MIDI pitch per event index (for platform / FX color) */
export let landingPitches = [];
/** @type {boolean[]} legacy: was “rail only, no pad”; sustained notes now use pad + rail below — kept false. */
export let eventUsesSustainedRail = [];

/**
 * Replace the active trajectory (called after MIDI parse + buildSegments).
 * @param {{
 *   segments: import('./segments.js').Segment[],
 *   eventTimes: number[],
 *   landingTypes: ('BOUNCE'|'ROLL')[],
 *   landingPitches?: number[],
 *   eventUsesSustainedRail?: boolean[],
 * }} bundle
 */
export function setTrajectoryBundle(bundle) {
  segments      = bundle.segments;
  eventTimes    = bundle.eventTimes;
  landingTypes  = bundle.landingTypes;
  landingPitches = bundle.landingPitches ?? bundle.eventTimes.map(() => 60);
  eventUsesSustainedRail = bundle.eventUsesSustainedRail ?? bundle.eventTimes.map(() => false);
}

export function P(t) {
  return getTrajectoryPoint(segments, t).pos;
}

export function velocity(t) {
  return getTrajectoryPoint(segments, t).vel;
}

export function tangent(t) {
  const v = velocity(t);
  return v.lengthSq() > 1e-6 ? v.normalize() : new THREE.Vector3(0, -1, 0);
}

export function ballPosition(t) {
  return P(t);
}

export function getSegmentState(t) {
  return getTrajectoryPoint(segments, t);
}

export function arrivalVelocity(t) {
  // Walk back from the event in small steps until we land in a kinematic
  // (non-SUSTAINED) segment.  This prevents the circular arc tangent of a
  // sustained tube from being mistaken for the ball's arrival direction when
  // the arc ends right at the event time.
  const offsets = [0.001, 0.01, 0.05, 0.15];
  for (const dt of offsets) {
    const state = getTrajectoryPoint(segments, t - dt);
    if (state.type !== 'SUSTAINED' && state.type !== 'SUSTAIN_ENTRY') {
      return state.vel;
    }
  }
  // Fallback: use the last offset even if still in sustained (better than nothing)
  return getTrajectoryPoint(segments, t - offsets[offsets.length - 1]).vel;
}

/** First segment of type ROLL (excludes gap-transition roll halves), for track placement */
export function findFirstRollSegment() {
  return segments.find(
    s => s.type === 'ROLL' && !s.isGapTransition,
  ) ?? null;
}

export function hasTrajectory() {
  return segments.length > 0;
}

/**
 * Stateless trajectory evaluator — used for secondary balls whose bundle
 * lives outside the module-level globals.
 *
 * @param {{ segments: import('./segments.js').Segment[] }} bundle
 * @param {number} t
 */
export function evalTrajectory(bundle, t) {
  return getTrajectoryPoint(bundle.segments, t);
}

/**
 * Sample the active trajectory for export or comparison (same timing as the ball).
 * @param {number} [dt]
 */
export function sampleTrajectoryPath(dt = 0.025) {
  return sampleTrajectoryPolyline(segments, dt);
}
