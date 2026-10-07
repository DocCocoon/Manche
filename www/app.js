// Manche: fretboard note trainer. Game rules, microphone input and screen updates.
'use strict';

const CONFIG = {
  // Speed slider range in bpm, one note per beat (60 bpm = 1 second per note).
  minTempo: 6,
  maxTempo: 60,
  defaultTempo: 15,
  // Accelerate mode: start slow, speed up after every correct note, stop at the top tempo.
  accelStartTempo: 8,
  accelGrowth: 1.05,
  accelTopTempo: 40, // fastest tempo; to be tuned
  // Note detection.
  minLevel: 0.01, // input quieter than this (RMS) is treated as silence
  acceptMs: 80, // the asked note must hold this long to count
  rejectMs: 160, // a wrong note must hold this long after its pluck to end the game
  onsetRatio: 1.5, // a jump in level this large counts as a new pluck
  // Notes are assumed to be played between the open string and this fret when working out the string.
  maxFret: 12,
  tableSize: 10,
};

// Standard tuning, numbered the guitarist's way: 1 is the high e, 6 the low E. open is a MIDI note number.
const STRINGS = [
  { id: '6', name: 'E', open: 40, label: 'low E' },
  { id: '5', name: 'A', open: 45, label: 'A' },
  { id: '4', name: 'D', open: 50, label: 'D' },
  { id: '3', name: 'G', open: 55, label: 'G' },
  { id: '2', name: 'B', open: 59, label: 'B' },
  { id: '1', name: 'e', open: 64, label: 'high e' },
];
const STRING_BY_ID = Object.fromEntries(STRINGS.map((s) => [s.id, s]));
const UNKNOWN = 'none'; // table key for games whose string could not be worked out
const MODES = [
  { id: 'all', name: 'All' },
  { id: 'regular', name: 'Regular' },
  { id: 'accelerate', name: 'Accelerate' },
];

const STORAGE = { tables: 'manche.tables', settings: 'manche.settings' };

const $ = (id) => document.getElementById(id);
const ui = {
  stage: $('stage'), ring: $('ring'), note: $('note'), message: $('message'),
  score: $('score'), best: $('best'), bestLabel: $('bestLabel'), string: $('string'),
  heard: $('heard'), cents: $('cents'), level: $('level'),
  startBtn: $('startBtn'), restartBtn: $('restartBtn'),
  tempo: $('tempo'), tempoValue: $('tempoValue'), accelBtn: $('accelBtn'), accelHint: $('accelHint'),
  scores: $('scores'), filter: $('filter'), modeFilter: $('modeFilter'), highBody: $('highBody'), recentBody: $('recentBody'),
};

// Storage can be missing or full (private browsing); the game works without it.
function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const settings = { tempo: CONFIG.defaultTempo, accelerate: false, filter: 'all', mode: 'all', ...load(STORAGE.settings, {}) };
settings.tempo = Math.min(CONFIG.maxTempo, Math.max(CONFIG.minTempo, Number(settings.tempo) || CONFIG.defaultTempo));
if (settings.filter !== 'all' && !STRING_BY_ID[settings.filter]) settings.filter = 'all';
if (!MODES.some((m) => m.id === settings.mode)) settings.mode = 'all';

// A high-score table and a recent-games table for each string, plus one pair for games with no known string.
const tables = loadTables();

