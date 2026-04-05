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
  seekTransportSeconds,
  getTransportSeconds,
  getTransportState,
  INSTRUMENT_DEFS,
  setTrackInstrument,
  getTrackInstrument,
  ensureInstrumentLoaded,
  resetTrackInstruments,
} from './audioSampler.js';
import { parseMidiBuffer, parseMidiJsonExport, MERGE_PITCHED_TRACKS } from './midi/midiParser.js';
import { computeMidiPatternFeatures } from './midi/midiPatternFeatures.js';
import defaultMidiJson from './midis/midi.json';
import { generateTrajectoryFromNotes } from './midi/trajectoryGenerator.js';
import { pitchToBurstColor, pitchToPlatformColor } from './midi/pitchColor.js';
import {
  createScene, createRenderer, createCamera, createLights,
  createSelectiveBloomPipeline, resizeSelectiveBloomPipeline, renderSelectiveBloom,
  createWall, createWallBackground, createBall, createPlatformPool, createTrack,
  createSustainedRailsGroup,
  createTrail, createParticleSystem, triggerBurst, updateParticles,
  createRipplePool, triggerRipple, updateRipples,
  createPathOverlayLine, updatePathOverlayGeometry,
  clampBallPositionToWall,
  setBallPitchTint,
} from './scene.js';
import { loadWallTexturesAsync } from './wallTextures.js';
import { applyPlatformTexturesToPool, publicTextureUrl } from './platformTextures.js';
import {
  activatePlatform, cullOldPlatforms, resetPlatformPool,
  animatePlatformHit, updatePlatformAnimations,
} from './platforms.js';
import { isFastNote } from './segments.js';
import { updateCamera, updateKeyLight, onResize, resetCameraFollow } from './camera.js';
import { params } from './params.js';
import { createDebugGui } from './debugGui.js';

/** @type {((r: import('./midi/midiPatternFeatures.js').MidiPatternFeaturesResult | null) => void) | null} */
let setPatternFeatures = null;

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
const trackPicker = document.getElementById('track-picker');
const btnTracksAll = document.getElementById('btn-tracks-all');
const seekBar = /** @type {HTMLInputElement | null} */ (document.getElementById('seek-bar'));
const seekTimeEl = document.getElementById('seek-time');
const btnSeekBack = document.getElementById('btn-seek-back');
const btnSeekFwd = document.getElementById('btn-seek-fwd');
const instrumentPanel = document.getElementById('instrument-panel');
const midiSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById('midi-select'));

/** Timeline length (seconds) for scrub bar — from last successful parse. */
let lastDurationSeconds = 0;
/** While true, `animate` does not overwrite the seek slider from transport. */
let seekBarDragging = false;

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

function formatTimeSec(t) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
}

/** @returns {number[]} */
function getCheckedIncludedTrackIndices() {
  if (!trackPicker) return [];
  const boxes = trackPicker.querySelectorAll('input[type="checkbox"][data-track-index]');
  return [...boxes]
    .filter(b => b.checked)
    .map(b => parseInt(b.getAttribute('data-track-index') ?? '0', 10));
}

function resetVisualStateForSeek() {
  firedEvents = createEventTracker();
  activatedPlatforms.clear();
  resetPlatformPool(platformPool);
  rollAngle = 0;
  primaryTrailState.history.length = 0;
  primaryTrailState.lastT = -999;
  primarySquash.active = false;
  for (const sb of secondaryBalls) {
    sb.firedEvents = createEventTracker();
    sb.activatedPlatforms.clear();
    resetPlatformPool(sb.platformPool);
    sb.rollAngle = 0;
    sb.squash.active = false;
    sb.trailState.lastT = -999;
    sb.trailState.history.length = 0;
    sb.trail.line.geometry.setDrawRange(0, 0);
  }
}

/**
 * @param {number} seconds
 */
