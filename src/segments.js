/**
 * SEGMENTED TRAJECTORY SYSTEM
 * BOUNCE / ROLL / SUSTAINED — spacing scales with MIDI gap: distance ≈ targetSpeed × gap.
 * Bounces clamp via spatialGap(); ROLL uses spatialGapForRoll() (see `rollSpatialGapUncapped`).
 */

import * as THREE from 'three';
import { params } from './params.js';
import { integrateBounceRK4, sampleBounceRK4, solveBounceV0 } from './segmentPhysics.js';
import { computeSustainArc, isValidSustainArcData } from './sustainArc.js';

function spawnPosClone() {
  const t = params.trajectory;
  return new THREE.Vector3(t.spawnX, t.spawnY, t.ballZ);
}

function getAccelBounce() {
  return new THREE.Vector3(0, -params.trajectory.gravity, 0);
}

const _accelRoll = new THREE.Vector3(0, 0, 0);

/**
 * Effective “alternate lateral” rule at a note onset time (transport seconds).
 * @param {number} t - note onset / landing time used for lateral flip
 */
export function bounceAlternateSidesAt(t) {
  const tr = params.trajectory;
  const ranges = tr.bounceAlternateSideRanges;
  if (Array.isArray(ranges) && ranges.length) {
    for (const r of ranges) {
      const a = r.tStart ?? 0;
      const b = r.tEnd ?? Infinity;
      if (t >= a && t < b) return !!r.bounceAlternateSides;
    }
  }
  return !!tr.bounceAlternateSides;
}

/** Serpentine path uses −sideSign each gap when alternate is on at this note’s time. */
function nextLateralSign(sideSign, timeAtNoteOnset) {
  return bounceAlternateSidesAt(timeAtNoteOnset) ? -sideSign : sideSign;
}

/** @param {number} gapSeconds */
export function spatialGap(gapSeconds) {
  if (gapSeconds <= 0) return 0;
  return Math.min(gapSeconds, params.trajectory.maxSpatialGap);
}

/**
 * Horizontal distance for ROLL segments scales with this (× targetSpeed).
 * When `rollSpatialGapUncapped` is true, uses the full gap in seconds so motion stays ~targetSpeed;
 * when false, matches `spatialGap` (compact path).
 * @param {number} gapSeconds
 */
export function spatialGapForRoll(gapSeconds) {
  if (gapSeconds <= 0) return 0;
  if (params.trajectory.rollSpatialGapUncapped) return gapSeconds;
  return Math.min(gapSeconds, params.trajectory.maxSpatialGap);
}

function shouldUseRollSpiral(gapSeconds, isRoll) {
  const tr = params.trajectory;
  return isRoll && tr.rollSpiralEnabled && gapSeconds >= tr.rollSpiralMinGapSec;
}

/** Net “seconds” along chord for spiral roll lateral extent. */
function spiralNetGapSeconds(gapSeconds) {
  const tr = params.trajectory;
  const cap = tr.rollSpiralNetCapSeconds;
  if (typeof cap === 'number' && cap > 0) {
    return Math.min(gapSeconds, cap);
  }
  return Math.min(gapSeconds, tr.maxSpatialGap);
}

const WORLD_DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Cylinder cross-section basis: chord tangent t; eDown = world-down projected ⊥ t; eSide = t × eDown.
 * @param {THREE.Vector3} start
 * @param {THREE.Vector3} end
 */
function spiralCylinderBasis(start, end) {
  const chord = new THREE.Vector3().subVectors(end, start);
  const len = chord.length();
  if (len < 1e-8) {
    return {
      t:      new THREE.Vector3(1, 0, 0),
      eSide:  new THREE.Vector3(0, 0, 1),
      eDown:  new THREE.Vector3(0, -1, 0),
    };
  }
  const t = chord.multiplyScalar(1 / len);
  let eDown = WORLD_DOWN.clone().sub(t.clone().multiplyScalar(WORLD_DOWN.dot(t)));
  if (eDown.lengthSq() < 1e-12) {
    eDown = new THREE.Vector3(0, 0, 1).sub(t.clone().multiplyScalar(t.z));
    if (eDown.lengthSq() < 1e-12) {
      eDown.set(1, 0, 0).sub(t.clone().multiplyScalar(t.x));
    }
  }
  eDown.normalize();
  const eSide = new THREE.Vector3().crossVectors(t, eDown).normalize();
  return { t, eSide, eDown };
}

