/**
 * Trajectory path export + numeric comparison against a saved reference polyline.
 */

/**
 * @param {{ t: number, x: number, y: number, z: number }[]} points sorted by t
 * @param {number} t
 */
function interpolatePointAtT(points, t) {
  if (!points.length) return null;
  if (t <= points[0].t) return { ...points[0] };
  const last = points[points.length - 1];
  if (t >= last.t) return { ...last };

  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const u = (t - a.t) / (b.t - a.t);
  return {
    t,
    x: a.x + u * (b.x - a.x),
    y: a.y + u * (b.y - a.y),
    z: a.z + u * (b.z - a.z),
  };
}

/**
 * Compare `current` to `reference` by sampling reference at each current point's t.
 *
 * @param {{ points: { t: number, x: number, y: number, z: number }[], tEnd?: number }} current
 * @param {{ points: { t: number, x: number, y: number, z: number }[], tEnd?: number }} reference
 * @returns {{ maxDist: number, rms: number, samples: number }}
 */
export function comparePathSamples(current, reference) {
  const cp = current?.points;
  const rp = reference?.points;
  if (!cp?.length || !rp?.length) {
    return { maxDist: NaN, rms: NaN, samples: 0 };
  }

  const tEndA = current.tEnd ?? cp[cp.length - 1].t;
  const tEndB = reference.tEnd ?? rp[rp.length - 1].t;
  const tMax = Math.min(tEndA, tEndB);

  let maxDist = 0;
  let sumSq = 0;
  let n = 0;

  for (const p of cp) {
    if (p.t > tMax + 1e-6) break;
    const q = interpolatePointAtT(rp, p.t);
    if (!q) continue;
    const dx = p.x - q.x;
    const dy = p.y - q.y;
    const dz = p.z - q.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    maxDist = Math.max(maxDist, d);
    sumSq += dx * dx + dy * dy + dz * dz;
    n += 1;
  }

  return {
    maxDist,
    rms: n ? Math.sqrt(sumSq / n) : 0,
    samples: n,
  };
}

/**
 * @param {{ tEnd: number, sampleDt: number, points: { t: number, x: number, y: number, z: number }[] }} sampled
 * @param {Record<string, unknown>} [meta]
 */
export function buildPathExportDocument(sampled, meta = {}) {
  return {
    version:  1,
    sampleDt: sampled.sampleDt,
    tEnd:     sampled.tEnd,
    points:   sampled.points,
    meta:     meta,
  };
}

/**
 * @param {unknown} data
 * @returns {{ tEnd: number, sampleDt: number, points: { t: number, x: number, y: number, z: number }[] } | null}
 */
export function parsePathReferenceDocument(data) {
  if (!data || typeof data !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (data);
  if (o.version !== 1) return null;
  const points = o.points;
  if (!Array.isArray(points) || !points.length) return null;
  const normalized = [];
  for (const p of points) {
    if (!p || typeof p !== 'object') continue;
    const q = /** @type {Record<string, unknown>} */ (p);
    const t = q.t;
    const x = q.x;
    const y = q.y;
    const z = q.z;
    if (typeof t !== 'number' || typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
      continue;
    }
    normalized.push({ t, x, y, z });
  }
  if (!normalized.length) return null;
  const sampleDt = typeof o.sampleDt === 'number' ? o.sampleDt : 0.025;
  const tEnd = typeof o.tEnd === 'number' ? o.tEnd : normalized[normalized.length - 1].t;
  return { tEnd, sampleDt, points: normalized };
}