async function seekToTime(seconds) {
  if (!hasTrajectory() || !lastMidiNotes?.length) return;
  const maxT = Math.max(0.01, lastDurationSeconds);
  const t = Math.max(0, Math.min(maxT, seconds));
  const wasPlaying = getTransportState() === 'started';
  pausePlayback();
  seekTransportSeconds(t);
  scheduleMidiNotes(lastMidiNotes);
  resetVisualStateForSeek();
  if (wasPlaying) {
    try {
      await startPlayback();
    } catch (e) {
      console.error(e);
      setStatus(`Audio: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  }
}

let trackPickerDebounce = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

async function applyTrackIncludeSelection() {
  const checked = getCheckedIncludedTrackIndices();
  if (!checked.length) {
    setStatus('Select at least one pitched track.', 'err');
    return;
  }
  setStatus('Updating tracks…', '');
  btnPlay.disabled = true;
  btnPause.disabled = true;
  btnStop.disabled = true;
  try {
    let parsed;
    if (lastMidiBuffer) {
      parsed = parseMidiBuffer(lastMidiBuffer, checked);
    } else if (lastJsonData) {
      parsed = parseMidiJsonExport(lastJsonData, checked);
    } else {
      return;
    }
    await applyParsedMidi(parsed);
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`, 'err');
  }
}

function scheduleTrackPickerApply() {
  if (trackPickerDebounce) clearTimeout(trackPickerDebounce);
  trackPickerDebounce = setTimeout(() => {
    trackPickerDebounce = null;
    void applyTrackIncludeSelection();
  }, 280);
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
void applyPlatformTexturesToPool(platformPool).catch(err =>
  console.warn('Platform PBR textures:', err),
);
const particles  = createParticleSystem(scene);
const ripplePool = createRipplePool(scene);
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
  const ms = params.scene.masterScale;
  if (!squashState.active) {
    mesh.scale.setScalar(ms);
    return;
  }
  const age = now - squashState.startTime;
  if (age > params.main.squashDuration) {
    mesh.scale.setScalar(ms);
    squashState.active = false;
    return;
  }
  const p   = age / params.main.squashDuration;
  // Two-phase: compress on landing (0→0.35), then stretch/return (0.35→1).
  // Peaks at 1.0 so squashAmount directly sets max deformation fraction.
  const env = p < 0.35
    ? Math.sin(Math.PI * (p / 0.35))
    : Math.sin(Math.PI * ((p - 0.35) / 0.65)) * 0.4;
  const a   = params.main.squashAmount;
  mesh.scale.set((1 + 0.875 * a * env) * ms, (1 - a * env) * ms, (1 + 0.875 * a * env) * ms);
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
  const sbParticles = createParticleSystem(scene);
  const sbRipplePool = createRipplePool(scene);
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
    particles: sbParticles,
    ripplePool: sbRipplePool,
  });
  void applyPlatformTexturesToPool(sbPool).catch(err =>
    console.warn('Platform PBR textures (secondary):', err),
  );
}

