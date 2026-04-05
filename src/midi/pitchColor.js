import * as THREE from 'three';
import { params } from '../params.js';

const _c = new THREE.Color();

function pitchT(midi) {
  const { midiMin, midiMax } = params.pitch;
  const span = Math.max(1e-6, midiMax - midiMin);
  return Math.max(0, Math.min(1, (midi - midiMin) / span));
}

/**
 * Hue ∈ [0,1): one step per semitone (12 vivid families), with a small per-octave
 * offset so the same pitch class differs slightly across octaves.
 * @param {number} midi
 */
function pitchHue(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12);
  return ((pc / 12 + (oct % 7) * (1 / 84)) % 1 + 1) % 1;
}

/**
 * Map MIDI note (0–127) to a saturated hex: chromatic hue + range-based lightness.
 * @param {number} midi
 * @param {{ saturation?: number, lightness?: number }} [opts]
 * @returns {number} THREE-compatible hex (0xRRGGBB)
 */
function pitchToHex(midi, opts = {}) {
  const t = pitchT(midi);
  const h = pitchHue(midi);
  const s = opts.saturation ?? (0.78 + 0.12 * t);
  const l = opts.lightness ?? (0.44 + 0.2 * t);
  _c.setHSL(h, Math.min(1, Math.max(0.45, s)), Math.min(0.62, Math.max(0.32, l)));
  return _c.getHex();
}

/**
 * Wall pads: vivid, readable colors — adjacent semitones are clearly different hues.
 * @param {number} midi
 * @returns {number} THREE-compatible hex (0xRRGGBB)
 */
export function pitchToPlatformColor(midi) {
  return pitchToHex(midi, { saturation: 0.82, lightness: 0.46 + 0.16 * pitchT(midi) });
}

/**
 * Particle / burst tint — same hue family, slightly brighter than pads.
 */
export function pitchToBurstColor(midi) {
  return pitchToHex(midi, { saturation: 0.9, lightness: 0.52 + 0.14 * pitchT(midi) });
}

/** Emissive tint for sustained neon rails (matches pitch hue, pushed for glow) */
export function pitchToNeonRailEmissive(midi) {
  const h = pitchHue(midi);
  const t = pitchT(midi);
  _c.setHSL(h, Math.min(1, 0.72 + 0.2 * t), Math.min(0.58, 0.38 + 0.18 * t));
  return _c.getHex();
}
