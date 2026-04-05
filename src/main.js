/**
 * Curve Beats — MIDI → segmented trajectory + Tone.Transport sync
 */

import * as THREE from 'three';
import {
  P,
  getSegmentState,
  eventTimes,
  landingTypes,
  landingPitches,
  eventUsesSustainedRail,
  setTrajectoryBundle,
  findFirstRollSegment,
  hasTrajectory,
  sampleTrajectoryPath,
  evalTrajectory,
} from './trajectory.js';
import { createEventTracker, pollEvents } from './events.js';
import {
  ensureSamplerLoaded,
  scheduleMidiNotes,
  startPlayback,
  pausePlayback,
  stopPlayback,
  getTransportSeconds,
  getTransportState,
  INSTRUMENT_DEFS,
  setTrackInstrument,
  getTrackInstrument,
  ensureInstrumentLoaded,
  resetTrackInstruments,
} from './audioSampler.js';
import { parseMidiBuffer, parseMidiJsonExport, MERGE_PITCHED_TRACKS } from './midi/midiParser.js';
import defaultMidiJson from './midis/midi.json';
import { generateTrajectoryFromNotes } from './midi/trajectoryGenerator.js';
import { pitchToBurstColor, pitchToPlatformColor } from './midi/pitchColor.js';
import {
  createScene, createRenderer, createCamera, createLights,
  createSelectiveBloomPipeline, resizeSelectiveBloomPipeline, renderSelectiveBloom,
  createWall, createWallBackground, createBall, createPlatformPool, createTrack,
  createSustainedRailsGroup,
  createTrail, createParticleSystem, triggerBurst, updateParticles,
  createPathOverlayLine, updatePathOverlayGeometry,
  clampBallPositionToWall,
} from './scene.js';
import { loadWallTexturesAsync } from './wallTextures.js';
import {
  activatePlatform, cullOldPlatforms, resetPlatformPool,
  animatePlatformHit, updatePlatformAnimations,
} from './platforms.js';
import { updateCamera, updateKeyLight, onResize, resetCameraFollow } from './camera.js';
import { params } from './params.js';
import { createDebugGui } from './debugGui.js';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const container = document.getElementById('canvas-container');
const statusEl = document.getElementById('status');
const fileInput = document.getElementById('midi-file');
const btnPlay = document.getElementById('btn-play');
const btnPause = document.getElementById('btn-pause');
const btnStop = document.getElementById('btn-stop');

const hudT = document.getElementById('hud-t');
const hudBeat = document.getElementById('hud-beat');
const hudPlat = document.getElementById('hud-plat');
const hudPathDiff = document.getElementById('hud-path-diff');
const pathRefFileInput = document.getElementById('path-ref-file');
const trackSelect = document.getElementById('midi-track-select');
const instrumentPanel = document.getElementById('instrument-panel');

/** Distinct tint colors assigned to secondary balls in order of creation. */
const BALL_TINT_COLORS = [
  0xff5fa0, // hot pink
  0x4dc8e8, // cyan
  0x4ddc5a, // lime green
  0xf5c200, // yellow
  0xff8c2a, // orange
  0xcc5de8, // purple
  0x20c997, // mint
  0xff6b6b, // coral
];

/** Last uploaded `.mid` bytes — used when switching tracks. */
let lastMidiBuffer = null;
/** Bundled or embedded JSON source — used when switching tracks (no buffer). */
let lastJsonData = defaultMidiJson;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

// ---------------------------------------------------------------------------
// Three.js bootstrap
// ---------------------------------------------------------------------------

const scene = createScene();
const renderer = createRenderer(container);
const camera = createCamera();
const bloomPipeline = createSelectiveBloomPipeline(renderer);
const { bloomPass } = bloomPipeline;

const { key: keyLight, ambient, fill } = createLights(scene);
const wall = createWall(scene);
createWallBackground(scene);
loadWallTexturesAsync(wall).catch(err => console.warn('Wall PBR textures:', err));