function loadTables() {
  const stored = load(STORAGE.tables, {});
  const result = {};
  for (const key of [...STRINGS.map((s) => s.id), UNKNOWN]) {
    result[key] = { high: stored[key]?.high ?? [], recent: stored[key]?.recent ?? [] };
  }
  // Games saved before strings were tracked go to the no-string tables.
  const oldHigh = load('manche.highScores', null);
  const oldRecent = load('manche.recentGames', null);
  if (oldHigh || oldRecent) {
    result[UNKNOWN].high.push(...(oldHigh ?? []));
    result[UNKNOWN].recent.push(...(oldRecent ?? []));
    save(STORAGE.tables, result);
    try {
      localStorage.removeItem('manche.highScores');
      localStorage.removeItem('manche.recentGames');
    } catch {}
  }
  // One-time move: every game saved so far was played on the high e string.
  if (!load('manche.movedToHighE', false)) {
    const games = Object.values(result);
    const high = games.flatMap((t) => t.high).sort((a, b) => b.score - a.score || a.at - b.at);
    const recent = games.flatMap((t) => t.recent).sort((a, b) => b.at - a.at);
    for (const game of [...high, ...recent]) game.string = '1';
    for (const t of games) {
      t.high = [];
      t.recent = [];
    }
    result['1'] = { high: high.slice(0, CONFIG.tableSize), recent: recent.slice(0, CONFIG.tableSize) };
    save(STORAGE.tables, result);
    save('manche.movedToHighE', true);
  }
  return result;
}

const byScore = (a, b) => b.score - a.score || a.at - b.at;
const byNewest = (a, b) => b.at - a.at;

const modeOf = (r) => (r.accelerate ? 'accelerate' : 'regular');

// The rows a table shows for a string filter and a mode: 'all' merges every string's table, or both modes.
function view(kind, filter = settings.filter, mode = settings.mode) {
  const keys = filter === 'all' ? Object.keys(tables) : [filter];
  return keys
    .flatMap((key) => tables[key][kind])
    .filter((r) => mode === 'all' || modeOf(r) === mode)
    .sort(kind === 'high' ? byScore : byNewest)
    .slice(0, CONFIG.tableSize);
}

function bestScore(filter = settings.filter, mode = settings.mode) {
  return view('high', filter, mode)[0]?.score ?? 0;
}

// Keeps the first tableSize games of each mode, so filtering by mode still fills a table.
function keepPerMode(list) {
  const counts = { regular: 0, accelerate: 0 };
  return list.filter((r) => ++counts[modeOf(r)] <= CONFIG.tableSize);
}

function addToTables(result) {
  const table = tables[result.string ?? UNKNOWN];
  table.recent = keepPerMode([result, ...table.recent]);
  if (result.score > 0) table.high = keepPerMode([...table.high, result].sort(byScore));
  save(STORAGE.tables, tables);
}

// Strings whose frets 0 to maxFret hold the most of the notes played. Taking the best fit rather than
// requiring every note means one stray octave reading doesn't change the answer.
function possibleStrings(notes) {
  if (!notes.length) return [];
  const fits = STRINGS.map((s) => ({
    id: s.id,
    count: notes.filter((midi) => midi >= s.open && midi <= s.open + CONFIG.maxFret).length,
  }));
  const most = Math.max(...fits.map((f) => f.count));
  return most ? fits.filter((f) => f.count === most).map((f) => f.id) : [];
}

const game = {
  phase: 'idle', // 'idle' | 'playing' | 'over'
  score: 0,
  tempo: settings.tempo, // bpm for the current note
  target: null, // pitch class 0-11, 0 = C
  previous: null,
  shownAt: 0,
  notes: [], // MIDI note of every note judged this game, for working out the string
  candidate: null, // pitch class currently heard
  candidateSince: 0,
  candidateMidis: [], // MIDI readings while the candidate holds; the most common one is kept
  lastHeardAt: 0,
  lastOnsetAt: -Infinity,
  last: null, // the most recent finished game
  choices: [], // strings to pick from when the last game's string is ambiguous
  newBest: false,
  micError: '',
};

const audio = { ctx: null, stream: null, analyser: null, buf: null, scratch: null, baseline: 0, rising: false };

// ---------- Microphone ----------

async function openMic() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('insecure context'), { name: 'InsecureContext' });
  }
  audio.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  const resuming = audio.ctx.resume(); // iOS only allows this during the tap
  if (!audio.stream) {
    audio.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const { ctx } = audio;
    const source = ctx.createMediaStreamSource(audio.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2 ** Math.ceil(Math.log2(Pitch.samplesNeeded(ctx.sampleRate)));
    // Some browsers only process nodes that reach the speakers; a muted gain keeps it silent.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(analyser);
    analyser.connect(mute);
    mute.connect(ctx.destination);
    Object.assign(audio, {
      analyser,
      buf: new Float32Array(analyser.fftSize),
      scratch: Pitch.makeScratch(ctx.sampleRate),
    });
    requestAnimationFrame(tick);
  }
  await resuming;
}

