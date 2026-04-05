/**
 * Circular arc in XY for sustained-note paths: a short bulge (sagitta) off the chord
 * so the ball rolls along a circular arc instead of a straight parabola.
 */

import * as THREE from 'three';

/**
 * @param {THREE.Vector3} start
 * @param {THREE.Vector3} end
 * @param {number} bulgeScale max sagitta as fraction of chord length (0 = straight)
 * @param {number} sideSign ±1 — which side of the chord the bulge faces
 * @returns {null | { center: THREE.Vector3, radius: number, theta0: number, theta1: number, arcLength: number, z: number }}
 */
export function computeSustainArc(start, end, bulgeScale, sideSign) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-4) return null;
  if (bulgeScale <= 1e-6) return null;

  let h = Math.min(L * bulgeScale, L * 0.45);
  h = Math.max(h, 1e-4);

  const R = (L * L * 0.25 + h * h) / (2 * h);
  const distCM = Math.sqrt(Math.max(R * R - L * L * 0.25, 0));

  const tx = dx / L;
  const ty = dy / L;
  const nx = -ty * sideSign;
  const ny = tx * sideSign;

  const mid = new THREE.Vector3(
    (start.x + end.x) * 0.5,
    (start.y + end.y) * 0.5,
    (start.z + end.z) * 0.5,
  );
  const z = (start.z + end.z) * 0.5;

  const C1 = new THREE.Vector3(mid.x - nx * distCM, mid.y - ny * distCM, z);
  const C2 = new THREE.Vector3(mid.x + nx * distCM, mid.y + ny * distCM, z);

  const n = new THREE.Vector3(nx, ny, 0);

  function anglesForCenter(C) {
    const t0 = Math.atan2(start.y - C.y, start.x - C.x);
    const t1raw = Math.atan2(end.y - C.y, end.x - C.x);
    let dTheta = t1raw - t0;
    while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    const t1 = t0 + dTheta;
    return { theta0: t0, theta1: t1 };
  }

  function midBulgeDot(C, theta0, theta1) {
    const thetaMid = theta0 + 0.5 * (theta1 - theta0);
    const mx = C.x + R * Math.cos(thetaMid);
    const my = C.y + R * Math.sin(thetaMid);
    return (mx - mid.x) * n.x + (my - mid.y) * n.y;
  }

  const a1 = anglesForCenter(C1);
  const a2 = anglesForCenter(C2);
  const dot1 = midBulgeDot(C1, a1.theta0, a1.theta1);
  const dot2 = midBulgeDot(C2, a2.theta0, a2.theta1);

  let center;
  let theta0;
  let theta1;
  if (dot1 >= dot2) {
    center = C1;
    theta0 = a1.theta0;
    theta1 = a1.theta1;
  } else {
    center = C2;
    theta0 = a2.theta0;
    theta1 = a2.theta1;
  }

  const arcLength = R * Math.abs(theta1 - theta0);
  return { center, radius: R, theta0, theta1, arcLength, z };
}

/**
 * True if `sa` has everything needed for arc math and mesh (center, radius, angles, z).
 * @param {unknown} sa
 */
export function isValidSustainArcData(sa) {
  if (sa == null || typeof sa !== 'object') return false;
  const c = /** @type {{ center?: unknown }} */ (sa).center;
  if (c == null || typeof c !== 'object') return false;
  const cx = /** @type {{ x?: unknown }} */ (c).x;
  const cy = /** @type {{ y?: unknown }} */ (c).y;
  const cz = /** @type {{ z?: unknown }} */ (c).z;
  if (typeof cx !== 'number' || !Number.isFinite(cx)) return false;
  if (typeof cy !== 'number' || !Number.isFinite(cy)) return false;
  if (typeof cz !== 'number' || !Number.isFinite(cz)) return false;
  const r = /** @type {{ radius?: unknown }} */ (sa).radius;
  const t0 = /** @type {{ theta0?: unknown }} */ (sa).theta0;
  const t1 = /** @type {{ theta1?: unknown }} */ (sa).theta1;
  const z = /** @type {{ z?: unknown }} */ (sa).z;
  if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0) return false;
  if (typeof t0 !== 'number' || !Number.isFinite(t0)) return false;
  if (typeof t1 !== 'number' || !Number.isFinite(t1)) return false;
  if (typeof z !== 'number' || !Number.isFinite(z)) return false;
  return true;
}

/**
 * XY circular arc for TubeGeometry along sustained rails.
 */
export class SustainArcCurve3 extends THREE.Curve {
  /**
   * @param {THREE.Vector3} center
   * @param {number} radius
   * @param {number} theta0
   * @param {number} theta1
   * @param {number} z
   */
  constructor(center, radius, theta0, theta1, z) {
    super();
    this.center = center;
    this.radius = radius;
    this.theta0 = theta0;
    this.theta1 = theta1;
    this.z = z;
  }

  getPoint(t, optionalTarget) {
    const theta = this.theta0 + t * (this.theta1 - this.theta0);
    const p = optionalTarget || new THREE.Vector3();
    return p.set(
      this.center.x + this.radius * Math.cos(theta),
      this.center.y + this.radius * Math.sin(theta),
      this.z,
    );
  }
}