const ball = createBall(scene);
const platformPool = createPlatformPool(scene, 80);
const particles = createParticleSystem(scene);
const trail = createTrail(scene);

/** Expected path (loaded JSON) — green */
const pathRefOverlay = createPathOverlayLine(scene, 0x33dd88, params.pathCompare.referenceOpacity);
/** Current baked trajectory — blue-violet */
const bakedPathOverlay = createPathOverlayLine(scene, 0x6688ff, params.pathCompare.bakedOpacity);

/** @type {{ tEnd: number, sampleDt: number, points: { t: number, x: number, y: number, z: number }[] } | null} */
let referencePathRecord = null;

/** @type {import('three').Group | null} */
let trackGroup = null;
/** @type {import('three').Group | null} */
let sustainedRailGroup = null;

function placeTrackForTrajectory() {
  if (trackGroup) {
    scene.remove(trackGroup);
    trackGroup = null;
  }
  const firstRoll = findFirstRollSegment();
  if (firstRoll) {
    const trackX = (firstRoll.startPos.x + firstRoll.endPos.x) * 0.5;
    const trackY = firstRoll.startPos.y;
    trackGroup = createTrack(scene, trackX, trackY);
  }
}

function placeSustainedRails(segments) {
  if (sustainedRailGroup) {
    scene.remove(sustainedRailGroup);
    sustainedRailGroup = null;
  }
  sustainedRailGroup = createSustainedRailsGroup(segments);
  scene.add(sustainedRailGroup);
}

function syncPathOverlays() {
  const pc = params.pathCompare;

  if (!hasTrajectory()) {
    pathRefOverlay.line.visible = false;
    bakedPathOverlay.line.visible = false;
    if (hudPathDiff) hudPathDiff.textContent = '—';
    return;
  }

  const sampled = sampleTrajectoryPath(pc.sampleDt);

  if (pc.showBakedPath) {
    updatePathOverlayGeometry(bakedPathOverlay, sampled.points);
    bakedPathOverlay.line.visible = true;
    bakedPathOverlay.line.material.opacity = pc.bakedOpacity;
  } else {
    bakedPathOverlay.line.visible = false;
  }

  if (referencePathRecord?.points?.length) {
    if (pc.showReference) {
      updatePathOverlayGeometry(pathRefOverlay, referencePathRecord.points);
      pathRefOverlay.line.visible = true;
      pathRefOverlay.line.material.opacity = pc.referenceOpacity;
    } else {
      pathRefOverlay.line.visible = false;
    }

    const diff = comparePathSamples(sampled, referencePathRecord);
    if (hudPathDiff) {
      if (diff.samples > 0 && !Number.isNaN(diff.maxDist)) {
        hudPathDiff.textContent =
          `max ${diff.maxDist.toFixed(4)}  rms ${diff.rms.toFixed(4)}  (n=${diff.samples})`;
      } else {
        hudPathDiff.textContent = '—';
      }
    }
  } else {
    pathRefOverlay.line.visible = false;
    if (hudPathDiff) hudPathDiff.textContent = 'no reference';
  }
}

function exportTrajectoryPathJson() {
  if (!hasTrajectory()) return;
  const sampled = sampleTrajectoryPath(params.pathCompare.sampleDt);
  const doc = buildPathExportDocument(sampled, {
    noteCount: lastMidiNotes?.length ?? 0,
    secondsPerBeat: lastSecondsPerBeat,
  });
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'trajectory-path.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function clearReferencePath() {
  referencePathRecord = null;
  pathRefOverlay.line.visible = false;
  syncPathOverlays();
}

// ---------------------------------------------------------------------------
// MIDI → world
// ---------------------------------------------------------------------------

let firedEvents = createEventTracker();
const activatedPlatforms = new Set();

