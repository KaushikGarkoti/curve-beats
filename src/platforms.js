/**
 * PLATFORM SYSTEM
 * ---------------
 * Platforms are visual markers placed at the landing position of each
 * BOUNCE event.  ROLL events do not produce stand-alone platforms — the
 * ball rolls over the track geometry that is placed statically in the scene.
 *
 * Orientation: **horizontal ledges** on the vertical wall (world +Y = pad
 * normal). The trajectory uses gravity on bounce segments (accel −g in Y),
 * so impacts are from above; banked “race track” tilt from velocity looked
 * arbitrary here. Optional **yaw** aligns the pad with horizontal motion
 * (vx, vz) only — no pitch/roll from the approach vector.
 */

import * as THREE from 'three';
import { P, arrivalVelocity } from './trajectory.js';
import { params } from './params.js';

/** Pad mesh is BoxGeometry(…, 0.13, …) — half-extent in Y */
const PAD_HALF_Y = 0.065;

/**
 * Idle pad look: emissive matches pad tint so surfaces read as lit (bloom picks up BLOOM_LAYER pads).
 * @param {THREE.MeshStandardMaterial} mat
 */
export function applyPadBaseEmissive(mat) {
  if (!mat || !('emissive' in mat) || !('color' in mat)) return;
  const base = params.fx.platformEmissiveBase;
  mat.emissive.copy(mat.color).multiplyScalar(base);
}

/**
 * Orient and position a platform Group at BOUNCE event time t.
 *
 * @param {THREE.Group} group
 * @param {number} t  event time
 * @param {(t: number) => THREE.Vector3} evalPos  position evaluator (defaults to primary P)
 * @param {(t: number) => THREE.Vector3} evalVel  arrival velocity evaluator
 */
function orientPlatform(group, t, evalPos = P, evalVel = arrivalVelocity) {
  const ball = evalPos(t);
  const pos = ball.clone();

  const aVel = evalVel(t);
  const h = new THREE.Vector3(aVel.x, 0, aVel.z);
  let yaw = 0;
  if (h.lengthSq() > 1e-8) {
    yaw = Math.atan2(h.x, h.z);
  }
  group.rotation.set(0, yaw, 0);

  const br = params.main.ballRadius;
  pos.y = ball.y - br - PAD_HALF_Y;
  pos.x = ball.x;
  pos.z = ball.z;
  group.position.copy(pos);
}

/**
 * Claim a free pool slot and show the platform for the given BOUNCE event.
 *
 * @param {THREE.Group[]} pool
 * @param {number}        eventIndex
 * @param {number}        eventTime
 * @param {number} [padColorHex] optional pad color (MIDI pitch mapping)
 * @param {(t: number) => THREE.Vector3} [evalPos]  position evaluator (omit = primary trajectory)
 * @param {(t: number) => THREE.Vector3} [evalVel]  velocity evaluator (omit = primary trajectory)
 */
export function activatePlatform(pool, eventIndex, eventTime, padColorHex, evalPos, evalVel) {
  let group = pool.find(g => !g.visible);
  if (!group) {
    group = pool.reduce((oldest, g) =>
      g.userData.eventIndex < oldest.userData.eventIndex ? g : oldest
    );
  }

  group.userData.eventIndex = eventIndex;
  group.userData.scaleAnim  = null;
  group.userData.glowAnim   = null;
  group.scale.set(1, 1, 1);
  resetPadGlow(group);
  group.visible = true;

  orientPlatform(group, eventTime, evalPos, evalVel);
  if (padColorHex !== undefined) setPlatformPadColor(group, padColorHex);
}

/**
 * @param {THREE.Group} group platform group (pad = children[0])
 * @param {number} colorHex THREE.MeshStandardMaterial color hex
 */
export function setPlatformPadColor(group, colorHex) {
  const pad = group.children[0];
  if (pad && pad.material && 'color' in pad.material) {
    pad.material.color.setHex(colorHex);
    applyPadBaseEmissive(pad.material);
  }
}

function resetPadGlow(group) {
  const pad = group.children[0];
  if (pad?.material) applyPadBaseEmissive(pad.material);
  group.userData.glowAnim = null;
}

