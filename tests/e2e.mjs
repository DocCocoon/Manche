// Plays the app in headless Chromium with the microphone replaced by a sawtooth tone the test controls.
// Run with `npm test` (after `npm run test:setup` once to download the browser).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../www/', import.meta.url));
const SHOTS = process.env.SHOTS; // folder for screenshots, optional
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  try {
    const body = await readFile(join(ROOT, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': TYPES[extname(path || '.html')] ?? 'text/html' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    window.__fake = { ctx, osc, gain };
    return dest.stream;
  };
  window.__pluck = (midi) => {
    const { ctx, osc, gain } = window.__fake;
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(440 * 2 ** ((midi - 69) / 12), t);
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.3, t + 0.005);
  };
  window.__silence = () => {
    const { ctx, gain } = window.__fake;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(0, ctx.currentTime);
  };
});

let passed = 0;
let failed = 0;
function check(name, ok, info) {
  ok ? passed++ : failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || info === undefined ? '' : ` ${JSON.stringify(info)}`}`);
}
const wait = (ms) => page.waitForTimeout(ms);
const shot = (name, fullPage = false) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
const state = () => page.evaluate(() => ({
  phase: game.phase, target: game.target, previous: game.previous, score: game.score, tempo: game.tempo,
  last: game.last, choices: game.choices,
  string: document.getElementById('string').textContent,
  best: document.getElementById('best').textContent,
  bestLabel: document.getElementById('bestLabel').textContent,
  message: document.getElementById('message').textContent,
  counts: Object.fromEntries(Object.entries(tables).map(([k, t]) => [k, [t.high.length, t.recent.length]])),
  highRows: document.querySelectorAll('#highBody tr:not(.empty)').length,
  recentRows: document.querySelectorAll('#recentBody tr:not(.empty)').length,
}));
const pluck = (midi) => page.evaluate((m) => __pluck(m), midi);
const silence = () => page.evaluate(() => __silence());
// The MIDI note for a pitch class within frets 0-11 of the string whose open note is `open`.
const onString = (pc, open) => open + ((pc - (open % 12) + 12) % 12);
const A_STRING = 45;
// True once the A string fits more of the notes (frets 0-12) than any other string, stray one included.
const fitCount = (notes, open) => notes.filter((m) => m >= open && m <= open + 12).length;
const onlyAFitsBest = (notes) =>
  [40, 50, 55, 59, 64].every((open) => fitCount(notes, open) < fitCount(notes, A_STRING));

await page.goto(url);
await wait(300);
await shot('1-idle');
check('seven filter chips (All + six strings)', (await page.locator('#filter button').count()) === 7);

// 1. A game on the A string. One note comes in an octave too high, as a stray reading would;
//    the string must still come out as A. Played until the notes rule out the low E and D strings.
await page.click('#startBtn');
await wait(300);
const played = [];
for (let i = 0; i < 24; i++) {
  const s = await state();
  let midi = onString(s.target, A_STRING);
  if (i === 1) midi += 12;
  played.push(midi);
  await pluck(midi); // left ringing into the next note, which must be ignored
  await wait(400);
  if (i >= 3 && onlyAFitsBest(played)) break;
}
let s = await state();
check(`A-string game scores every note (${played.length})`, s.phase === 'playing' && s.score === played.length, s.score);
check('string readout shows A during the game', s.string === 'A', s.string);
await page.click('#startBtn'); // Stop
await silence();
s = await state();
check('stopped game is put on the A string', s.last.string === '5' && s.counts['5'][0] === 1 && s.counts['5'][1] === 1, s.counts);
check('message names the string', s.message.includes('Played on the A string.'), s.message);
check('new best is per string', s.message.includes('New best on A'), s.message);
await shot('2-over-a-string');

// 2. A one-note game that could be on the low E or the A string: the player is asked, and the answer files it.
await page.click('#startBtn');
await wait(300);
s = await state();
const wrongMidi = s.target === 9 ? 46 : 45; // A2 or A#2: both sit on the low E and the A string
await pluck(wrongMidi);
await wait(600);
await silence();
s = await state();
check('wrong note ends the game', s.phase === 'over' && s.last.reason === 'wrong', s.last);
check('ambiguous game asks low E or A', JSON.stringify(s.choices) === '["6","5"]' && s.string === 'E/A', { choices: s.choices, string: s.string });
check('ambiguous game waits in the no-string table', s.counts.none[1] === 1, s.counts);
await shot('3-ask-string');
await page.click('#message button[data-string="5"]');
s = await state();
check('picking A moves it to the A tables', s.counts.none[1] === 0 && s.counts['5'][1] === 2 && s.last.string === '5', s.counts);
check('message confirms the pick', s.message.includes('Played on the A string.') && !s.message.includes('Which string'), s.message);

// 3. Too slow with no notes at all: no string, no question, listed under All only.
await page.fill('#tempo', '60');
await page.dispatchEvent('#tempo', 'input');
await page.click('#restartBtn');
await wait(1300);
s = await state();
check('timeout ends the game', s.phase === 'over' && s.last.reason === 'slow', s.last);
check('no-note game has no string and no question', s.last.string === null && s.choices.length === 0 && s.counts.none[1] === 1, s);

// 4. Accelerate still speeds up.
await page.fill('#tempo', '15');
await page.dispatchEvent('#tempo', 'input');
await page.click('#accelBtn');
await page.click('#startBtn');
await wait(300);
for (let i = 0; i < 3; i++) {
  s = await state();
  await silence();
  await wait(60);
  await pluck(onString(s.target, 40));
  await wait(400);
}
s = await state();
check('accelerate: 8 bpm × 1.05³ after 3 notes', s.score === 3 && Math.abs(s.tempo - 8 * 1.05 ** 3) < 1e-9, s.tempo);
await page.click('#startBtn');
await silence();
await page.click('#accelBtn');

// 5. Filters.
s = await state();
const allRecent = s.recentRows;
check('All shows every game', allRecent === 4, allRecent);
check('three mode chips', (await page.locator('#modeFilter button').count()) === 3);
await page.click('#modeFilter button[data-mode="accelerate"]');
s = await state();
check('Accelerate mode shows only accelerate games', s.recentRows === 1 && s.highRows === 1 && s.best === '3', s);
check('Best names the mode', s.bestLabel === 'Best · accel', s.bestLabel);
await page.click('#modeFilter button[data-mode="regular"]');
s = await state();
check('Regular mode shows only regular games', s.recentRows === 3 && s.highRows === 1, s);
await page.click('#modeFilter button[data-mode="all"]');
await page.click('#filter button[data-filter="5"]');
s = await state();
check('A filter shows only A-string games', s.recentRows === 2 && s.highRows === 1, s);
check('Best follows the filter', s.bestLabel === 'Best · A', s.bestLabel);
check('String column hidden on a single string', !(await page.locator('#highBody td.col-string').first().isVisible()));
await shot('4-filter-a', true);
await page.click('#filter button[data-filter="1"]');
s = await state();
check('high e filter is empty', s.recentRows === 0 && s.highRows === 0 && s.best === '0', s);

// 6. Filter and tables survive a reload.
await page.reload();
await wait(300);
s = await state();
check('filter remembered after reload', s.bestLabel === 'Best · e', s.bestLabel);
await page.click('#filter button[data-filter="all"]');
s = await state();
check('tables kept after reload', s.recentRows === 4, s.recentRows);
await shot('5-all-phone', true);

// 7. Layout.
await page.setViewportSize({ width: 360, height: 780 });
await wait(200);
check('no sideways scroll at 360px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await shot('6-all-360', true);
await page.setViewportSize({ width: 1280, height: 900 });
await wait(200);
check('no sideways scroll at 1280px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await shot('7-desktop');

// 8. One-time move of every game saved so far, first-version scores included, to the high e string.
await page.evaluate(() => {
  localStorage.clear();
  const game = (score, at, string) => ({ score, at, accelerate: false, tempo: 15, reason: 'wrong', target: 'E', played: 'F', string, notes: [] });
  const old = game(7, Date.now() - 864e5);
  localStorage.setItem('manche.highScores', JSON.stringify([old]));
  localStorage.setItem('manche.recentGames', JSON.stringify([old]));
  const onA = game(4, Date.now() - 1000, '5');
  const unknown = game(2, Date.now() - 2000, null);
  localStorage.setItem('manche.tables', JSON.stringify({ '5': { high: [onA], recent: [onA] }, none: { high: [unknown], recent: [unknown] } }));
});
await page.reload();
await wait(300);
s = await state();
check('all saved games moved to high e', JSON.stringify(s.counts) === JSON.stringify({ 1: [3, 3], 2: [0, 0], 3: [0, 0], 4: [0, 0], 5: [0, 0], 6: [0, 0], none: [0, 0] }), s.counts);
check('moved games are marked high e', await page.evaluate(() => tables['1'].recent.every((g) => g.string === '1')));
check('old storage keys removed', await page.evaluate(() => localStorage.getItem('manche.highScores') === null));
await page.evaluate(() => {
  const t = JSON.parse(localStorage.getItem('manche.tables'));
  t['5'].recent.push({ score: 0, at: Date.now(), accelerate: false, tempo: 15, reason: 'slow', target: 'C', played: null, string: '5', notes: [] });
  localStorage.setItem('manche.tables', JSON.stringify(t));
});
await page.reload();
await wait(300);
s = await state();
check('the move only happens once', s.counts['5'][1] === 1 && s.counts['1'][1] === 3, s.counts);

check('no page errors', errors.length === 0, errors);
console.log(`${passed} passed, ${failed} failed`);
await browser.close();
server.close();
process.exitCode = failed ? 1 : 0;