function micErrorText(err) {
  switch (err.name) {
    case 'InsecureContext':
      return 'The microphone only works over HTTPS or on localhost. Open the app from a secure address.';
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access is blocked. Allow it for this page in your browser settings, then press Start.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Connect one, then press Start.';
    case 'NotReadableError':
      return 'Another app is using the microphone. Close it, then press Start.';
    default:
      return `The microphone could not start (${err.message || err.name}).`;
  }
}

// Reads the mic, detects the note and updates the tuner readout. Returns the note heard, or null.
function listen(now) {
  const { analyser, buf, ctx } = audio;
  analyser.getFloatTimeDomainData(buf);
  const level = Pitch.rms(buf, buf.length - 1024);

  // A sudden rise in level marks a new pluck.
  const rising = level > CONFIG.minLevel && level > audio.baseline * CONFIG.onsetRatio;
  if (rising && !audio.rising) game.lastOnsetAt = now;
  audio.rising = rising;
  audio.baseline += (level - audio.baseline) * 0.1;

  const freq = level > CONFIG.minLevel ? Pitch.detect(buf, ctx.sampleRate, audio.scratch) : null;
  const heard = freq ? Pitch.noteFromFreq(freq) : null;
  showHeard(heard, level);
  return heard;
}

function showHeard(heard, level) {
  const db = 20 * Math.log10(level + 1e-9);
  const meter = Math.min(1, Math.max(0, (db + 60) / 50));
  ui.level.style.transform = `scaleX(${meter.toFixed(3)})`;

  const name = heard ? `${heard.name}${heard.octave}` : '–';
  const cents = heard ? `${heard.cents > 0 ? '+' : heard.cents < 0 ? '−' : '±'}${Math.abs(heard.cents)}¢` : '';
  if (ui.heard.textContent !== name) ui.heard.textContent = name;
  if (ui.cents.textContent !== cents) ui.cents.textContent = cents;
  ui.heard.classList.remove('is-off');
}

// ---------- Game ----------

function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const heard = listen(now);
  if (game.phase !== 'playing') return;
  judge(heard, now);
  if (game.phase === 'playing') updateTimer(now);
}