/** Trail state for the primary ball. */
const primaryTrailState = { lastT: -999, history: /** @type {import('three').Vector3[]} */ ([]) };

/** Squash state for the primary ball. */
const primarySquash = { active: false, startTime: 0 };

/**
 * @param {{ active: boolean, startTime: number }} squashState
 * @param {number} now
 */
function triggerSquash(squashState, now) {
  squashState.active = true;
  squashState.startTime = now;
}

/**
 * @param {import('three').Mesh} mesh
 * @param {{ active: boolean, startTime: number }} squashState
 * @param {number} now
 */
function updateBallSquash(mesh, squashState, now) {
  if (!squashState.active) return;
  const age = now - squashState.startTime;
  if (age > params.main.squashDuration) {
    mesh.scale.set(1, 1, 1);
    squashState.active = false;
    return;
  }
  const p = age / params.main.squashDuration;
  const env = Math.sin(Math.PI * p) * Math.exp(-4 * p);
  mesh.scale.set(1 + 0.42 * env, 1 - 0.48 * env, 1 + 0.42 * env);
}

let rollAngle = 0;

// ── Secondary balls ──────────────────────────────────────────────────────────

/**
 * Notes grouped by trackIndex — populated each time a MIDI is parsed.
 * Used to build per-track trajectory bundles for secondary balls.
 * @type {Map<number, import('./midi/midiParser.js').MidiNoteEvent[]>}
 */
let lastParsedNotesByTrack = new Map();

/**
 * @typedef {{
 *   trackIndex: number,
 *   bundle: object,
 *   ball: import('three').Mesh,
 *   platformPool: import('three').Group[],
 *   activatedPlatforms: Set<number>,
 *   trail: { line: import('three').Line, positions: Float32Array, colors: Float32Array, tint: import('three').Color },
 *   trailState: { lastT: number, history: import('three').Vector3[] },
 *   rollAngle: number,
 *   squash: { active: boolean, startTime: number },
 *   firedEvents: Set<number>,
 * }} SecondaryBall
 */

/** @type {SecondaryBall[]} */
const secondaryBalls = [];

/** @param {number} trackIndex */
function addSecondaryBall(trackIndex) {
  if (secondaryBalls.some(b => b.trackIndex === trackIndex)) return;
  const notes = lastParsedNotesByTrack.get(trackIndex);
  if (!notes?.length) return;
  const bundle = generateTrajectoryFromNotes(notes, { secondsPerBeat: lastSecondsPerBeat });
  const colorIdx = secondaryBalls.length % BALL_TINT_COLORS.length;
  const tintColor = BALL_TINT_COLORS[colorIdx];
  const sbBall = createBall(scene, tintColor);
  const sbPool = createPlatformPool(scene, 40);
  const sbTrail = createTrail(scene, tintColor);
  secondaryBalls.push({
    trackIndex,
    bundle,
    ball: sbBall,
    platformPool: sbPool,
    activatedPlatforms: new Set(),
    trail: sbTrail,
    trailState: { lastT: -999, history: [] },
    rollAngle: 0,
    squash: { active: false, startTime: 0 },
    firedEvents: createEventTracker(),
  });
}

/** @param {SecondaryBall} entry */
function disposeSecondaryBall(entry) {
  scene.remove(entry.ball);
  scene.remove(entry.trail.line);
  for (const group of entry.platformPool) scene.remove(group);
}

/** @param {number} trackIndex */
function removeSecondaryBall(trackIndex) {
  const idx = secondaryBalls.findIndex(b => b.trackIndex === trackIndex);
  if (idx === -1) return;
  disposeSecondaryBall(secondaryBalls[idx]);
  secondaryBalls.splice(idx, 1);
}

function clearSecondaryBalls() {
  for (const entry of secondaryBalls) disposeSecondaryBall(entry);
  secondaryBalls.length = 0;
}

