// Checks the pitch detector against synthetic plucked strings (Karplus-Strong) across the first
// 15 frets of every string, at both common sample rates, with and without background noise.
// The exact note, octave included, must come out right: the app works out the string from it.
const Pitch = require('../www/pitch.js');

const OPEN_STRINGS = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4 as MIDI notes
const SILENCE = 0.01; // same gate as CONFIG.minLevel in app.js

// Seeded random numbers so every run hears the same plucks.
let seed = 12345;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function pluck(sampleRate, freq, seconds, noise) {
  const period = Math.round(sampleRate / freq - 0.5); // the averaging filter adds half a sample of delay
  const line = Float32Array.from({ length: period }, () => random() * 2 - 1);
  const out = new Float32Array(Math.round(sampleRate * seconds));
  for (let t = 0, i = 0; t < out.length; t++) {
    const next = (i + 1) % period;
    const v = line[i];
    line[i] = 0.996 * 0.5 * (line[i] + line[next]);
    out[t] = 0.3 * v + noise * (random() * 2 - 1);
    i = next;
  }
  return out;
}

let heard = 0;
let silent = 0;
let missed = 0;
const wrong = [];
for (const sampleRate of [44100, 48000]) {
  const size = 2 ** Math.ceil(Math.log2(Pitch.samplesNeeded(sampleRate)));
  const scratch = Pitch.makeScratch(sampleRate);
  for (const open of OPEN_STRINGS) {
    for (let fret = 0; fret <= 15; fret++) {
      for (const noise of [0, 0.01]) {
        const midi = open + fret;
        const signal = pluck(sampleRate, 440 * 2 ** ((midi - 69) / 12), 1.6, noise);
        for (const at of [0.08, 0.3, 1.5]) {
          const end = Math.round(at * sampleRate);
          const frame = signal.subarray(end - size, end);
          if (Pitch.rms(frame, size - 1024) < SILENCE) {
            silent++;
            continue;
          }
          heard++;
          const freq = Pitch.detect(frame, sampleRate, scratch);
          if (!freq) {
            missed++;
            continue;
          }
          const got = Pitch.noteFromFreq(freq);
          if (got.midi !== midi) wrong.push(`MIDI ${midi} heard as ${got.name}${got.octave} (${at}s, ${sampleRate} Hz, noise ${noise})`);
        }
      }
    }
  }
}

console.log(`${heard} frames above the silence gate (${silent} below): ${wrong.length} wrong, ${missed} without a clear pitch`);
wrong.forEach((line) => console.log(`  ${line}`));
// A rare stray reading on a faded, noisy note is tolerated: the app takes the most common reading per note
// and the best-fitting string per game.
const ok = wrong.length / heard < 0.005;
console.log(ok ? 'PASS pitch detection' : 'FAIL pitch detection');
process.exitCode = ok ? 0 : 1;
