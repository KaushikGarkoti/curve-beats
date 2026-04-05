import fs from 'fs';
const j = JSON.parse(fs.readFileSync('src/midis/midi.json', 'utf8'));
const notes = j.tracks[1].notes
  .map((x) => ({ t: x.time, d: x.duration, m: x.midi }))
  .sort((a, b) => a.t - b.t || a.m - b.m);

const bounceTh = 0.7;
const sustainMin = 1.5;

let rolls = 0;
let bounces = 0;
let sustained = 0;
for (let i = 0; i < notes.length; i++) {
  if (notes[i].d > sustainMin) sustained++;
}
for (let i = 0; i < notes.length; i++) {
  const gap = i === 0 ? notes[0].t : notes[i].t - notes[i - 1].t;
  if (gap >= bounceTh) rolls++;
  else bounces++;
}

const b = { tiny: 0, short: 0, med: 0, long: 0 };
for (let i = 1; i < notes.length; i++) {
  const g = notes[i].t - notes[i - 1].t;
  if (g < 0.01) b.tiny++;
  else if (g < 0.2) b.short++;
  else if (g < bounceTh) b.med++;
  else b.long++;
}

let dupPairs = 0;
for (let i = 1; i < notes.length; i++) {
  if (Math.abs(notes[i].t - notes[i - 1].t) < 1e-6) dupPairs++;
}

console.log(JSON.stringify({
  fileDuration: j.duration,
  headerBpm: j.header?.bpm,
  tempoChanges: j.tempo?.length,
  endTempo: j.tempo?.[j.tempo.length - 1],
  busiestTrackNotes: notes.length,
  secondTrackNotes: j.tracks[2]?.notes?.length ?? 0,
  rollLandings_gapGte: bounceTh,
  rollLandings: rolls,
  bounceLandings: bounces,
  notesDurationGt_sustainMin: sustained,
  gapBuckets: b,
  consecutiveSameOnsetPairs: dupPairs,
}, null, 2));
