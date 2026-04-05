/**
 * lil-gui panel for params.js — trajectory changes call onRegenerate when MIDI is loaded.
 */

import GUI from 'lil-gui';
import { params } from './params.js';
import { refreshWallGradient, applyWallDimensions } from './scene.js';

/**
 * @param {{
 *   scene: import('three').Scene,
 *   camera: import('three').PerspectiveCamera,
 *   wall: import('three').Mesh,
 *   ambient: import('three').AmbientLight,
 *   keyLight: import('three').DirectionalLight,
 *   fill: import('three').DirectionalLight,
 *   trailLine: import('three').Line,
 *   particles: Array<{ points: import('three').Points }>,
 *   onRegenerateTrajectory: () => void,
 *   syncPathOverlays?: () => void,
 *   exportTrajectoryPathJson?: () => void,
 *   clearReferencePath?: () => void,
 *   onPickReferencePath?: () => void,
 *   pathRefOverlay?: { line: import('three').Line },
 *   bakedPathOverlay?: { line: import('three').Line },
 * }} ctx
 * @returns {{
 *   gui: import('lil-gui').default,
 *   setPatternFeatures: (result: import('./midi/midiPatternFeatures.js').MidiPatternFeaturesResult | null) => void,
 * }}
 */
export function createDebugGui(ctx) {
  const gui = new GUI({ title: 'Curve Beats', width: 340 });
  gui.domElement.style.setProperty('--font-size', '13px');
  gui.domElement.style.setProperty('--input-font-size', '13px');
  gui.domElement.style.setProperty('--widget-height', '24px');
  gui.domElement.style.setProperty('--title-font-size', '13px');

  // ── Baked trajectory from MIDI (reload / regenerate to apply) ─────────────
  const refPath = gui.addFolder('Reference path');
  refPath.open();

  const motion = refPath.addFolder('Motion & landings');
  motion.add(params.trajectory, 'bounceThreshold', 0.2, 2.5, 0.01).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'rollSpatialGapUncapped').onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'sustainDurationMin', 0.5, 5, 0.05).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'sustainFallSpeed', 0.5, 20, 0.25).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'sustainMaxFall', 2, 40, 0.5).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'sustainArcBulge', 0, 0.6, 0.01).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'sustainPlatformDrop', 0.05, 2, 0.02).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'sustainEntryDuration', 0.03, 0.35, 0.01).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'targetSpeed', 0.5, 40, 0.5).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'minSpatialX',   0, 20, 0.1).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'minSpatialY',   0, 10, 0.1).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'maxSpatialGap', 0.2, 10, 0.1).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'gravity', 5, 120, 1).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'yDropMax', 0.2, 20, 0.1).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'dropScale', 0.05, 1, 0.01).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'spawnX', -40, 40, 0.5).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'spawnY', -50, 50, 0.5).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'ballZ', -2, 4, 0.05).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'linearDrag', 0, 2.5, 0.02).onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'bounceAlternateSides').onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'fastCompressX', 0.1, 1.0, 0.01).name('fast compress X').onFinishChange(ctx.onRegenerateTrajectory);
  motion.add(params.trajectory, 'fastCompressY', 0.1, 1.0, 0.01).name('fast compress Y').onFinishChange(ctx.onRegenerateTrajectory);
  const sideZones = {
    json: JSON.stringify(params.trajectory.bounceAlternateSideRanges ?? []),
  };
  motion.add(sideZones, 'json').name('alternate side zones (JSON)').onFinishChange(v => {
    try {
      const p = JSON.parse(typeof v === 'string' && v.trim() ? v : '[]');
      if (!Array.isArray(p)) throw new Error('expected JSON array');
      params.trajectory.bounceAlternateSideRanges = p;
      sideZones.json = JSON.stringify(p);
      ctx.onRegenerateTrajectory();
    } catch (e) {
      console.warn('bounceAlternateSideRanges JSON', e);
    }
  });
  motion.open();

  const gap = refPath.addFolder('Gap (MIDI beats)');
  gap.add(params.gap, 'smallBeatMax', 0.05, 1, 0.01).onFinishChange(ctx.onRegenerateTrajectory);
  gap.add(params.gap, 'mediumBeatMax', 0.25, 4, 0.05).onFinishChange(ctx.onRegenerateTrajectory);
  gap.add(params.gap, 'transTimeRatio', 0.1, 0.9, 0.01).onFinishChange(ctx.onRegenerateTrajectory);
  gap.add(params.gap, 'fallTimeRatio', 0.1, 0.9, 0.01).onFinishChange(ctx.onRegenerateTrajectory);
  gap.add(params.gap, 'enableSplit').onFinishChange(ctx.onRegenerateTrajectory);

  const midiIn = refPath.addFolder('MIDI note filter');
  midiIn.add(params.audio, 'minNoteDuration', 0.01, 0.5, 0.005).onFinishChange(ctx.onRegenerateTrajectory);
  midiIn.add(params.audio, 'maxNoteDuration', 0.1, 5, 0.05).onFinishChange(ctx.onRegenerateTrajectory);

  refPath.add({ regenerate() {
    ctx.onRegenerateTrajectory();
  } }, 'regenerate').name('↻ Regenerate (needs MIDI loaded)');

  const cam = gui.addFolder('Camera');
  cam.add(params.camera, 'followBallX').name('followBallX (tight, legacy)');
  cam.add(params.camera, 'cameraZ', 15, 200, 1);
  cam.add(params.camera, 'offsetX', -40, 40, 0.1);
  cam.add(params.camera, 'offsetY', -5, 15, 0.1);
  cam.add(params.camera, 'lookBiasY', -10, 5, 0.1);
  cam.add(params.camera, 'lerpY', 0.005, 0.2, 0.001).name('lerpY (Y follow)');
  cam.add(params.camera, 'maxCameraYSpeed', 4, 80, 1);
  cam.add(params.camera, 'xDeadZoneFrac', 0, 1, 0.01).name('xDeadZone (0=always follow, 1=never move)');
  cam.add(params.camera, 'xEdgeLerp', 0.005, 0.3, 0.005).name('xEdgeLerp (catch-up speed)');
  cam.add(params.camera, 'xCentreReturn', 0, 0.02, 0.001).name('xCentreReturn (drift to centre)');

  const main = gui.addFolder('Main loop');
  main.add(params.main, 'lookahead', 0.5, 40, 0.5);
  main.add(params.main, 'platformPastWindow', 0.05, 5, 0.05);
  main.add(params.main, 'trailInterval', 0.004, 0.08, 0.002);
  main.add(params.main, 'trailCullWindow', 0.2, 15, 0.1);
  main.add(params.main, 'pollWindow', 0.01, 0.2, 0.005);
  main.add(params.main, 'ballRadius', 0.05, 1, 0.01);
  main.add(params.main, 'squashDuration',      0.05, 0.8,  0.01);
  main.add(params.main, 'squashAmount',         0,    1.5,  0.01);
  main.add(params.main, 'fastNoteThreshold',    0,    0.5,  0.01).name('fast note threshold (s)');
  main.add(params.main, 'trailSpeedBoost',      1,    5,    0.1 ).name('trail speed boost');
  main.add(params.main, 'fastPadScale',         0.1,  1.0,  0.01).name('stair pad scale');

  const sc = gui.addFolder('Scene');
  sc.add(params.scene, 'masterScale', 0.1, 5, 0.01).name('master scale');
  sc.add(params.scene, 'fov', 10, 100, 1).onChange(() => {
    ctx.camera.fov = params.scene.fov;
    ctx.camera.updateProjectionMatrix();
  });
  sc.add(params.scene, 'ambientIntensity', 0, 2, 0.02).onChange(() => {
    ctx.ambient.intensity = params.scene.ambientIntensity;
  });
  sc.add(params.scene, 'keyIntensity', 0, 3, 0.02).onChange(() => {
    ctx.keyLight.intensity = params.scene.keyIntensity;
  });
  sc.add(params.scene, 'fillIntensity', 0, 2, 0.02).onChange(() => {
    ctx.fill.intensity = params.scene.fillIntensity;
  });
  sc.addColor(params.scene, 'backgroundColor').onChange(() => {
    ctx.scene.background.set(params.scene.backgroundColor);
    if (ctx.scene.fog && 'color' in ctx.scene.fog) {
      ctx.scene.fog.color.set(params.scene.backgroundColor);
    }
  });
  sc.addColor(params.scene, 'wallGradientBottom').onChange(() => {
    refreshWallGradient(ctx.wall);
  });
  sc.addColor(params.scene, 'wallGradientTop').onChange(() => {
    refreshWallGradient(ctx.wall);
  });
  sc.add(params.scene, 'wallHalfWidth', 20, 2000, 5).onFinishChange(() => {
    applyWallDimensions(ctx.wall);
  });
  sc.add(params.scene, 'wallHalfHeight', 200, 25000, 50).onFinishChange(() => {
    applyWallDimensions(ctx.wall);
  });
  sc.add(params.scene, 'wallCenterY', -12000, 2000, 10).onFinishChange(() => {
    applyWallDimensions(ctx.wall);
  });

  sc.add(params.scene, 'bloomStrength', 0, 2, 0.02).onChange(() => {
    if (ctx.bloomPass) ctx.bloomPass.strength = params.scene.bloomStrength;
  });
  sc.add(params.scene, 'bloomRadius', 0, 1, 0.02).onChange(() => {
    if (ctx.bloomPass) ctx.bloomPass.radius = params.scene.bloomRadius;
  });
  sc.add(params.scene, 'bloomThreshold', 0, 1, 0.02).onChange(() => {
    if (ctx.bloomPass) ctx.bloomPass.threshold = params.scene.bloomThreshold;
  });

  const fx = gui.addFolder('FX');
  fx.add(params.fx, 'platformEmissiveBase', 0.05, 1.2, 0.02);
  fx.add(params.fx, 'platformGlowBeats', 0.1, 2, 0.02);
  fx.add(params.fx, 'platformGlowPeak', 0.2, 3, 0.05);
  fx.add(params.fx, 'platformGlowStrike', 0.02, 0.25, 0.005);
  fx.add(params.fx, 'platformGlowHoldFrac', 0.05, 0.55, 0.01);
  fx.add(params.fx, 'trailOpacity', 0.05, 1, 0.02).onChange(() => {
    ctx.trailLine.material.opacity = params.fx.trailOpacity;
  });
  fx.add(params.fx, 'particleSize', 0.02, 0.5, 0.01).onChange(() => {
    for (const b of ctx.particles) {
      b.points.material.size = params.fx.particleSize;
    }
  });
  fx.add(params.fx, 'particleLifetime', 0.1, 3, 0.05);
  fx.add(params.fx, 'particleDamping', 0.5, 0.999, 0.005);
  fx.add(params.fx, 'burstScatterXY', 0.5, 8, 0.1);
  fx.add(params.fx, 'burstScatterY', 0.5, 8, 0.1);
  fx.add(params.fx, 'burstScatterZ', 0.5, 8, 0.1);
  fx.add(params.fx, 'rippleEnabled').name('ripple rings');
  fx.add(params.fx, 'rippleMaxRadius', 0.5, 10, 0.1).name('ripple max radius');
  fx.add(params.fx, 'rippleDuration', 0.1, 2.0, 0.05).name('ripple duration (s)');

  const pitch = gui.addFolder('Pitch → color (visual)');
  pitch.add(params.pitch, 'midiMin', 0, 127, 1);
  pitch.add(params.pitch, 'midiMax', 0, 127, 1);

  const pathCmp = gui.addFolder('Path compare');
  pathCmp.add(params.pathCompare, 'showReference').onChange(() => ctx.syncPathOverlays?.());
  pathCmp.add(params.pathCompare, 'showBakedPath').onChange(() => ctx.syncPathOverlays?.());
  pathCmp.add(params.pathCompare, 'sampleDt', 0.005, 0.12, 0.005).onFinishChange(() => ctx.syncPathOverlays?.());
  pathCmp.add(params.pathCompare, 'referenceOpacity', 0.05, 1, 0.02).onChange(() => {
    if (ctx.pathRefOverlay) ctx.pathRefOverlay.line.material.opacity = params.pathCompare.referenceOpacity;
  });
  pathCmp.add(params.pathCompare, 'bakedOpacity', 0.05, 1, 0.02).onChange(() => {
    if (ctx.bakedPathOverlay) ctx.bakedPathOverlay.line.material.opacity = params.pathCompare.bakedOpacity;
  });
  pathCmp.add({
    exportPath() {
      ctx.exportTrajectoryPathJson?.();
    },
  }, 'exportPath').name('Export path JSON');
  pathCmp.add({
    loadReference() {
      ctx.onPickReferencePath?.();
    },
  }, 'loadReference').name('Load reference JSON…');
  pathCmp.add({
    clearReference() {
      ctx.clearReferencePath?.();
    },
  }, 'clearReference').name('Clear reference');

  const patternHud = {
    phraseCount: '—',
    medianIoiBeats: '—',
    notesPerSec: '—',
    maxDensity: '—',
    syncopation: '—',
    tripletAff: '—',
    sustainedFrac: '—',
    burstFrac: '—',
  };
  const pat = gui.addFolder('MIDI pattern features');
  pat.add(patternHud, 'phraseCount').name('phrases').disable();
  pat.add(patternHud, 'medianIoiBeats').name('median IOI (beats)').disable();
  pat.add(patternHud, 'notesPerSec').name('notes/s (avg)').disable();
  pat.add(patternHud, 'maxDensity').name('max density (window)').disable();
  pat.add(patternHud, 'syncopation').name('mean syncopation').disable();
  pat.add(patternHud, 'tripletAff').name('mean triplet affinity').disable();
  pat.add(patternHud, 'sustainedFrac').name('sustained ratio').disable();
  pat.add(patternHud, 'burstFrac').name('burst windows').disable();

  /** @type {import('./midi/midiPatternFeatures.js').MidiPatternFeaturesResult | null} */
  let lastPatternResult = null;

  pat.add({
    logFull() {
      if (!lastPatternResult) {
        console.warn('No MIDI pattern result — load a MIDI first.');
        return;
      }
      console.log('MIDI pattern features', lastPatternResult);
    },
  }, 'logFull').name('Log full result → console');

  function setPatternFeatures(result) {
    lastPatternResult = result;
    if (!result?.summary) {
      patternHud.phraseCount = '—';
      patternHud.medianIoiBeats = '—';
      patternHud.notesPerSec = '—';
      patternHud.maxDensity = '—';
      patternHud.syncopation = '—';
      patternHud.tripletAff = '—';
      patternHud.sustainedFrac = '—';
      patternHud.burstFrac = '—';
    } else {
      const s = result.summary;
      patternHud.phraseCount = String(s.phraseCount);
      patternHud.medianIoiBeats = Number.isFinite(s.medianIoiBeats)
        ? s.medianIoiBeats.toFixed(3)
        : '—';
      patternHud.notesPerSec = s.notesPerSecond.toFixed(2);
      patternHud.maxDensity = String(s.maxDensityWindow);
      patternHud.syncopation = s.meanSyncopationWeight.toFixed(3);
      patternHud.tripletAff = s.meanTripletAffinity.toFixed(3);
      patternHud.sustainedFrac = s.sustainedNoteFraction.toFixed(2);
      patternHud.burstFrac = s.burstWindowsFraction.toFixed(2);
    }
    pat.controllersRecursive().forEach(c => c.updateDisplay());
  }

  return { gui, setPatternFeatures };
}