/** Last parsed note list — used by debug GUI to regenerate trajectory. */
let lastMidiNotes = null;
/** From last successful MIDI parse — keeps tempo when regenerating after GUI edits. */
let lastSecondsPerBeat = 60 / 120;

function regenerateTrajectoryFromMidi() {
  if (!lastMidiNotes?.length) return;
  const bundle = generateTrajectoryFromNotes(lastMidiNotes, {
    secondsPerBeat: lastSecondsPerBeat,
  });
  setTrajectoryBundle(bundle);
  scheduleMidiNotes(bundle.notes);
  firedEvents = createEventTracker();
  activatedPlatforms.clear();
  resetPlatformPool(platformPool);
  resetCameraFollow();
  placeTrackForTrajectory();
  placeSustainedRails(bundle.segments);
  syncPathOverlays();
}

/**
 * @param {{ notes: { time: number, duration: number, midi: number, name: string }[], duration: number, trackName: string, secondsPerBeat: number, tracks: import('./midi/midiParser.js').MidiTrackSummary[], trackIndex: number | typeof MERGE_PITCHED_TRACKS, pitchedTracksMerged?: number }} parsed
 */
function populateTrackSelect(parsed) {
  if (!trackSelect) return;
  const { tracks, trackIndex } = parsed;
  trackSelect.innerHTML = '';
  const mergeOpt = document.createElement('option');
  mergeOpt.value = MERGE_PITCHED_TRACKS;
  mergeOpt.textContent = 'All pitched tracks (merged)';
  trackSelect.appendChild(mergeOpt);
  for (const t of tracks) {
    const opt = document.createElement('option');
    opt.value = String(t.index);
    opt.textContent = `${t.index}: ${t.name} (${t.noteCount} notes)`;
    trackSelect.appendChild(opt);
  }
  trackSelect.value = trackIndex === MERGE_PITCHED_TRACKS ? MERGE_PITCHED_TRACKS : String(trackIndex);
  trackSelect.disabled = tracks.length <= 1;
}

/**
 * Build per-track instrument dropdowns.
 * Shows one row per track that has notes (all tracks in merged mode, just the
 * selected track in single-track mode).
 * @param {{ tracks: import('./midi/midiParser.js').MidiTrackSummary[], trackIndex: number | typeof MERGE_PITCHED_TRACKS }} parsed
 */
/**
 * @param {{ tracks: import('./midi/midiParser.js').MidiTrackSummary[], trackIndex: number | typeof MERGE_PITCHED_TRACKS }} parsed
 */
function populateInstrumentPanel(parsed) {
  if (!instrumentPanel) return;
  instrumentPanel.innerHTML = '';

  const { tracks, trackIndex } = parsed;
  const isMerged = trackIndex === MERGE_PITCHED_TRACKS;
  const tracksToShow = isMerged
    ? tracks.filter(t => t.noteCount > 0)
    : tracks.filter(t => t.index === trackIndex);

  if (!tracksToShow.length) {
    instrumentPanel.classList.remove('visible');
    return;
  }

  const optionsHtml = INSTRUMENT_DEFS
    .map(def => `<option value="${def.id}">${def.label}</option>`)
    .join('');

  for (const t of tracksToShow) {
    const row = document.createElement('div');
    row.className = 'inst-row';

    // ── Show Ball checkbox (only meaningful in merged mode) ───────────────
    if (isMerged) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.title = `Show a separate ball for ${t.name}`;
      cb.style.cssText = 'width:14px;height:14px;cursor:pointer;accent-color:#88aeff;flex-shrink:0';
      const isActive = secondaryBalls.some(b => b.trackIndex === t.index);
      cb.checked = isActive;
      cb.addEventListener('change', () => {
        if (cb.checked) addSecondaryBall(t.index);
        else removeSecondaryBall(t.index);
      });
      row.appendChild(cb);
    }

    const label = document.createElement('span');
    label.className = 'inst-track-label';
    label.textContent = tracksToShow.length === 1 ? 'Instrument' : `T${t.index}: ${t.name}`;
    label.title = `${t.name} (${t.noteCount} notes)`;

    const sel = document.createElement('select');
    sel.className = 'inst-select';
    sel.setAttribute('aria-label', `Instrument for ${t.name}`);
    sel.innerHTML = optionsHtml;
    sel.value = getTrackInstrument(t.index);

    sel.addEventListener('change', () => {
      const instrumentId = sel.value;
      setTrackInstrument(t.index, instrumentId);
      ensureInstrumentLoaded(instrumentId).catch(err =>
        console.warn('Instrument load failed:', instrumentId, err),
      );
    });

    row.appendChild(label);
    row.appendChild(sel);
    instrumentPanel.appendChild(row);
  }

  instrumentPanel.classList.add('visible');
}