/**
 * Cylindrical helix along the chord + sin²(πu) envelope, extra world-down drop, Z clamped in front of the wall.
 * @param {number} u ∈ [0,1]
 */
function rollSpiralPosition(start, end, u, turns, radius, downDepth, zMin) {
  const { eSide, eDown } = spiralCylinderBasis(start.clone(), end.clone());
  const base = start.clone().lerp(end, u);
  const env = Math.sin(Math.PI * u);
  const env2 = env * env;
  const theta = 2 * Math.PI * turns * u;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const r = radius * env2;
  const cyl = eSide.clone().multiplyScalar(r * c).addScaledVector(eDown, r * s);
  const down = WORLD_DOWN.clone().multiplyScalar(downDepth * env2);
  const pos = base.add(cyl).add(down);
  if (pos.z < zMin) pos.z = zMin;
  return pos;
}

/** dP/du (analytic; matches unclamped motion; Z clamp applied only to position). */
function rollSpiralDerivativeDu(start, end, u, turns, radius, downDepth) {
  const { eSide, eDown } = spiralCylinderBasis(start.clone(), end.clone());
  const dBase = new THREE.Vector3().subVectors(end, start);

  const env = Math.sin(Math.PI * u);
  const env2 = env * env;
  const denv2 = Math.PI * Math.sin(2 * Math.PI * u);

  const theta = 2 * Math.PI * turns * u;
  const dtheta = 2 * Math.PI * turns;
  const c = Math.cos(theta);
  const s = Math.sin(theta);

  const r = radius * env2;
  const drdu = radius * denv2;
  const radial = eSide.clone().multiplyScalar(c).addScaledVector(eDown, s);
  const dradialDu = eSide.clone().multiplyScalar(-s * dtheta).addScaledVector(eDown, c * dtheta);

  const dcyl = radial.clone().multiplyScalar(drdu).addScaledVector(dradialDu, r);
  const ddown = WORLD_DOWN.clone().multiplyScalar(downDepth * denv2);

  return dBase.add(dcyl).add(ddown);
}

/**
 * Vertical descent for a bounce of duration `gap` — short gaps → small arch.
 * @param {number} gap
 */
export function bounceVerticalDrop(gap) {
  const tr = params.trajectory;
  const g = spatialGap(gap);
  return Math.max(tr.minSpatialY, Math.min(tr.yDropMax, tr.targetSpeed * g * tr.dropScale));
}

/**
 * Classify inter-note gap by musical length (beats). Uses MIDI tempo via secondsPerBeat.
 * @param {number} deltaT seconds
 * @param {number} secondsPerBeat
 * @returns {'SMALL'|'MEDIUM'|'LARGE'}
 */
export function classifyGapKind(deltaT, secondsPerBeat) {
  const beats = deltaT / secondsPerBeat;
  const { smallBeatMax, mediumBeatMax } = params.gap;
  if (beats <= smallBeatMax) return 'SMALL';
  if (beats <= mediumBeatMax) return 'MEDIUM';
  return 'LARGE';
}

/**
 * @param {object} seg
 * @returns {THREE.Vector3}
 */
