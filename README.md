# Manche

Fretboard note trainer. The app shows a note, you play it on one string of the guitar, and the microphone checks it.

## Run on your computer

```sh
npm start
```

Open http://localhost:8766 and allow the microphone. Browsers only give a page the mic on `localhost` or over HTTPS, so opening `index.html` directly as a file may not work.

## How the string is worked out

Each game is played on a single string. The app hears the exact note, octave included, and assumes it is played between the open string and the 12th fret (`CONFIG.maxFret` in `www/app.js`). The string that fits the most notes of the game is the one recorded, so a single stray reading does not change it.

Neighbouring strings share notes (A2 is the open A string and also the 5th fret of the low E), so a game that only hits shared notes can't be told apart. The game-over panel then asks which string was played, offering only the possible ones. Unanswered games, and games where no note was played, are kept apart and show only under All.

Scores are kept per string: one high-score table and one recent-games table for each of the six strings, merged when the filter is set to All.

## Try it on an iPhone

Safari only allows the mic over HTTPS. Put the `www` folder on any static HTTPS host (GitHub Pages, or drag the folder onto Netlify Drop), open it in Safari, then use Share → Add to Home Screen.

## Tuning

All speeds and detection thresholds are in `CONFIG` at the top of `www/app.js`. For example, `accelTopTempo` is the fastest tempo Accelerate mode reaches.

## Tests

```sh
npm install
npm run test:setup   # once: downloads a headless Chromium into node_modules
npm test
```

`tests/pitch.test.js` checks note detection, octave included, on synthetic plucked strings. `tests/e2e.mjs` plays whole games in the browser with the microphone replaced by a tone the test controls. Set `SHOTS=tests/screenshots` to save screenshots.

## Turning it into an iOS app (Capacitor)

This needs Xcode. From the project folder:

```sh
npm install @capacitor/core @capacitor/ios
npm install -D @capacitor/cli
npx cap init Manche com.yourname.manche --web-dir=www
npx cap add ios
```

Add the microphone permission text to `ios/App/App/Info.plist`:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Manche listens to your guitar to check the notes you play.</string>
```

Then run `npx cap open ios` and run it on your iPhone from Xcode. Scores are kept in `localStorage`, which iOS can clear when the phone is low on space; to make them permanent, switch `load` and `save` in `app.js` to `@capacitor/preferences`.

## Files

- `www/index.html`, `www/style.css`: layout and look
- `www/app.js`: game rules, microphone input, string detection, scores
- `www/pitch.js`: note detection (YIN algorithm), no dependencies
- `tests/`: pitch and browser tests