/**
 * @param {{ notes: { time: number, duration: number, midi: number, name: string }[], duration: number, trackName: string, secondsPerBeat: number, tracks: { index: number, name: string, noteCount: number }[], trackIndex: number | typeof MERGE_PITCHED_TRACKS, pitchedTracksMerged?: number }} parsed
 */
async function applyParsedMidi(parsed) {
  populateTrackSelect(parsed);
  populateInstrumentPanel(parsed);

  const { notes, duration, trackName, secondsPerBeat, trackIndex, pitchedTracksMerged } = parsed;
  lastSecondsPerBeat = secondsPerBeat;

  // Build per-track note lookup for secondary ball trajectory generation
  lastParsedNotesByTrack = new Map();
  for (const note of notes) {
    const ti = note.trackIndex ?? 0;
    if (!lastParsedNotesByTrack.has(ti)) lastParsedNotesByTrack.set(ti, []);
    /** @type {import('./midi/midiParser.js').MidiNoteEvent[]} */ (lastParsedNotesByTrack.get(ti)).push(note);
  }

  // Remove any secondary balls from the previous MIDI (track layout may differ)
  clearSecondaryBalls();

  if (!notes.length) {
    setStatus(
      'No notes — try merging pitched tracks, or choose a single track (e.g. drums).',
      'err',
    );
    await ensureSamplerLoaded();
    lastMidiNotes = [];
    const bundle = generateTrajectoryFromNotes([], { secondsPerBeat });
    setTrajectoryBundle(bundle);
    stopPlayback();
    scheduleMidiNotes([]);
    referencePathRecord = null;
    firedEvents = createEventTracker();
    activatedPlatforms.clear();
    rollAngle = 0;
    primaryTrailState.history.length = 0;
    primaryTrailState.lastT = -999;
    clearSecondaryBalls();
    resetCameraFollow();
    placeTrackForTrajectory();
    placeSustainedRails([]);
    syncPathOverlays();
    btnPlay.disabled = true;
    btnPause.disabled = true;
    btnStop.disabled = true;
    return;
  }

  setStatus('Loading instrument…', '');
  await ensureSamplerLoaded();

  lastMidiNotes = notes;
  const bundle = generateTrajectoryFromNotes(notes, { secondsPerBeat });
  setTrajectoryBundle(bundle);
  stopPlayback();
  scheduleMidiNotes(bundle.notes);

  /** Imported reference path is for another file/export; keep compare honest for this MIDI. */
  referencePathRecord = null;

  firedEvents = createEventTracker();
  activatedPlatforms.clear();
  rollAngle = 0;
  primaryTrailState.history.length = 0;
  primaryTrailState.lastT = -999;
  resetCameraFollow();

  placeTrackForTrajectory();
  placeSustainedRails(bundle.segments);
  syncPathOverlays();

  btnPlay.disabled = false;
  btnPause.disabled = false;
  btnStop.disabled = false;
  const trackSummary =
    trackIndex === MERGE_PITCHED_TRACKS
      ? `${notes.length} notes, merged ${pitchedTracksMerged ?? 0} pitched track(s)`
      : `${notes.length} notes, "${trackName}"`;
  setStatus(`Ready — ${trackSummary}, ~${duration.toFixed(1)}s`, 'ready');
}