export function velAtSegmentEnd(seg) {
  const dt = seg.tEnd - seg.tStart;
  if (seg.type === 'BOUNCE' && seg.linearDrag > 0) {
    return integrateBounceRK4(
      seg.startPos,
      seg.v0,
      dt,
      seg.linearDrag,
      Math.min(2000, Math.max(16, Math.ceil(dt * 800))),
    ).vel;
  }
  if (seg.type === 'SUSTAINED' && seg.sustainArc) {
    const span = seg.tEnd - seg.tStart;
    const { radius, theta0, theta1 } = seg.sustainArc;
    const theta = theta1;
    const omega = (theta1 - theta0) / Math.max(span, 1e-9);
    return new THREE.Vector3(
      -omega * radius * Math.sin(theta),
      omega * radius * Math.cos(theta),
      0,
    );
  }
  if (seg.type === 'ROLL_SPIRAL') {
    const span = Math.max(seg.tEnd - seg.tStart, 1e-9);
    const dP_du = rollSpiralDerivativeDu(
      seg.startPos,
      seg.endPos,
      1,
      seg.spiralTurns,
      seg.spiralRadius,
    );
    return dP_du.multiplyScalar(1 / span);
  }
  return seg.v0.clone().addScaledVector(seg.accel, dt);
}

/**
 * Greedy landing plan (reference — matches dynamic spacing rules).
 */
export function computeLandings(eventTimes, bounceThreshold) {
  const landingPositions = [];
  const landingTypes = [];

  if (!eventTimes.length) {
    return { landingPositions, landingTypes };
  }

  let cursor   = spawnPosClone();
  let prevT    = 0;
  let sideSign = -1;

  for (let i = 0; i < eventTimes.length; i++) {
    const tEnd   = eventTimes[i];
    const gap    = tEnd - prevT;
    const isRoll = gap >= bounceThreshold;

    const sgRoll = spatialGapForRoll(gap);
    const sgBounce = spatialGap(gap);
    let endPos;
    if (isRoll) {
      sideSign = nextLateralSign(sideSign, tEnd);
      const sgNet = shouldUseRollSpiral(gap, true) ? spiralNetGapSeconds(gap) : sgRoll;
      endPos = new THREE.Vector3(
        cursor.x + sideSign * params.trajectory.targetSpeed * sgNet,
        cursor.y,
        params.trajectory.ballZ
      );
    } else {
      sideSign = nextLateralSign(sideSign, tEnd);
      const dx = sideSign * Math.max(params.trajectory.minSpatialX, params.trajectory.targetSpeed * sgBounce);
      const dy = -bounceVerticalDrop(gap);
      endPos = new THREE.Vector3(cursor.x + dx, cursor.y + dy, params.trajectory.ballZ);
    }

    landingPositions.push(endPos.clone());
    landingTypes.push(isRoll ? 'ROLL' : 'BOUNCE');
    cursor = endPos.clone();
    prevT  = tEnd;
  }

  return { landingPositions, landingTypes };
}

/**
 * `computeLandings` assumes each gap is the full time between onsets. After a sustained note,
 * the real kinematic gap to the next onset is `(tNext − tRailEnd)`, not `(tNext − t_i)`, so
 * the next event can be wrongly marked ROLL → no platform. Re-derive from built segments:
 * each note onset is the end of the non-SUSTAINED segment with matching `eventIndex`.
 */
function syncLandingsFromSegments(segments, eventTimes) {
  const landingPositions = [];
  const landingTypes = [];
  const eps = 1e-3;

  for (let j = 0; j < eventTimes.length; j++) {
    const tj = eventTimes[j];
    const arrivals = segments.filter(
      s => s.eventIndex === j && s.type !== 'SUSTAINED' && s.type !== 'SUSTAIN_ENTRY',
    );

    let hit = arrivals.find(s => Math.abs(s.tEnd - tj) < eps);
    if (!hit && arrivals.length) {
      hit = arrivals.reduce((best, s) =>
        Math.abs(s.tEnd - tj) < Math.abs(best.tEnd - tj) ? s : best,
      );
    }

    if (!hit) {
      landingPositions.push(spawnPosClone());
      landingTypes.push('BOUNCE');
      continue;
    }

    landingPositions.push(hit.endPos.clone());
    landingTypes.push(hit.type === 'ROLL' || hit.type === 'ROLL_SPIRAL' ? 'ROLL' : 'BOUNCE');
  }

  return { landingPositions, landingTypes };
}