function judge(heard, now) {
  if (!heard) {
    // Short dropouts happen inside a ringing note; only a longer gap forgets it.
    if (now - game.lastHeardAt > 100) game.candidate = null;
    return;
  }
  game.lastHeardAt = now;
  if (heard.pc !== game.candidate) {
    game.candidate = heard.pc;
    game.candidateSince = now;
    game.candidateMidis = [heard.midi];
    return;
  }
  game.candidateMidis.push(heard.midi);
  if (heard.pc === game.target) {
    if (now - game.candidateSince >= CONFIG.acceptMs) hit();
    return;
  }
  // A wrong note only counts if it was plucked after this note appeared and holds after the pluck.
  // The previous note is ignored because it is usually still ringing.
  const pluckedSinceShown = game.lastOnsetAt > game.shownAt;
  const heldSincePluck = now - Math.max(game.candidateSince, game.lastOnsetAt);
  if (heard.pc !== game.previous && pluckedSinceShown && heldSincePluck >= CONFIG.rejectMs) {
    game.notes.push(mostCommon(game.candidateMidis));
    endGame('wrong', heard.pc);
  }
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

function updateTimer(now) {
  const left = 1 - (now - game.shownAt) / ((60 / game.tempo) * 1000);
  if (left <= 0) {
    endGame('slow');
    return;
  }
  ui.ring.style.setProperty('--left', left.toFixed(4));
  ui.ring.classList.toggle('low', left < 0.25);
}

async function startGame() {
  ui.startBtn.disabled = true;
  ui.restartBtn.disabled = true;
  try {
    await openMic();
    game.micError = '';
  } catch (err) {
    game.micError = micErrorText(err);
    render();
    return;
  }
  Object.assign(game, {
    phase: 'playing',
    score: 0,
    tempo: settings.accelerate ? CONFIG.accelStartTempo : settings.tempo,
    target: null,
    notes: [],
    candidate: null,
    last: null,
    choices: [],
    newBest: false,
  });
  keepAwake(true);
  nextNote();
}

function nextNote() {
  game.previous = game.target;
  let next;
  do next = Math.floor(Math.random() * 12);
  while (next === game.previous);
  game.target = next;
  game.shownAt = performance.now();
  game.candidate = null;
  ui.ring.style.setProperty('--left', 1);
  ui.ring.classList.remove('low');
  render();
}

function hit() {
  game.score += 1;
  game.notes.push(mostCommon(game.candidateMidis));
  if (settings.accelerate) {
    game.tempo = Math.min(CONFIG.accelTopTempo, game.tempo * CONFIG.accelGrowth);
  }
  pulse(ui.ring, 'hit');
  pulse(ui.score, 'bump');
  nextNote();
}

// reason: 'wrong' | 'slow' | 'stopped' | 'restarted'
function endGame(reason, playedPc = null) {
  const strings = possibleStrings(game.notes);
  const result = {
    score: game.score,
    at: Date.now(),
    accelerate: settings.accelerate,
    tempo: Math.round(game.tempo),
    reason,
    target: Pitch.NOTE_NAMES[game.target],
    played: playedPc === null ? null : Pitch.NOTE_NAMES[playedPc],
    string: strings.length === 1 ? strings[0] : null,
    notes: game.notes,
  };
  game.newBest = isNewBest(result);
  addToTables(result);

  Object.assign(game, {
    phase: 'over',
    last: result,
    choices: strings.length > 1 ? strings : [],
    score: 0,
    tempo: settings.tempo,
  });
  keepAwake(false);
  render();
}

// Compared with the game's own string, or with every game when the string is unknown.
function isNewBest(result) {
  return result.score > 0 && result.score > bestScore(result.string ?? 'all', 'all');
}

// The player says which string an ambiguous game was on: move it from the no-string tables to that string's.
function assignString(id) {
  const result = game.last;
  const unknown = tables[UNKNOWN];
  unknown.high = unknown.high.filter((r) => r.at !== result.at);
  unknown.recent = unknown.recent.filter((r) => r.at !== result.at);
  result.string = id;
  game.choices = [];
  game.newBest = isNewBest(result);
  addToTables(result);
  render();
}

// Keeps the phone screen on during a game, where supported.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch {}
}

// ---------- Rendering ----------

function render() {
  const { phase, last } = game;
  ui.stage.dataset.phase = phase;
  ui.stage.dataset.result = phase === 'over' ? last.reason : '';
  ui.score.textContent = game.score;
  renderBest();
  renderStringStat();

  setNote(phase === 'playing' ? Pitch.NOTE_NAMES[game.target] : phase === 'over' ? last.target : '?');
  if (phase !== 'playing') {
    ui.ring.style.setProperty('--left', 1);
    ui.ring.classList.remove('low');
  }
  renderMessage();

  ui.startBtn.disabled = false;
  ui.startBtn.textContent = phase === 'playing' ? 'Stop' : 'Start';
  ui.startBtn.classList.toggle('is-stop', phase === 'playing');
  ui.restartBtn.disabled = phase === 'idle';

  renderSpeed();
  renderTables();
}

function renderBest() {
  const { filter, mode } = settings;
  ui.best.textContent = bestScore();
  const parts = ['Best'];
  if (filter !== 'all') parts.push(STRING_BY_ID[filter].name);
  if (mode !== 'all') parts.push(mode === 'accelerate' ? 'accel' : 'regular');
  ui.bestLabel.textContent = parts.join(' · ');
}

// The string being played: worked out live during a game, or the last game's result.
function renderStringStat() {
  let ids = [];
  if (game.phase === 'playing') ids = possibleStrings(game.notes);
  else if (game.phase === 'over') ids = game.last.string ? [game.last.string] : game.choices;
  ui.string.textContent = ids.length ? ids.map((id) => STRING_BY_ID[id].name).join('/') : '–';
  ui.string.classList.toggle('is-multi', ids.length > 1);
}

