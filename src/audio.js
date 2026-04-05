/**
 * AUDIO SYSTEM (legacy — unused; playback is in audioSampler.js + Tone.Transport)
 * ------------
 * Synthesizes beat sounds using the Web Audio API.
 * No external audio files needed.
 * Each beat plays a short percussive click/thud.
 */

let ctx = null;

function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

/**
 * Play a short percussive hit.
 * Alternates between low and high pitched sounds based on beat index.
 * @param {number} beatIndex
 */
export function playBeat(beatIndex) {
  const ac = getCtx();
  if (ac.state === 'suspended') ac.resume();

  const now = ac.currentTime;

  // --- Oscillator for tonal component ---
  const osc = ac.createOscillator();
  const oscGain = ac.createGain();

  // Alternate: every 4th beat is a kick, otherwise hi-hat-ish
  const isKick = beatIndex % 4 === 0;
  const isAccent = beatIndex % 2 === 0;

  if (isKick) {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.15);
    oscGain.gain.setValueAtTime(0.9, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
  } else {
    osc.type = 'square';
    osc.frequency.setValueAtTime(isAccent ? 880 : 660, now);
    oscGain.gain.setValueAtTime(0.2, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
  }

  osc.connect(oscGain);
  oscGain.connect(ac.destination);
  osc.start(now);
  osc.stop(now + 0.3);

  // --- Noise burst for transient crunch ---
  if (!isKick) {
    const bufferSize = ac.sampleRate * 0.05;
    const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = ac.createBufferSource();
    noise.buffer = buffer;

    const noiseGain = ac.createGain();
    noiseGain.gain.setValueAtTime(0.15, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    noise.connect(noiseGain);
    noiseGain.connect(ac.destination);
    noise.start(now);
  }
}