function makeKinematicSegment(cursor, endPos, tStart, tEnd, isRoll, eventIndex) {
  const gap   = tEnd - tStart;
  const accel = isRoll ? _accelRoll : getAccelBounce();
  const disp  = endPos.clone().sub(cursor);
  const v0    = disp.clone()
    .divideScalar(gap)
    .sub(accel.clone().multiplyScalar(gap * 0.5));

  const seg = {
    type:       isRoll ? 'ROLL' : 'BOUNCE',
    tStart,
    tEnd,
    startPos:   cursor.clone(),
    endPos:     endPos.clone(),
    v0:         v0.clone(),
    accel:      accel.clone(),
    eventIndex,
    linearDrag: 0,
  };

  if (!isRoll && params.trajectory.linearDrag > 1e-6) {
    const k = params.trajectory.linearDrag;
    const solved = solveBounceV0(seg.startPos, seg.endPos, gap, k, seg.v0);
    if (solved) {
      seg.v0 = solved;
      seg.linearDrag = k;
    }
  }

  return seg;
}

/** Bounce after roll: inherit v_x from roll; vertical v0 for gap-scaled drop */
function makeBounceAfterRoll(cursor, tStart, tEnd, eventIndex, vRollEnd) {
  const T    = tEnd - tStart;
  const drop = bounceVerticalDrop(T);
  const endY = cursor.y - drop;
  const v0x  = vRollEnd.x;
  const v0y  = ((endY - cursor.y) + 0.5 * params.trajectory.gravity * T * T) / T;
  const endX = cursor.x + v0x * T;
  const endPos = new THREE.Vector3(endX, endY, params.trajectory.ballZ);
  const v0 = new THREE.Vector3(v0x, v0y, 0);

  const seg = {
    type:       'BOUNCE',
    tStart,
    tEnd,
    startPos:   cursor.clone(),
    endPos,
    v0,
    accel:      getAccelBounce().clone(),
    eventIndex,
    linearDrag: 0,
  };

  if (params.trajectory.linearDrag > 1e-6) {
    const k = params.trajectory.linearDrag;
    const solved = solveBounceV0(seg.startPos, seg.endPos, T, k, seg.v0);
    if (solved) {
      seg.v0 = solved;
      seg.linearDrag = k;
    }
  }

  return seg;
}

/**
 * @param {number[]} eventTimes
 * @param {{
 *   bounceThreshold?: number,
 *   notes?: { duration: number, midi: number }[],
 *   secondsPerBeat?: number,
 * }} [options]
 */