/**
 * Hide every pooled platform and clear animation state. Call whenever `segments` / eventTimes
 * change (regenerate MIDI, new file) so old positions are not left visible — otherwise only
 * the next lookahead window overwrites slots and the rest of the pool stays on the old curve.
 *
 * @param {THREE.Group[]} pool
 */
export function resetPlatformPool(pool) {
  for (const group of pool) {
    group.visible = false;
    group.userData.eventIndex = -1;
    group.userData.scaleAnim = null;
    group.userData.glowAnim = null;
    group.scale.set(1, 1, 1);
    resetPadGlow(group);
  }
}

/**
 * “Light bulb” intensity: fast strike → hold at full → smooth dim (0 ≤ p ≤ 1).
 */
function bulbGlowEnvelope(p) {
  const fx = params.fx;
  const strike = Math.min(0.35, Math.max(0.02, fx.platformGlowStrike ?? 0.065));
  const hold = Math.min(0.55, Math.max(0.05, fx.platformGlowHoldFrac ?? 0.28));
  const holdEnd = Math.min(0.92, strike + hold);

  if (p < strike) {
    const t = strike > 1e-6 ? p / strike : 1;
    return 1 - Math.exp(-6 * t);
  }
  if (p < holdEnd) {
    return 1;
  }
  const u = (p - holdEnd) / Math.max(1e-6, 1 - holdEnd);
  return Math.exp(-4.2 * u);
}

/**
 * Hide platforms whose event time is more than trailWindow seconds past.
 */
export function cullOldPlatforms(pool, eventTimes, currentT, trailWindow = 2.0) {
  const n = eventTimes.length;
  for (const group of pool) {
    if (!group.visible) continue;
    const idx = group.userData.eventIndex;
    const et = eventTimes[idx];
    if (idx < 0 || idx >= n || et === undefined) {
      group.visible = false;
      resetPadGlow(group);
      continue;
    }
    if (et < currentT - trailWindow) {
      group.visible = false;
      resetPadGlow(group);
    }
  }
}

/**
 * Trigger the impact squash + “light bulb” emissive on the platform for eventIndex:
 * quick strike → hold at full brightness → dim. Length scales with beat (`secondsPerBeat`).
 *
 * @param {number} [secondsPerBeat] defaults to 0.5 (120 BPM)
 */
export function animatePlatformHit(pool, eventIndex, now, secondsPerBeat = 0.5) {
  const group = pool.find(g => g.visible && g.userData.eventIndex === eventIndex);
  if (!group) return;
  group.userData.scaleAnim = { startTime: now, duration: 0.22 };

  const beat = Math.max(0.08, secondsPerBeat);
  const glowDur = params.fx.platformGlowBeats * beat;
  group.userData.glowAnim = { startTime: now, duration: Math.max(0.06, glowDur) };
}

/**
 * Advance all active platform scale + glow animations.
 */
export function updatePlatformAnimations(pool, now) {
  const base = params.fx.platformEmissiveBase;
  const peak = params.fx.platformGlowPeak;

  for (const group of pool) {
    if (!group.visible) continue;

    const pad = group.children[0];
    const mat = pad?.material;

    if (group.userData.glowAnim && mat && 'emissive' in mat && 'color' in mat) {
      const { startTime, duration } = group.userData.glowAnim;
      const age = now - startTime;
      if (age > duration) {
        applyPadBaseEmissive(mat);
        group.userData.glowAnim = null;
      } else {
        const p = age / duration;
        const env = bulbGlowEnvelope(p);
        const intensity = base + (peak - base) * env;
        mat.emissive.copy(mat.color).multiplyScalar(intensity);
      }
    } else if (mat && 'emissive' in mat && 'color' in mat) {
      applyPadBaseEmissive(mat);
    }

    if (!group.userData.scaleAnim) continue;

    const { startTime, duration } = group.userData.scaleAnim;
    const age = now - startTime;

    if (age > duration) {
      group.scale.set(1, 1, 1);
      group.userData.scaleAnim = null;
      continue;
    }

    const p   = age / duration;
    const env = Math.sin(Math.PI * p) * Math.exp(-3.5 * p);
    group.scale.set(1 + 0.30 * env, 1 - 0.22 * env, 1 + 0.30 * env);
  }
}