/** @param {SecondaryBall} entry */
function disposeSecondaryBall(entry) {
  scene.remove(entry.ball);
  scene.remove(entry.trail.line);
  for (const group of entry.platformPool) scene.remove(group);
  if (entry.particles) {
    for (const p of entry.particles) { p.mesh.visible = false; scene.remove(p.mesh); }
  }
  if (entry.ripplePool) {
    for (const r of entry.ripplePool) { r.visible = false; scene.remove(r); }
  }
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

({ setPatternFeatures } = createDebugGui({
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
}));

/**
 * Pitched tracks only — checked rows are merged into one trajectory + mix.
 * @param {{ tracks: import('./midi/midiParser.js').MidiTrackSummary[], trackIndex: number | typeof MERGE_PITCHED_TRACKS, includedTrackIndices?: number[] }} parsed
 */
function populateTrackPicker(parsed) {
  if (!trackPicker) return;
  const { tracks, includedTrackIndices } = parsed;
  const inc = new Set(includedTrackIndices ?? []);
  trackPicker.innerHTML = '';
  const pitched = tracks.filter(t => !t.isPercussion);
  if (!pitched.length) {
    trackPicker.appendChild(document.createTextNode('(no pitched tracks)'));
    if (btnTracksAll) btnTracksAll.disabled = true;
    return;
  }
  if (btnTracksAll) btnTracksAll.disabled = false;

  for (const t of pitched) {
    const label = document.createElement('label');
    label.className = 'track-pick-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.trackIndex = String(t.index);
    cb.checked = inc.size === 0 ? true : inc.has(t.index);
    cb.addEventListener('change', () => {
      const selected = getCheckedIncludedTrackIndices();
      if (!selected.length) {
        cb.checked = true;
        setStatus('Select at least one pitched track.', 'err');
        return;
      }
      scheduleTrackPickerApply();
    });
    const span = document.createElement('span');
    span.textContent = `${t.index}: ${t.name}`;
    span.title = `${t.noteCount} notes`;
    label.appendChild(cb);
    label.appendChild(span);
    trackPicker.appendChild(label);
  }
}

/**
 * Build per-track instrument dropdowns.
 * Shows one row per track that has notes (all tracks in merged mode, just the
 * selected track in single-track mode).
 * @param {{ tracks: import('./midi/midiParser.js').MidiTrackSummary[], trackIndex: number | typeof MERGE_PITCHED_TRACKS, includedTrackIndices?: number[] }} parsed
 */
function populateInstrumentPanel(parsed) {
  if (!instrumentPanel) return;
  instrumentPanel.innerHTML = '';

  const { tracks, trackIndex, includedTrackIndices } = parsed;
  const isMerged = trackIndex === MERGE_PITCHED_TRACKS;
  const includedSet = new Set(includedTrackIndices ?? []);
  const tracksToShow = isMerged
    ? tracks.filter(t => t.noteCount > 0 && !t.isPercussion && includedSet.has(t.index))
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
  populateTrackPicker(parsed);
  populateInstrumentPanel(parsed);

  const { notes, duration, trackName, secondsPerBeat, trackIndex, pitchedTracksMerged } = parsed;
  lastSecondsPerBeat = secondsPerBeat;
  lastDurationSeconds = duration;
  if (seekBar) {
    seekBar.max = String(Math.max(0.01, duration));
    seekBar.disabled = !notes.length;
  }
  if (btnSeekBack) btnSeekBack.disabled = !notes.length;
  if (btnSeekFwd) btnSeekFwd.disabled = !notes.length;
  if (seekTimeEl) {
    seekTimeEl.textContent = `${formatTimeSec(0)} / ${formatTimeSec(duration)}`;
  }

  // Build per-track note lookup for secondary ball trajectory generation
  lastParsedNotesByTrack = new Map();
  for (const note of notes) {
    const ti = note.trackIndex ?? 0;
    if (!lastParsedNotesByTrack.has(ti)) lastParsedNotesByTrack.set(ti, []);
    /** @type {import('./midi/midiParser.js').MidiNoteEvent[]} */ (lastParsedNotesByTrack.get(ti)).push(note);
  }

  // Remove any secondary balls from the previous MIDI (track layout may differ)
  clearSecondaryBalls();
  // Hide pooled platforms from the previous curve (lookahead only reuses a subset of slots)
  resetPlatformPool(platformPool);

  if (!notes.length) {
    setStatus(
      'No notes — include at least one pitched track (drum tracks are ignored).',
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
    setPatternFeatures?.(null);
    return;
  }

  setStatus('Loading instrument…', '');
  await ensureSamplerLoaded();

  lastMidiNotes = notes;
  setPatternFeatures?.(computeMidiPatternFeatures(notes, { secondsPerBeat }));
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

/**
 * @returns {Promise<Array<{ file: string, label?: string }>>}
 */
async function fetchMidiManifest() {
  const url = publicTextureUrl('midis/manifest.json');
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error('manifest must be an array');
    return data;
  } catch (e) {
    console.warn('bundled MIDI manifest: using fallback list', e);
    return [
      { file: 'midi.json', label: 'Default' },
      { file: 'believer.json', label: 'Believer' },
      { file: 'VisiPiano.json', label: 'Visi Piano' },
    ];
  }
}

async function populateBundledMidiSelect() {
  if (!midiSelect) return;
  const list = await fetchMidiManifest();
  midiSelect.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = 'Bundled MIDI…';
  midiSelect.appendChild(opt0);
  for (const item of list) {
    const f = item.file;
    if (!f) continue;
    const label = item.label ?? f;
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = label;
    midiSelect.appendChild(opt);
  }
}

/**
 * Load a `.json` export or raw `.mid` / `.midi` from `public/midis/<filename>`.
 * @param {string} filename
 */
async function applyBundledMidiFromPublic(filename) {
  const url = publicTextureUrl(`midis/${encodeURIComponent(filename)}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${filename}`);
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  resetTrackInstruments();

  if (ext === 'json') {
    const data = await r.json();
    lastJsonData = data;
    lastMidiBuffer = null;
    const parsed = parseMidiJsonExport(data);
    await applyParsedMidi(parsed);
  } else if (ext === 'mid' || ext === 'midi') {
    const buf = await r.arrayBuffer();
    lastMidiBuffer = buf;
    lastJsonData = null;
    const parsed = parseMidiBuffer(buf);
    await applyParsedMidi(parsed);
  } else {
    throw new Error(`Unsupported file type: ${filename}`);
  }

  if (midiSelect) midiSelect.value = filename;
}

async function applyMidiBuffer(buffer) {
  setStatus('Parsing MIDI…', '');
  btnPlay.disabled = true;
  btnPause.disabled = true;
  btnStop.disabled = true;

  resetTrackInstruments();
  lastMidiBuffer = buffer;
  lastJsonData = null;
  if (midiSelect) midiSelect.value = '';

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
  await populateBundledMidiSelect();
  setStatus('Loading default MIDI…', '');
  btnPlay.disabled = true;
  btnPause.disabled = true;
  btnStop.disabled = true;
  lastJsonData = defaultMidiJson;
  lastMidiBuffer = null;
  try {
    const parsed = parseMidiJsonExport(defaultMidiJson);
    await applyParsedMidi(parsed);
    if (midiSelect) midiSelect.value = 'midi.json';
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

midiSelect?.addEventListener('change', async () => {
  const f = midiSelect.value;
  if (!f) return;
  try {
    setStatus('Loading bundled MIDI…', '');
    btnPlay.disabled = true;
    btnPause.disabled = true;
    btnStop.disabled = true;
    await applyBundledMidiFromPublic(f);
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`, 'err');
  }
});

btnTracksAll?.addEventListener('click', () => {
  if (!trackPicker) return;
  const boxes = trackPicker.querySelectorAll('input[type="checkbox"][data-track-index]');
  for (const b of boxes) {
    b.checked = true;
  }
  scheduleTrackPickerApply();
});

seekBar?.addEventListener('pointerdown', () => {
  seekBarDragging = true;
});
seekBar?.addEventListener('input', () => {
  seekBarDragging = true;
});
seekBar?.addEventListener('change', () => {
  if (!seekBar) return;
  seekBarDragging = false;
  void seekToTime(parseFloat(seekBar.value));
});

const SEEK_SKIP_SEC = 5;
btnSeekBack?.addEventListener('click', () => {
  void seekToTime(getTransportSeconds() - SEEK_SKIP_SEC);
});
btnSeekFwd?.addEventListener('click', () => {
  void seekToTime(getTransportSeconds() + SEEK_SKIP_SEC);
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
 * @param {number} [speed]  ball speed (world units/s) — drives brightness + sample density
 */
function updateTrail(trailObj, trailState, pos, currentT, speed = 0) {
  // Faster ball → sample more often (denser trail) and brighter
  const refSpeed   = Math.max(1, params.trajectory.targetSpeed);
  const sf         = Math.min(1, speed / (refSpeed * 1.5));          // 0–1
  const interval   = params.main.trailInterval / Math.max(1, 1 + sf * 2);
  if (currentT - trailState.lastT < interval) return;
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;
  trailState.lastT = currentT;

  trailState.history.push(pos.clone());
  if (trailState.history.length > trailObj.positions.length / 3) trailState.history.shift();

  const len    = trailState.history.length;
  const posArr = trailObj.positions;
  const colArr = trailObj.colors;
  const { r, g, b } = trailObj.tint;
  const boost  = 1 + sf * (params.main.trailSpeedBoost - 1);

  for (let i = 0; i < len; i++) {
    const v = trailState.history[i];
    const k = i * 3;
    posArr[k]     = v.x;
    posArr[k + 1] = v.y;
    posArr[k + 2] = v.z;

    const life = i / len;
    const br   = Math.min(1, (0.35 + 0.65 * life) * boost);
    colArr[k]     = r * br;
    colArr[k + 1] = g * br;
    colArr[k + 2] = b * br;
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

  updateBallSquash(ball, primarySquash, currentT);
  updateTrail(trail, primaryTrailState, visPos, currentT, state.vel.length());

  // ── Secondary balls ──────────────────────────────────────────────────────
  for (const sb of secondaryBalls) {
    const sbState = evalTrajectory(sb.bundle, currentT);
    sb.ball.position.copy(sbState.pos);
    if (sbState.type === 'ROLL' || sbState.type === 'SUSTAINED' || sbState.type === 'SUSTAIN_ENTRY') {
      const vxy = Math.hypot(sbState.vel.x, sbState.vel.y);
      sb.rollAngle += (vxy / params.main.ballRadius) * dt;
    }
    sb.ball.rotation.z = -sb.rollAngle;
    updateBallSquash(sb.ball, sb.squash, currentT);
    updateTrail(sb.trail, sb.trailState, sbState.pos, currentT, sbState.vel.length());

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
      const fast = isFastNote(sbEventTimes, i);
      activatePlatform(sb.platformPool, i, et, pitchToPlatformColor(pitch), sbEvalPos, sbEvalVel, fast);
      sb.activatedPlatforms.add(i);
    }
    cullOldPlatforms(sb.platformPool, sbEventTimes, currentT, m.trailCullWindow);
    updatePlatformAnimations(sb.platformPool, currentT);
    updateParticles(sb.particles, currentT, dt);
    updateRipples(sb.ripplePool, currentT);
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
    const fast = isFastNote(eventTimes, i);
    activatePlatform(platformPool, i, et, pitchToPlatformColor(pitch), undefined, undefined, fast);
    activatedPlatforms.add(i);
  }

  cullOldPlatforms(platformPool, eventTimes, currentT, params.main.trailCullWindow);
  updatePlatformAnimations(platformPool, currentT);
  updateParticles(particles, currentT, dt);
  updateRipples(ripplePool, currentT);

  const hits = pollEvents(eventTimes, firedEvents, currentT, params.main.pollWindow);
  for (const hit of hits) {
    const pitch = landingPitches[hit.index] ?? 60;
    const color = pitchToBurstColor(pitch);
    const isBounce = landingTypes[hit.index] === 'BOUNCE';

    const railOnly = eventUsesSustainedRail[hit.index];
    const hasBouncePad = isBounce && !railOnly;

    if (hasBouncePad) {
      const impactPos = P(hit.time).clone();
      impactPos.z = 0.4;
      clampBallPositionToWall(impactPos, params.main.ballRadius);

      triggerBurst(particles, impactPos, color, currentT);
      animatePlatformHit(platformPool, hit.index, currentT, lastSecondsPerBeat);
      if (params.fx.rippleEnabled) triggerRipple(ripplePool, impactPos, color, currentT);

      triggerSquash(primarySquash, currentT);
      const padHex = pitchToPlatformColor(pitch);
      setBallPitchTint(ball, padHex);
      trail.tint.setHex(padHex);
    }

    hudBeat.textContent = `${railOnly ? '♪' : isBounce ? '⬇' : '→'} #${hit.index + 1}`;
  }

  for (const sb of secondaryBalls) {
    const b = sb.bundle;
    const sbHits = pollEvents(b.eventTimes, sb.firedEvents, currentT, params.main.pollWindow);
    for (const hit of sbHits) {
      const pitch = b.landingPitches[hit.index] ?? 60;
      const color = pitchToBurstColor(pitch);
      const isBounce = b.landingTypes[hit.index] === 'BOUNCE';
      const railOnly = b.eventUsesSustainedRail[hit.index];
      const hasBouncePad = isBounce && !railOnly;
      if (hasBouncePad) {
        const impactPos = evalTrajectory(b, hit.time).pos.clone();
        impactPos.z = 0.4;
        clampBallPositionToWall(impactPos, params.main.ballRadius);

        triggerBurst(sb.particles, impactPos, color, currentT);
        animatePlatformHit(sb.platformPool, hit.index, currentT, lastSecondsPerBeat);
        if (params.fx.rippleEnabled) triggerRipple(sb.ripplePool, impactPos, color, currentT);

        triggerSquash(sb.squash, currentT);
        const padHex = pitchToPlatformColor(pitch);
        setBallPitchTint(sb.ball, padHex);
        sb.trail.tint.setHex(padHex);
      }
    }
  }

  // Scale individual visual objects — layout/trajectory positions unchanged.
  const ms = params.scene.masterScale;
  if (trackGroup)        trackGroup.scale.setScalar(ms);
  if (sustainedRailGroup) sustainedRailGroup.scale.setScalar(ms);

  updateCamera(camera, visPos, dt);
  updateKeyLight(keyLight, visPos.x, visPos.y);

  hudT.textContent = currentT.toFixed(3);
  hudPlat.textContent = `${platformPool.filter(g => g.visible).length} [${state.type}] ${getTransportState()}`;

  if (seekBar && !seekBarDragging) {
    seekBar.value = String(Math.min(lastDurationSeconds, Math.max(0, currentT)));
  }
  if (seekTimeEl) {
    seekTimeEl.textContent = `${formatTimeSec(currentT)} / ${formatTimeSec(lastDurationSeconds)}`;
  }

  renderSelectiveBloom(renderer, scene, camera, bloomPipeline);
}

window.addEventListener('resize', () => {
  onResize(camera, renderer);
  resizeSelectiveBloomPipeline(bloomPipeline, window.innerWidth, window.innerHeight);
});

animate();