function setNote(name) {
  ui.note.replaceChildren(name[0]);
  if (name[1] === '#') ui.note.append(el('span', '#', 'sharp'));
}

function renderMessage() {
  const { phase, last } = game;
  let parts;
  if (game.micError && phase !== 'playing') {
    parts = [el('span', game.micError, 'error')];
  } else if (phase === 'idle') {
    parts = ['Pick one string and press Start. Play each note on that string before the ring closes.'];
  } else if (phase === 'playing') {
    const pace = `${(60 / game.tempo).toFixed(1)} s per note${settings.accelerate ? ', getting faster' : ''}.`;
    parts = [`${pace} Stay on one string.`];
  } else {
    if (last.reason === 'wrong') parts = ['You played ', el('strong', last.played), '. The note was ', el('strong', last.target), '.'];
    else if (last.reason === 'slow') parts = ['Time ran out on ', el('strong', last.target), '.'];
    else parts = ['Game stopped.'];

    const final = el('span', `Score ${last.score}`, 'final');
    if (game.newBest) {
      const chip = last.string ? `New best on ${STRING_BY_ID[last.string].label}` : 'New high score';
      final.append(el('span', chip, 'chip'));
    }
    parts.push(final);

    if (game.choices.length) {
      const ask = el('span', 'Which string did you play? ', 'string-line');
      for (const id of game.choices) {
        const button = el('button', stringTag(id), 'pick');
        button.type = 'button';
        button.dataset.string = id;
        button.setAttribute('aria-label', `${STRING_BY_ID[id].label} string`);
        ask.append(button);
      }
      parts.push(ask);
    } else if (last.string) {
      parts.push(el('span', `Played on the ${STRING_BY_ID[last.string].label} string.`, 'string-line'));
    }
  }
  ui.message.replaceChildren(...parts);
}

function renderSpeed() {
  const accel = settings.accelerate;
  const tempo = accel ? (game.phase === 'playing' ? game.tempo : CONFIG.accelStartTempo) : settings.tempo;
  const fill = ((tempo - CONFIG.minTempo) / (CONFIG.maxTempo - CONFIG.minTempo)) * 100;
  ui.tempo.value = Math.round(tempo);
  ui.tempo.disabled = accel;
  ui.tempo.style.setProperty('--fill', `${fill}%`);
  ui.tempoValue.textContent = `${Math.round(tempo)} bpm · ${(60 / tempo).toFixed(1)} s per note`;

  ui.accelBtn.setAttribute('aria-pressed', String(accel));
  ui.accelBtn.disabled = game.phase === 'playing';
  const growth = Math.round((CONFIG.accelGrowth - 1) * 100);
  ui.accelHint.textContent = accel
    ? `Starts at ${CONFIG.accelStartTempo} bpm and speeds up ${growth}% with each correct note, up to ${CONFIG.accelTopTempo} bpm.`
    : 'Off: the speed stays where you set it. You can change it during a game.';
}

function renderTables() {
  ui.scores.dataset.filter = settings.filter;
  for (const chip of ui.filter.children) {
    chip.setAttribute('aria-pressed', String(chip.dataset.filter === settings.filter));
  }
  for (const chip of ui.modeFilter.children) {
    chip.setAttribute('aria-pressed', String(chip.dataset.mode === settings.mode));
  }
  const modeFor = settings.mode === 'all' ? '' : ` in ${settings.mode} mode`;
  const emptyFor = (settings.filter === 'all' ? '' : ` on the ${STRING_BY_ID[settings.filter].label} string`) + modeFor;
  fillRows(ui.highBody, view('high'), `No scores yet${emptyFor}. The ten best games will show here.`, (r, i) => [
    el('td', String(i + 1), 'num rank'),
    el('td', String(r.score), 'num score'),
    stringCell(r),
    speedCell(r),
    el('td', formatDate(r.at)),
  ]);
  fillRows(ui.recentBody, view('recent'), `No games yet${emptyFor}. The last ten games will show here.`, (r) => [
    el('td', String(r.score), 'num score'),
    stringCell(r),
    el('td', endingText(r), 'ending'),
    speedCell(r),
    el('td', formatWhen(r.at)),
  ]);
}