export function buildSegments(eventTimes, options = {}) {
  const bounceThreshold = options.bounceThreshold ?? params.trajectory.bounceThreshold;
  const notes           = options.notes;
  const secondsPerBeat  = options.secondsPerBeat ?? 60 / 120;

  const segments         = [];
  const landingPositions = [];
  const landingTypes     = [];

  if (!eventTimes.length) {
    return { segments, landingPositions, landingTypes, eventUsesSustainedRail: [] };
  }

  const { landingPositions: lands, landingTypes: ltypes } = computeLandings(
    eventTimes,
    bounceThreshold,
  );
  landingPositions.push(...lands.map(p => p.clone()));
  landingTypes.push(...ltypes);

  // true for notes that own a SUSTAINED tube — those events skip platform creation because
  // the ball descends through the pad body during SUSTAIN_ENTRY (the pad is below the ball).
  const eventUsesSustainedRail = eventTimes.map(() => false);

  if (!notes || notes.length !== eventTimes.length) {
    let cursor   = spawnPosClone();
    let prevT    = 0;
    let sideSign = -1;

    for (let i = 0; i < eventTimes.length; i++) {
      const tStart = prevT;
      const tEnd   = eventTimes[i];
      const gap    = tEnd - tStart;
      const isRoll = gap >= bounceThreshold;
      const sgRoll = spatialGapForRoll(gap);
      const sgBounce = spatialGap(gap);

      let endPos;
      if (isRoll) {
        sideSign = nextLateralSign(sideSign, tEnd);
        const tr = params.trajectory;
        if (shouldUseRollSpiral(gap, true)) {
          const sgNet = spiralNetGapSeconds(gap);
          endPos = new THREE.Vector3(
            cursor.x + sideSign * tr.targetSpeed * sgNet,
            cursor.y,
            tr.ballZ,
          );
          segments.push({
            type:          'ROLL_SPIRAL',
            tStart:        tStart,
            tEnd:          tEnd,
            startPos:      cursor.clone(),
            endPos:        endPos.clone(),
            spiralTurns:   tr.rollSpiralTurns,
            spiralRadius:  tr.rollSpiralRadius,
            eventIndex:    i,
          });
        } else {
          endPos = new THREE.Vector3(
            cursor.x + sideSign * tr.targetSpeed * sgRoll,
            cursor.y,
            tr.ballZ,
          );
          segments.push(makeKinematicSegment(cursor, endPos, tStart, tEnd, true, i));
        }
      } else {
        sideSign = nextLateralSign(sideSign, tEnd);
        const dx = sideSign * Math.max(params.trajectory.minSpatialX, params.trajectory.targetSpeed * sgBounce);
        const dy = -bounceVerticalDrop(gap);
        endPos = new THREE.Vector3(cursor.x + dx, cursor.y + dy, params.trajectory.ballZ);
        segments.push(makeKinematicSegment(cursor, endPos, tStart, tEnd, false, i));
      }

      cursor = endPos.clone();
      prevT  = tEnd;
    }

    return { segments, landingPositions, landingTypes, eventUsesSustainedRail };
  }

  // —— MIDI path ——
  let prevT    = 0;
  let cursor   = spawnPosClone();
  let sideSign = -1;
  let i        = 0;
  const n      = eventTimes.length;

  while (i < n) {
    const t_i = eventTimes[i];
    const gap = t_i - prevT;

    if (gap > 1e-6) {
      const isRoll = gap >= bounceThreshold;
      const sgRoll = spatialGapForRoll(gap);
      const sgBounce = spatialGap(gap);
      const gapKind = classifyGapKind(gap, secondsPerBeat);
      const beats   = gap / secondsPerBeat;
      /** @param {boolean} split @param {number|null} tt @param {number|null} tf */
      const meta = (split, tt, tf) => ({
        gapKind,
        beats,
        deltaT: gap,
        tTrans: tt,
        tFall:  tf,
        splitApplied: split,
      });
      let endPos;

      if (isRoll) {
        sideSign = nextLateralSign(sideSign, t_i);
        const tr = params.trajectory;
        if (shouldUseRollSpiral(gap, true)) {
          const sgNet = spiralNetGapSeconds(gap);
          endPos = new THREE.Vector3(
            cursor.x + sideSign * tr.targetSpeed * sgNet,
            cursor.y,
            tr.ballZ,
          );
          const seg = {
            type:          'ROLL_SPIRAL',
            tStart:        prevT,
            tEnd:          t_i,
            startPos:      cursor.clone(),
            endPos:        endPos.clone(),
            spiralTurns:   tr.rollSpiralTurns,
            spiralRadius:  tr.rollSpiralRadius,
            eventIndex:    i,
          };
          Object.assign(seg, meta(false, null, null));
          segments.push(seg);
        } else {
          endPos = new THREE.Vector3(
            cursor.x + sideSign * tr.targetSpeed * sgRoll,
            cursor.y,
            tr.ballZ,
          );
          const seg = makeKinematicSegment(cursor, endPos, prevT, t_i, true, i);
          Object.assign(seg, meta(false, null, null));
          segments.push(seg);
        }
      } else {
        const prevSeg = segments[segments.length - 1];
        if (prevSeg && (prevSeg.type === 'ROLL' || prevSeg.type === 'ROLL_SPIRAL')) {
          const vRoll = velAtSegmentEnd(prevSeg);
          segments.push(makeBounceAfterRoll(cursor, prevT, t_i, i, vRoll));
          const seg = segments[segments.length - 1];
          Object.assign(seg, meta(false, null, null));
          endPos = seg.endPos.clone();
          sideSign = endPos.x >= 0 ? 1 : -1;
        } else {
          sideSign = nextLateralSign(sideSign, t_i);
          const dx = sideSign * Math.max(params.trajectory.minSpatialX, params.trajectory.targetSpeed * sgBounce);
          const dy = -bounceVerticalDrop(gap);
          endPos = new THREE.Vector3(cursor.x + dx, cursor.y + dy, params.trajectory.ballZ);

          const g = params.gap;
          const canSplit = g.enableSplit
            && (gapKind === 'MEDIUM' || gapKind === 'LARGE')
            && Math.abs(g.transTimeRatio + g.fallTimeRatio - 1) < 0.01;

          if (canSplit) {
            const tTrans = gap * g.transTimeRatio;
            const tFall  = gap * g.fallTimeRatio;
            const pMid   = cursor.clone().lerp(endPos, tTrans / gap);

            const segA = makeKinematicSegment(cursor, pMid, prevT, prevT + tTrans, true, i);
            Object.assign(segA, meta(true, tTrans, tFall), {
              transitionPhase: 'transition',
              isGapTransition: true,
            });
            segments.push(segA);

            const segB = makeKinematicSegment(pMid, endPos, prevT + tTrans, t_i, false, i);
            Object.assign(segB, meta(true, tTrans, tFall), {
              transitionPhase: 'fall',
              isGapTransition: false,
            });
            segments.push(segB);
          } else {
            const seg = makeKinematicSegment(cursor, endPos, prevT, t_i, false, i);
            Object.assign(seg, meta(false, null, null));
            segments.push(seg);
          }
        }
      }

      cursor.copy(endPos);
      prevT = t_i;
    }

    const dur = notes[i]?.duration ?? 0;
    if (dur > params.trajectory.sustainDurationMin) {
      const tRailEnd = i + 1 < n
        ? Math.min(t_i + dur, eventTimes[i + 1])
        : t_i + dur;

      if (tRailEnd > t_i + 1e-6) {
        const segBeforeRail = segments[segments.length - 1];

        const span = tRailEnd - t_i;
        const tr   = params.trajectory;
        let fallDist = tr.sustainFallSpeed * span;
        fallDist = Math.min(fallDist, tr.sustainMaxFall);
        fallDist = Math.max(fallDist, 0.25 * Math.min(span, 2.5));

        const platformPos = cursor.clone();
        const endRail = platformPos.clone();
        endRail.y -= fallDist;
        endRail.z = tr.ballZ;

        let sustainDrop = Math.min(tr.sustainPlatformDrop, fallDist * 0.92);
        sustainDrop = Math.max(sustainDrop, Math.min(0.08, fallDist * 0.35));
        const arcStart = platformPos.clone();
        arcStart.y -= sustainDrop;

        let tDrop = Math.min(tr.sustainEntryDuration, span * 0.28);
        tDrop = Math.min(tDrop, span - 0.02);
        if (tDrop >= span - 1e-3) tDrop = span * 0.42;
        tDrop = Math.max(tDrop, Math.min(0.035, span * 0.2));

        const tEntryEnd = t_i + tDrop;
        const arcSpan   = Math.max(tRailEnd - tEntryEnd, 1e-6);

        const dispEntry = arcStart.clone().sub(platformPos);
        const v0Entry   = dispEntry.clone().divideScalar(tDrop);

        segments.push({
          type:                'SUSTAIN_ENTRY',
          sustainVerticalFall: true,
          tStart:              t_i,
          tEnd:                tEntryEnd,
          startPos:            platformPos.clone(),
          endPos:              arcStart.clone(),
          v0:                  v0Entry.clone(),
          accel:               new THREE.Vector3(0, 0, 0),
          eventIndex:          i,
          midi:                notes[i].midi,
          linearDrag:          0,
        });

        const accel = getAccelBounce();
        const disp  = endRail.clone().sub(arcStart);
        const v0    = disp.clone()
          .divideScalar(arcSpan)
          .sub(accel.clone().multiplyScalar(arcSpan * 0.5));

        const sustainArc = computeSustainArc(arcStart, endRail, tr.sustainArcBulge, sideSign);
        let v0Seg = v0.clone();
        let accelSeg = accel.clone();
        if (sustainArc) {
          const { radius, theta0, theta1 } = sustainArc;
          const omega = (theta1 - theta0) / Math.max(arcSpan, 1e-9);
          v0Seg = new THREE.Vector3(
            -omega * radius * Math.sin(theta0),
            omega * radius * Math.cos(theta0),
            0,
          );
          accelSeg.set(0, 0, 0);
        }

        segments.push({
          type:                'SUSTAINED',
          sustainVerticalFall: true,
          sustainArc:          sustainArc ?? undefined,
          sustainPlatformPos:  platformPos.clone(),
          tStart:              tEntryEnd,
          tEnd:                tRailEnd,
          startPos:            arcStart.clone(),
          endPos:              endRail.clone(),
          v0:                  v0Seg,
          accel:               accelSeg,
          eventIndex:          i,
          midi:                notes[i].midi,
          linearDrag:          0,
        });

        // Suppress the platform for this event — the ball descends into the pad body.
        eventUsesSustainedRail[i] = true;

        cursor.copy(endRail);
        prevT = tRailEnd;

        if (i + 1 < n) {
          const tNext = eventTimes[i + 1];
          if (tRailEnd < tNext - 1e-6) {
            const gap2 = tNext - tRailEnd;
            const sg2Roll = spatialGapForRoll(gap2);
            const sg2Bounce = spatialGap(gap2);
            const isRoll2 = gap2 >= bounceThreshold;
            if (!isRoll2 && segBeforeRail && (segBeforeRail.type === 'ROLL' || segBeforeRail.type === 'ROLL_SPIRAL')) {
              const vRoll = velAtSegmentEnd(segBeforeRail);
              segments.push(makeBounceAfterRoll(cursor, tRailEnd, tNext, i + 1, vRoll));
              cursor.copy(segments[segments.length - 1].endPos);
              sideSign = cursor.x >= 0 ? 1 : -1;
            } else if (isRoll2) {
              sideSign = nextLateralSign(sideSign, tNext);
              if (shouldUseRollSpiral(gap2, true)) {
                const sgNet = spiralNetGapSeconds(gap2);
                const endNext = new THREE.Vector3(
                  cursor.x + sideSign * tr.targetSpeed * sgNet,
                  cursor.y,
                  tr.ballZ,
                );
                segments.push({
                  type:          'ROLL_SPIRAL',
                  tStart:        tRailEnd,
                  tEnd:          tNext,
                  startPos:      cursor.clone(),
                  endPos:        endNext.clone(),
                  spiralTurns:   tr.rollSpiralTurns,
                  spiralRadius:  tr.rollSpiralRadius,
                  eventIndex:    i + 1,
                });
                cursor.copy(endNext);
              } else {
                const endNext = new THREE.Vector3(
                  cursor.x + sideSign * params.trajectory.targetSpeed * sg2Roll,
                  cursor.y,
                  params.trajectory.ballZ,
                );
                segments.push(makeKinematicSegment(cursor, endNext, tRailEnd, tNext, true, i + 1));
                cursor.copy(endNext);
              }
            } else {
              sideSign = nextLateralSign(sideSign, tNext);
              const dx = sideSign * Math.max(params.trajectory.minSpatialX, params.trajectory.targetSpeed * sg2Bounce);
              const dy = -bounceVerticalDrop(gap2);
              const endNext = new THREE.Vector3(cursor.x + dx, cursor.y + dy, params.trajectory.ballZ);
              segments.push(makeKinematicSegment(cursor, endNext, tRailEnd, tNext, false, i + 1));
              cursor.copy(endNext);
            }
            prevT = tNext;
          } else {
            prevT = tNext;
          }
        }

        i += 1;
        continue;
      }
    }

    i += 1;
  }

  if (notes && notes.length === eventTimes.length) {
    const synced = syncLandingsFromSegments(segments, eventTimes);
    landingPositions.length = 0;
    landingTypes.length = 0;
    landingPositions.push(...synced.landingPositions);
    landingTypes.push(...synced.landingTypes);
  }

  return { segments, landingPositions, landingTypes, eventUsesSustainedRail };
}

