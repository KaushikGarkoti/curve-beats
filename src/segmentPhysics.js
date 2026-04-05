/**
 * Hybrid segment physics (option C): between note times, motion follows
 *   dv/dt = g - k·v   (linear air drag, k ≥ 0)
 * with RK4 integration. At build time, v0 is solved (Newton) so the arc still
 * hits the planned endPos at tEnd — MIDI sync and landings stay exact.
 */

import * as THREE from 'three';
import { params } from './params.js';

const _tmpP = new THREE.Vector3();
const _tmpV = new THREE.Vector3();

/**
 * @param {THREE.Vector3} pos
 * @param {THREE.Vector3} vel
 * @param {number} k
 */
function derivative(pos, vel, k) {
  const g = params.trajectory.gravity;
  const dvel = new THREE.Vector3(0, -g, 0);
  if (k > 1e-8) dvel.sub(vel.clone().multiplyScalar(k));
  return { dpos: vel.clone(), dvel };
}

/**
 * RK4 step for (pos, vel) with fixed dt.
 */
function rk4Step(pos, vel, dt, k) {
  const k1 = derivative(pos, vel, k);
  _tmpP.copy(pos).addScaledVector(k1.dpos, dt * 0.5);
  _tmpV.copy(vel).addScaledVector(k1.dvel, dt * 0.5);
  const k2 = derivative(_tmpP, _tmpV, k);
  _tmpP.copy(pos).addScaledVector(k2.dpos, dt * 0.5);
  _tmpV.copy(vel).addScaledVector(k2.dvel, dt * 0.5);
  const k3 = derivative(_tmpP, _tmpV, k);
  _tmpP.copy(pos).addScaledVector(k3.dpos, dt);
  _tmpV.copy(vel).addScaledVector(k3.dvel, dt);
  const k4 = derivative(_tmpP, _tmpV, k);

  pos.addScaledVector(k1.dpos, dt / 6);
  pos.addScaledVector(k2.dpos, dt / 3);
  pos.addScaledVector(k3.dpos, dt / 3);
  pos.addScaledVector(k4.dpos, dt / 6);

  vel.addScaledVector(k1.dvel, dt / 6);
  vel.addScaledVector(k2.dvel, dt / 3);
  vel.addScaledVector(k3.dvel, dt / 3);
  vel.addScaledVector(k4.dvel, dt / 6);
}

/**
 * Integrate from t=0 to duration; mutates pos, vel in place (start as copies).
 * @param {THREE.Vector3} pos0
 * @param {THREE.Vector3} vel0
 * @param {number} duration
 * @param {number} k
 * @param {number} [nSteps]  default from duration
 */
export function integrateBounceRK4(pos0, vel0, duration, k, nSteps) {
  const pos = pos0.clone();
  const vel = vel0.clone();
  if (duration <= 1e-9) return { pos, vel };

  const n = nSteps ?? Math.min(2000, Math.max(8, Math.ceil(duration * 600)));
  const dt  = duration / n;
  for (let i = 0; i < n; i++) {
    rk4Step(pos, vel, dt, k);
  }
  return { pos, vel };
}

/**
 * RK step count for bounce integration. Shared by `integrateToEndPos` and `sampleBounceRK4`
 * so the solved arc and sampled polyline use the same resolution.
 */
function bounceIntegrationSteps(duration) {
  return Math.min(2000, Math.max(16, Math.ceil(duration * 800)));
}

/**
 * End position only (for shooting); uses high step count for accuracy.
 * @param {THREE.Vector3} startPos
 * @param {THREE.Vector3} v0
 * @param {number} T
 * @param {number} k
 */
function integrateToEndPos(startPos, v0, T, k) {
  return integrateBounceRK4(startPos, v0, T, k, bounceIntegrationSteps(T)).pos;
}

/**
 * Solve v0 so integrate(start, v0, T) ≈ endPos (XY; Z fixed by start/end).
 * @param {THREE.Vector3} startPos
 * @param {THREE.Vector3} endPos
 * @param {number} T
 * @param {number} k
 * @param {THREE.Vector3} hintV0  kinematic guess
 * @returns {THREE.Vector3 | null}
 */
export function solveBounceV0(startPos, endPos, T, k, hintV0) {
  if (T <= 1e-9 || k <= 1e-8) return null;

  const v0 = hintV0.clone();
  v0.z = 0;

  for (let iter = 0; iter < 14; iter++) {
    const p = integrateToEndPos(startPos, v0, T, k);
    const ex = endPos.x - p.x;
    const ey = endPos.y - p.y;
    if (ex * ex + ey * ey < 1e-10) break;

    const eps = 1e-3;
    const vxp = v0.clone().add(new THREE.Vector3(eps, 0, 0));
    const vyp = v0.clone().add(new THREE.Vector3(0, eps, 0));
    const px = integrateToEndPos(startPos, vxp, T, k);
    const py = integrateToEndPos(startPos, vyp, T, k);

    const j11 = (px.x - p.x) / eps;
    const j12 = (py.x - p.x) / eps;
    const j21 = (px.y - p.y) / eps;
    const j22 = (py.y - p.y) / eps;
    const det = j11 * j22 - j12 * j21;
    if (Math.abs(det) < 1e-14) break;

    v0.x += (j22 * ex - j12 * ey) / det;
    v0.y += (-j21 * ex + j11 * ey) / det;
    v0.z = 0;
  }

  const pFinal = integrateToEndPos(startPos, v0, T, k);
  const err = (endPos.x - pFinal.x) ** 2 + (endPos.y - pFinal.y) ** 2;
  if (err > 0.05) return null;
  return v0;
}

/**
 * Sample bounce segment at local time s ∈ [0, tEnd - tStart].
 * @param {THREE.Vector3} startPos
 * @param {THREE.Vector3} v0
 * @param {number} s
 * @param {number} k
 */
export function sampleBounceRK4(startPos, v0, s, k) {
  return integrateBounceRK4(startPos, v0, s, k, bounceIntegrationSteps(s));
}
