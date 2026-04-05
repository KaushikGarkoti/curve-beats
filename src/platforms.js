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

/** Pad mesh is BoxGeometry(…, 0.30, …) — half-extent in Y.  Must match scene.js geometry. */
const PAD_HALF_Y = 0.15;

/** Scale emissive when a diffuse `map` is present so albedo isn’t washed out by tint + bloom. */
const EMISSIVE_MAP_SCALE = 0.3;

/**
 * @param {THREE.MeshStandardMaterial | null | undefined} mat
 */
export function padEmissiveMapScale(mat) {
  return mat?.map ? EMISSIVE_MAP_SCALE : 1;
}

/**
 * Idle pad look: emissive matches pad tint so surfaces read as lit (bloom picks up BLOOM_LAYER pads).
 * @param {THREE.MeshStandardMaterial} mat
 */
export function applyPadBaseEmissive(mat) {
  if (!mat || !('emissive' in mat) || !('color' in mat)) return;
  const base = params.fx.platformEmissiveBase;
  mat.emissive.copy(mat.color).multiplyScalar(base * padEmissiveMapScale(mat));
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
  const aVel = evalVel(t);

  // ── Wall-mounted shelf constraint ─────────────────────────────────────────
  // A shelf bolted to the wall via struts has two and only two degrees of
  // freedom: pitch (front edge up/down, i.e. rotation around world X) and
  // bank (left/right lean, i.e. rotation around world Z).  There is NO yaw
  // (the struts stop the shelf from spinning around the Y axis).
  //
  // Pitch  (rotation.x): driven by how steeply the ball falls.
  //   atan2(-vy, hSpeed) = approach angle from horizontal.
  //   Steeper fall → larger pitch (shelf face tilts more toward camera).
  //   Scaled by 0.28; clamped ±0.45 rad.
  // Pitch (rotation.x): very subtle forward lean based on fall steepness.
  // The true perpendicular in XY is handled entirely by bank (Z rotation), so
  // pitch only serves as a depth cue — kept small to avoid compounding error.
  const hSpeed = Math.hypot(aVel.x, aVel.z) + 0.01;
  const pitch  = Math.max(-0.18, Math.min(0.18, Math.atan2(-aVel.y, hSpeed) * 0.08));

  // Bank (rotation.z): driven by the ball's lateral (X) arrival direction.
  //   Ball from LEFT  (vx > 0) → left edge higher  → positive Z (CCW from camera).
  //   Ball from RIGHT (vx < 0) → right edge higher → negative Z (CW from camera).
  //
  //   True perpendicular: the Z rotation that rotates the platform normal from
  //   (0,1,0) to oppose the arrival velocity is exactly atan2(vx, −vy) — no
  //   scaling needed.  Proof: rotate +Y by theta around Z → (−sinθ, cosθ, 0);
  //   set equal to −normalize(vx,vy) → sinθ=vx/speed, cosθ=−vy/speed →
  //   theta = atan2(vx, −vy).
  //
  //   We apply 0.92 of the full angle so the platform reads clearly as a surface
  //   rather than edge-on; clamped to ±0.72 rad (~41°) to avoid extreme cases.
  const bank = Math.max(-0.72, Math.min(0.72, Math.atan2(aVel.x, -aVel.y) * 0.92));

  // Set rotation directly — no quaternion composition, no yaw.
  group.rotation.set(pitch, 0, bank);

  // ── Position ──────────────────────────────────────────────────────────────
  const br = params.main.ballRadius;
  const pos = ball.clone();
  pos.y = ball.y - br - PAD_HALF_Y;
  group.position.copy(pos);

  // Store base Y for the dip spring animation
  group.userData.baseY = pos.y;
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
 * @param {boolean} [isStairPad=false]  true for fast-note stair pads (rendered smaller)
 */
export function activatePlatform(pool, eventIndex, eventTime, padColorHex, evalPos, evalVel, isStairPad = false) {
  let group = pool.find(g => !g.visible);
  if (!group) {
    group = pool.reduce((oldest, g) =>
      g.userData.eventIndex < oldest.userData.eventIndex ? g : oldest
    );
  }

  group.userData.eventIndex = eventIndex;
  group.userData.isStairPad = isStairPad;
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

  // Scale squash (XZ expand, Y compress) — existing
  group.userData.scaleAnim = { startTime: now, duration: 0.22 };

  // Spring dip: platform physically drops then bounces back, giving collision weight
  group.userData.dipAnim = { startTime: now, duration: 0.30, depth: 0.18 };

  const beat = Math.max(0.08, secondsPerBeat);
  const glowDur = params.fx.platformGlowBeats * beat;
  group.userData.glowAnim = { startTime: now, duration: Math.max(0.06, glowDur) };
}

/**
 * Two-phase spring envelope for the dip:
 *   Phase 1 (p ∈ 0→0.38): drop to −1 then back to 0  (compression)
 *   Phase 2 (p ∈ 0.38→1):  bounce up to +0.3 then settle  (rebound)
 * @param {number} p  normalised time 0→1
 */
function dipEnvelope(p) {
  if (p < 0.38) {
    return -Math.sin(Math.PI * (p / 0.38)); // 0 → −1 → 0
  }
  const q = (p - 0.38) / 0.62;
  return 0.30 * Math.sin(Math.PI * q) * Math.exp(-4.5 * q); // 0 → +0.3 → 0
}

/**
 * Advance all active platform scale + glow animations.
 */
export function updatePlatformAnimations(pool, now) {
  const base = params.fx.platformEmissiveBase;
  const peak = params.fx.platformGlowPeak;
  const ms   = params.scene.masterScale;

  for (const group of pool) {
    if (!group.visible) continue;
    const padScale = ms * (group.userData.isStairPad ? (params.main.fastPadScale ?? 0.55) : 1);

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
        mat.emissive.copy(mat.color).multiplyScalar(intensity * padEmissiveMapScale(mat));
      }
    } else if (mat && 'emissive' in mat && 'color' in mat) {
      applyPadBaseEmissive(mat);
    }

    // ── Scale squash ────────────────────────────────────────────────────────
    if (group.userData.scaleAnim) {
      const { startTime, duration } = group.userData.scaleAnim;
      const age = now - startTime;
      if (age > duration) {
        group.scale.setScalar(padScale);
        group.userData.scaleAnim = null;
      } else {
        const p   = age / duration;
        const env = Math.sin(Math.PI * p) * Math.exp(-3.5 * p);
        group.scale.set((1 + 0.30 * env) * padScale, (1 - 0.22 * env) * padScale, (1 + 0.30 * env) * padScale);
      }
    } else if (!group.userData.dipAnim) {
      group.scale.setScalar(padScale);
    }

    // ── Dip spring ──────────────────────────────────────────────────────────
    if (group.userData.dipAnim) {
      const { startTime, duration, depth } = group.userData.dipAnim;
      const age = now - startTime;
      if (age > duration) {
        if (group.userData.baseY !== undefined) group.position.y = group.userData.baseY;
        group.userData.dipAnim = null;
      } else {
        const p = age / duration;
        if (group.userData.baseY !== undefined) {
          group.position.y = group.userData.baseY + dipEnvelope(p) * depth;
        }
      }
    }
  }
}