function findSegIdx(segs, t) {
  if (!segs.length) return 0;
  if (t <= segs[0].tStart)          return 0;
  if (t >= segs[segs.length - 1].tEnd) return segs.length - 1;

  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].tEnd <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function getTrajectoryPoint(segs, t) {
  if (!segs.length) {
    return {
      pos:      spawnPosClone(),
      vel:      new THREE.Vector3(0, 0, 0),
      type:     'BOUNCE',
      segIndex: 0,
    };
  }
  const i   = findSegIdx(segs, t);
  const seg = segs[i];
  const s   = Math.max(0, Math.min(t - seg.tStart, seg.tEnd - seg.tStart));

  if (seg.type === 'BOUNCE' && seg.linearDrag > 0) {
    const { pos, vel } = sampleBounceRK4(seg.startPos, seg.v0, s, seg.linearDrag);
    return { pos, vel, type: seg.type, segIndex: i };
  }

  if (seg.type === 'ROLL_SPIRAL') {
    const tr = params.trajectory;
    const span = Math.max(seg.tEnd - seg.tStart, 1e-9);
    const u = s / span;
    const pos = rollSpiralPosition(
      seg.startPos,
      seg.endPos,
      u,
      seg.spiralTurns,
      seg.spiralRadius,
      tr.rollSpiralDownDepth,
      tr.rollSpiralMinZ,
    );
    const dP_du = rollSpiralDerivativeDu(
      seg.startPos,
      seg.endPos,
      u,
      seg.spiralTurns,
      seg.spiralRadius,
      tr.rollSpiralDownDepth,
    );
    const vel = dP_du.multiplyScalar(1 / span);
    return { pos, vel, type: 'ROLL', segIndex: i };
  }

  if (seg.type === 'SUSTAINED' && seg.sustainArc && isValidSustainArcData(seg.sustainArc)) {
    const span = seg.tEnd - seg.tStart;
    const u = span > 1e-9 ? s / span : 0;
    const { center, radius, theta0, theta1, z } = seg.sustainArc;
    const theta = theta0 + u * (theta1 - theta0);
    const pos = new THREE.Vector3(
      center.x + radius * Math.cos(theta),
      center.y + radius * Math.sin(theta),
      z,
    );
    const omega = (theta1 - theta0) / Math.max(span, 1e-9);
    const vel = new THREE.Vector3(
      -omega * radius * Math.sin(theta),
      omega * radius * Math.cos(theta),
      0,
    );
    return { pos, vel, type: seg.type, segIndex: i };
  }

  const pos = seg.startPos.clone()
    .addScaledVector(seg.v0,    s)
    .addScaledVector(seg.accel, 0.5 * s * s);

  const vel = seg.v0.clone()
    .addScaledVector(seg.accel, s);

  return { pos, vel, type: seg.type, segIndex: i };
}

/**
 * Dense polyline over the full timeline for export / visual comparison.
 * @param {object[]} segs
 * @param {number} [dt]
 * @returns {{ tEnd: number, sampleDt: number, points: { t: number, x: number, y: number, z: number }[] }}
 */
export function sampleTrajectoryPolyline(segs, dt = 0.025) {
  if (!segs.length) {
    return { tEnd: 0, sampleDt: dt, points: [] };
  }
  const tEnd = segs[segs.length - 1].tEnd;
  const points = [];
  for (let t = 0; t < tEnd; t += dt) {
    const { pos } = getTrajectoryPoint(segs, t);
    points.push({ t, x: pos.x, y: pos.y, z: pos.z });
  }
  const last = getTrajectoryPoint(segs, tEnd);
  points.push({ t: tEnd, x: last.pos.x, y: last.pos.y, z: last.pos.z });
  return { tEnd, sampleDt: dt, points };
}