function fillRows(body, rows, emptyText, cells) {
  if (!rows.length) {
    const td = el('td', emptyText);
    td.colSpan = 5;
    body.replaceChildren(el('tr', td, 'empty'));
    return;
  }
  body.replaceChildren(...rows.map((r, i) => {
    const tr = el('tr', null, r.at === game.last?.at ? 'latest' : '');
    tr.append(...cells(r, i));
    return tr;
  }));
}

function stringTag(id) {
  const tag = el('span', el('small', id), 'string-tag');
  tag.append(STRING_BY_ID[id].name);
  return tag;
}

function stringCell(r) {
  const td = el('td', r.string ? stringTag(r.string) : '–', 'col-string');
  if (r.string) td.title = `${STRING_BY_ID[r.string].label} string`;
  return td;
}

function speedCell(r) {
  const td = el('td', `${r.tempo}\u00a0bpm`, 'col-speed');
  if (r.accelerate) td.append(el('span', 'accel', 'pill'));
  return td;
}

function endingText(r) {
  if (r.reason === 'wrong') return `Played ${r.played}, not ${r.target}`;
  if (r.reason === 'slow') return `Too slow on ${r.target}`;
  if (r.reason === 'restarted') return 'Restarted';
  return 'Stopped';
}

// The year only shows for games from an earlier year.
function formatDate(at) {
  const date = new Date(at);
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year });
}

function formatWhen(at) {
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function el(tag, content, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) node.append(content);
  return node;
}

// Restarts a CSS animation on node.
function pulse(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

// ---------- Controls ----------

ui.tempo.min = CONFIG.minTempo;
ui.tempo.max = CONFIG.maxTempo;
ui.tempo.step = 1;

ui.filter.append(
  el('button', 'All', 'filter-chip'),
  ...STRINGS.map((s) => el('button', stringTag(s.id), 'filter-chip')),
);
[...ui.filter.children].forEach((chip, i) => {
  chip.type = 'button';
  chip.dataset.filter = i === 0 ? 'all' : STRINGS[i - 1].id;
  if (i > 0) chip.setAttribute('aria-label', `${STRINGS[i - 1].label} string`);
});

ui.filter.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-filter]');
  if (!chip) return;
  settings.filter = chip.dataset.filter;
  save(STORAGE.settings, settings);
  renderBest();
  renderTables();
});

ui.modeFilter.append(...MODES.map((m) => {
  const chip = el('button', m.name, 'filter-chip');
  chip.type = 'button';
  chip.dataset.mode = m.id;
  return chip;
}));

ui.modeFilter.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-mode]');
  if (!chip) return;
  settings.mode = chip.dataset.mode;
  save(STORAGE.settings, settings);
  renderBest();
  renderTables();
});

ui.message.addEventListener('click', (event) => {
  const pick = event.target.closest('[data-string]');
  if (pick && game.phase === 'over') assignString(pick.dataset.string);
});

ui.startBtn.addEventListener('click', () => {
  if (game.phase === 'playing') endGame('stopped');
  else startGame();
});

ui.restartBtn.addEventListener('click', () => {
  if (game.phase === 'playing') endGame('restarted');
  startGame();
});

ui.tempo.addEventListener('input', () => {
  settings.tempo = Number(ui.tempo.value);
  if (game.phase === 'playing' && !settings.accelerate) game.tempo = settings.tempo;
  save(STORAGE.settings, settings);
  renderSpeed();
  if (game.phase === 'playing') renderMessage();
});

ui.accelBtn.addEventListener('click', () => {
  settings.accelerate = !settings.accelerate;
  save(STORAGE.settings, settings);
  renderSpeed();
});

// Leaving the app mid-game stops it, rather than letting the timer run out unseen.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.phase === 'playing') endGame('stopped');
});

render();
