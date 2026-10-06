// Pitch detection for single guitar notes, using the YIN algorithm
// (de Cheveigné & Kawahara, 2002). A plain script so it also loads in Node for testing.
(function (root) {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // Guitar range with some margin: drop-D low D (73 Hz) up to the 24th fret of the high E (1319 Hz).
  const MIN_FREQ = 70;
  const MAX_FREQ = 1400;
  const WINDOW = 1024; // samples compared at each lag
  const THRESHOLD = 0.15; // YIN dip threshold; lower is stricter

  function maxLag(sampleRate) {
    return Math.ceil(sampleRate / MIN_FREQ) + 1;
  }

  // How many of the newest samples detect() reads.
  function samplesNeeded(sampleRate) {
    return WINDOW + maxLag(sampleRate);
  }

  // Reusable working memory for detect(), so the audio loop does not allocate.
  function makeScratch(sampleRate) {
    return new Float32Array(maxLag(sampleRate) + 1);
  }

  // Root mean square level of buf from index start to the end.
  function rms(buf, start = 0) {
    let sum = 0;
    for (let i = start; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / (buf.length - start));
  }

  // Fundamental frequency in Hz of the newest samples in buf, or null when there is no clear pitch.
  function detect(buf, sampleRate, scratch = makeScratch(sampleRate)) {
    const lagMax = maxLag(sampleRate);
    const lagMin = Math.floor(sampleRate / MAX_FREQ);
    const start = buf.length - WINDOW - lagMax;
    if (start < 0) throw new Error(`Pitch.detect needs ${samplesNeeded(sampleRate)} samples`);
    const d = scratch;

    // Difference function: how unlike the signal is to itself shifted by each lag.
    for (let lag = 1; lag <= lagMax; lag++) {
      let sum = 0;
      for (let i = start; i < start + WINDOW; i++) {
        const delta = buf[i] - buf[i + lag];
        sum += delta * delta;
      }
      d[lag] = sum;
    }

    // Cumulative mean normalisation, so dips compare against an absolute threshold.
    d[0] = 1;
    let running = 0;
    for (let lag = 1; lag <= lagMax; lag++) {
      running += d[lag];
      d[lag] = running > 0 ? (d[lag] * lag) / running : 1;
    }

    // The first dip under the threshold, followed down to its lowest point.
    let lag = lagMin;
    while (lag < lagMax && d[lag] >= THRESHOLD) lag++;
    if (lag >= lagMax) return null;
    while (lag + 1 < lagMax && d[lag + 1] < d[lag]) lag++;

    // Parabolic interpolation for a period between whole samples.
    const a = d[lag - 1];
    const b = d[lag];
    const c = d[lag + 1];
    const curve = a - 2 * b + c;
    const offset = curve > 0 ? (a - c) / (2 * curve) : 0;
    return sampleRate / (lag + offset);
  }

  // Nearest equal-tempered note (A4 = 440 Hz). midi is the MIDI note number, pc the pitch class (0 = C).
  function noteFromFreq(freq) {
    const midi = 69 + 12 * Math.log2(freq / 440);
    const nearest = Math.round(midi);
    const pc = ((nearest % 12) + 12) % 12;
    return {
      midi: nearest,
      pc,
      name: NOTE_NAMES[pc],
      octave: Math.floor(nearest / 12) - 1,
      cents: Math.round((midi - nearest) * 100),
    };
  }

  const Pitch = { NOTE_NAMES, detect, rms, samplesNeeded, makeScratch, noteFromFreq };
  root.Pitch = Pitch;
  if (typeof module === 'object' && module.exports) module.exports = Pitch;
})(typeof window !== 'undefined' ? window : globalThis);