async function applyMidiBuffer(buffer) {
  setStatus('Parsing MIDI…', '');
  btnPlay.disabled = true;
  btnPause.disabled = true;
  btnStop.disabled = true;

  resetTrackInstruments();
  lastMidiBuffer = buffer;
  lastJsonData = null;

  let parsed;
  try {
    parsed = parseMidiBuffer(buffer);
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`, 'err');
    return;
  }

  await applyParsedMidi(parsed);
}

void (async () => {
  setStatus('Loading default MIDI…', '');
  btnPlay.disabled = true;
  btnPause.disabled = true;
  btnStop.disabled = true;
  lastJsonData = defaultMidiJson;
  lastMidiBuffer = null;
  try {
    const parsed = parseMidiJsonExport(defaultMidiJson);
    await applyParsedMidi(parsed);
  } catch (e) {
    console.error(e);
    setStatus(
      `Load a .mid file to generate the path. (${e instanceof Error ? e.message : String(e)})`,
      'err',
    );
    btnPlay.disabled = true;
    btnPause.disabled = true;
    btnStop.disabled = true;
  }
})();

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    await applyMidiBuffer(buf);
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`, 'err');
  }
  fileInput.value = '';
});

trackSelect?.addEventListener('change', async () => {
  const v = trackSelect.value;
  const selection = v === MERGE_PITCHED_TRACKS ? MERGE_PITCHED_TRACKS : Number(v);
  if (v !== MERGE_PITCHED_TRACKS && Number.isNaN(/** @type {number} */ (selection))) return;
  setStatus('Switching track…', '');
  btnPlay.disabled = true;
  btnPause.disabled = true;
  btnStop.disabled = true;
  try {
    let parsed;
    if (lastMidiBuffer) {
      parsed = parseMidiBuffer(lastMidiBuffer, selection);
    } else if (lastJsonData) {
      parsed = parseMidiJsonExport(lastJsonData, selection);
    } else {
      return;
    }
    await applyParsedMidi(parsed);
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`, 'err');
  }
});

pathRefFileInput?.addEventListener('change', async () => {
  const file = pathRefFileInput?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const parsed = parsePathReferenceDocument(data);
    if (!parsed) {
      setStatus('Invalid trajectory-path JSON (need version:1 and points[]).', 'err');
      return;
    }
    referencePathRecord = parsed;
    syncPathOverlays();
    setStatus(`Reference path loaded (${parsed.points.length} samples).`, 'ready');
  } catch (e) {
    console.error(e);
    setStatus(`Reference JSON: ${e instanceof Error ? e.message : String(e)}`, 'err');
  }
  pathRefFileInput.value = '';
});

btnPlay.addEventListener('click', async () => {
  if (!hasTrajectory()) return;
  try {
    await startPlayback();
  } catch (e) {
    console.error(e);
    setStatus(`Audio: ${e instanceof Error ? e.message : String(e)}`, 'err');
  }
});

btnPause.addEventListener('click', () => {
  pausePlayback();
});

btnStop.addEventListener('click', () => {
  stopPlayback();
  firedEvents = createEventTracker();
  activatedPlatforms.clear();
  resetPlatformPool(platformPool);
  for (const sb of secondaryBalls) {
    sb.firedEvents = createEventTracker();
    sb.activatedPlatforms.clear();
    resetPlatformPool(sb.platformPool);
    sb.rollAngle = 0;
    sb.trailState.lastT = -999;
    sb.trailState.history.length = 0;
    sb.trail.line.geometry.setDrawRange(0, 0);
  }
});

// ---------------------------------------------------------------------------
// Trail
// ---------------------------------------------------------------------------

/**
 * @param {{ line: import('three').Line, positions: Float32Array, colors: Float32Array, tint: import('three').Color }} trailObj
 * @param {{ lastT: number, history: import('three').Vector3[] }} trailState
 * @param {import('three').Vector3} pos
 * @param {number} currentT
 */
function updateTrail(trailObj, trailState, pos, currentT) {
  if (currentT - trailState.lastT < params.main.trailInterval) return;
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;
  trailState.lastT = currentT;

  trailState.history.push(pos.clone());
  if (trailState.history.length > trailObj.positions.length / 3) trailState.history.shift();

  const len = trailState.history.length;
  const posArr = trailObj.positions;
  const colArr = trailObj.colors;
  const { r, g, b } = trailObj.tint;

  for (let i = 0; i < len; i++) {
    const v = trailState.history[i];
    const k = i * 3;
    posArr[k]     = v.x;
    posArr[k + 1] = v.y;
    posArr[k + 2] = v.z;

    const life = i / len;
    colArr[k]     = r * (0.35 + 0.65 * life);
    colArr[k + 1] = g * (0.35 + 0.65 * life);
    colArr[k + 2] = b * (0.35 + 0.65 * life);
  }

  trailObj.line.geometry.attributes.position.needsUpdate = true;
  trailObj.line.geometry.attributes.color.needsUpdate = true;
  trailObj.line.geometry.setDrawRange(0, len);
}

// ---------------------------------------------------------------------------
// Animation — timeline = Tone.Transport.seconds (locked to scheduled notes)
// ---------------------------------------------------------------------------

let prevRealT = 0;

function animate() {
  requestAnimationFrame(animate);

  const realNow = performance.now() / 1000;
  const dt = Math.min(realNow - prevRealT, 0.05);
  prevRealT = realNow;

  const currentT = getTransportSeconds();

  if (!hasTrajectory()) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    camera.layers.enable(0);
    camera.layers.enable(1);
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    renderer.toneMapping = THREE.NoToneMapping;
    return;
  }

  const state = getSegmentState(currentT);
  const visPos = state.pos;

  ball.position.copy(visPos);

  if (state.type === 'ROLL' || state.type === 'SUSTAINED' || state.type === 'SUSTAIN_ENTRY') {
    const vxy = Math.hypot(state.vel.x, state.vel.y);
    rollAngle += (vxy / params.main.ballRadius) * dt;
  }
  ball.rotation.z = -rollAngle;
  ball.children[0].quaternion.copy(camera.quaternion);

  updateBallSquash(ball, primarySquash, currentT);
  updateTrail(trail, primaryTrailState, visPos, currentT);

  // ── Secondary balls ──────────────────────────────────────────────────────
  for (const sb of secondaryBalls) {
    const sbState = evalTrajectory(sb.bundle, currentT);
    sb.ball.position.copy(sbState.pos);
    if (sbState.type === 'ROLL' || sbState.type === 'SUSTAINED' || sbState.type === 'SUSTAIN_ENTRY') {
      const vxy = Math.hypot(sbState.vel.x, sbState.vel.y);
      sb.rollAngle += (vxy / params.main.ballRadius) * dt;
    }
    sb.ball.rotation.z = -sb.rollAngle;
    sb.ball.children[0].quaternion.copy(camera.quaternion);
    updateBallSquash(sb.ball, sb.squash, currentT);
    updateTrail(sb.trail, sb.trailState, sbState.pos, currentT);

    // Platforms for secondary ball — use bundle-specific evaluators so pads
    // align with THIS ball's trajectory, not the primary one.
    const sbBundle = sb.bundle;
    const sbEventTimes = sbBundle.eventTimes;
    const sbLandingTypes = sbBundle.landingTypes;
    const sbLandingPitches = sbBundle.landingPitches;
    const sbRailOnly = sbBundle.eventUsesSustainedRail;
    const sbEvalPos = (t) => evalTrajectory(sbBundle, t).pos;
    const sbEvalVel = (t) => evalTrajectory(sbBundle, t - 0.004).vel;
    const m = params.main;
    for (let i = 0; i < sbEventTimes.length; i++) {
      if (sb.activatedPlatforms.has(i)) continue;
      if (sbLandingTypes[i] !== 'BOUNCE') continue;
      if (sbRailOnly[i]) continue;
      const et = sbEventTimes[i];
      if (et < currentT - m.platformPastWindow || et > currentT + m.lookahead) continue;
      const pitch = sbLandingPitches[i] ?? 60;
      activatePlatform(sb.platformPool, i, et, pitchToPlatformColor(pitch), sbEvalPos, sbEvalVel);
      sb.activatedPlatforms.add(i);
    }
    cullOldPlatforms(sb.platformPool, sbEventTimes, currentT, m.trailCullWindow);
    updatePlatformAnimations(sb.platformPool, currentT);
  }

  const nEvents = eventTimes.length;
  for (let i = 0; i < nEvents; i++) {
    if (activatedPlatforms.has(i)) continue;
    if (landingTypes[i] !== 'BOUNCE') continue;
    if (eventUsesSustainedRail[i]) continue;
    const et = eventTimes[i];
    const m = params.main;
    if (et < currentT - m.platformPastWindow || et > currentT + m.lookahead) continue;
    const pitch = landingPitches[i] ?? 60;
    activatePlatform(platformPool, i, et, pitchToPlatformColor(pitch));
    activatedPlatforms.add(i);
  }

  cullOldPlatforms(platformPool, eventTimes, currentT, params.main.trailCullWindow);
  updatePlatformAnimations(platformPool, currentT);
  updateParticles(particles, currentT, dt);

  const hits = pollEvents(eventTimes, firedEvents, currentT, params.main.pollWindow);
  for (const hit of hits) {
    const pitch = landingPitches[hit.index] ?? 60;
    const color = pitchToBurstColor(pitch);
    const isBounce = landingTypes[hit.index] === 'BOUNCE';

    const railOnly = eventUsesSustainedRail[hit.index];
    /** Same conditions as platform activation — avoids “impact in empty air” when there is no pad. */
    const hasBouncePad = isBounce && !railOnly;

    if (hasBouncePad) {
      const impactPos = P(hit.time).clone();
      impactPos.z = 0.4;
      clampBallPositionToWall(impactPos, params.main.ballRadius);
      triggerBurst(particles, impactPos, color, currentT);
      animatePlatformHit(platformPool, hit.index, currentT, lastSecondsPerBeat);
      triggerSquash(primarySquash, currentT);
    }

    hudBeat.textContent = `${railOnly ? '♪' : isBounce ? '⬇' : '→'} #${hit.index + 1}`;
  }

  updateCamera(camera, visPos, dt);
  updateKeyLight(keyLight, visPos.x, visPos.y);

  hudT.textContent = currentT.toFixed(3);
  hudPlat.textContent = `${platformPool.filter(g => g.visible).length} [${state.type}] ${getTransportState()}`;

  renderSelectiveBloom(renderer, scene, camera, bloomPipeline);
}

window.addEventListener('resize', () => {
  onResize(camera, renderer);
  resizeSelectiveBloomPipeline(bloomPipeline, window.innerWidth, window.innerHeight);
});

createDebugGui({
  scene,
  camera,
  bloomPass,
  wall,
  ambient,
  fill,
  keyLight,
  trailLine: trail.line,
  particles,
  onRegenerateTrajectory: regenerateTrajectoryFromMidi,
  syncPathOverlays,
  exportTrajectoryPathJson,
  clearReferencePath,
  onPickReferencePath: () => pathRefFileInput?.click(),
  pathRefOverlay,
  bakedPathOverlay,
});

animate();
