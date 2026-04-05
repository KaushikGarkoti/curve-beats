import { params } from '../params.js';

function pitchT(midi) {
  const { midiMin, midiMax } = params.pitch;
  const span = Math.max(1e-6, midiMax - midiMin);
  return Math.max(0, Math.min(1, (midi - midiMin) / span));
}

/**
 * Map MIDI note (0–127) to a hex color: low → cool blue, high → neon pink.
 * @param {number} midi
 * @returns {number} THREE-compatible hex (0xRRGGBB)
 */
export function pitchToPlatformColor(midi) {
  const t = pitchT(midi);
  const r = Math.round(0x22 + (0xff - 0x22) * t);
  const g = Math.round(0x88 + (0x44 - 0x88) * t);
  const b = Math.round(0xff + (0xcc - 0xff) * t);
  return (r << 16) | (g << 8) | b;
}

/**
 * Particle / burst tint (slightly brighter than wall platforms).
 */
export function pitchToBurstColor(midi) {
  const t = pitchT(midi);
  const r = Math.round(0x55 + (0xff - 0x55) * t);
  const g = Math.round(0xaa + (0x66 - 0xaa) * t);
  const b = Math.round(0xff + (0xee - 0xff) * t);
  return (r << 16) | (g << 8) | b;
}

/** Emissive tint for sustained neon rails (magenta → cyan shift by pitch) */
export function pitchToNeonRailEmissive(midi) {
  const t = pitchT(midi);
  const r = Math.round(0xcc + (0x44 - 0xcc) * t);
  const g = Math.round(0x00 + (0xff - 0x00) * t);
  const b = Math.round(0xff + (0x88 - 0xff) * t);
  return (r << 16) | (g << 8) | b;
}
