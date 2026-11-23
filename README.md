# Egg Mama

A landscape, full-screen, touch-first platformer for phones. Egg Mama rolls through **one continuous world** that
slowly slides by in front of thirteen pixel-art paintings, from the Meadow to the Summit Beacon. One trip takes about
**an hour**, the difficulty creeps up very gradually, and the player is always moving: you jump, brake and push to
find your line rather than start and stop. When she reaches the beacon the world turns back into a fresh Meadow and
you can keep going for ever.

Everything you touch is smooth vector art drawn in code on top of the crisp pixel backgrounds. The music is original
and synthesised in the browser. There are no downloads, no network calls after the page loads, and no dependencies.

## Play

Hold the phone sideways. The world fills the screen; there is no title bar, score header or button footer.

| Gesture | What happens |
| --- | --- |
| Swipe up | Jump |
| Swipe right | Push ahead (a short burst of speed) |
| Swipe left | Brake and back up for a moment |
| Tap (optional, in Settings) | Jump, for the smallest players |
| Pause button (top right) | Pause menu: Resume, Journal, How to play, Main title |

Keyboard (for testing on a laptop): Space/Up/W jump, A/D or the arrow keys steer while held, P/Esc pause, M mute.

- **Ordinary eggs** score points and mark a safe route. **Golden eggs** hatch a duckling that follows Mama (up to five).
- A **shield** absorbs the first hit, then a duckling is lost instead of a life, and with no flock the run ends.
- **Checkpoint flags** save automatically. After a fall you return to the last flag.
- **Continue** resumes the last flag; **Retry checkpoint** after a fall; **Start Over** asks first.
- Rotating the phone upright pauses the game and shows a "turn your phone" prompt.
- The beacon offers **Keep Going** (a fresh circuit that carries your flock, eggs and score; the second circuit is a little harder and busier, the later ones are as hard as the second and never harder) or **Main Title**.

An existing save from the earlier GitHub Pages build (`egg-hero-journey-v1`) still works: Continue opens it.

## Run locally

```sh
python3 -m http.server 8080 --directory docs   # then open http://localhost:8080/
node --test                                    # unit + level-fairness tests (about two and a half minutes)
```

Add `?debug` to the URL to get `window.__egg` (teleport, fast-forward, force the beacon) for testing.

### More checks

| Command | What it checks |
| --- | --- |
| `FULL=1 node --test tests/levels.test.mjs` | A planner bot plays every flag-to-flag segment of three circuits, the static and window checks cover six (about 18 minutes) |
| `node tools/level-report.mjs` | Per-landscape length, pacing, hazards and difficulty ramp of a generated circuit (`--bot`: the planner's jumps a minute; `--felt --bots`: the threat-weighted event ramp, dead stretches, variety and how a button-masher, a sloppy and a clumsy player fare; `--listing 6`: a landscape beat by beat) |
| `node tools/audio-render.mjs` | Renders every song and effect offline and reports loudness, seams and mix margins |
| `node tests/e2e/*.mjs` | Real Chromium (Playwright) checks of layout, input, rendering, audio lifecycle and the full game (run them one at a time) |
| `node tests/e2e/game-spec.mjs` | Every requirement ID of SPEC.md (VIEW-1 ... AUDIO-2) as a named check, plus the traceability table in its header |
| `node tests/e2e/game-attack.mjs` | Hostile input against the whole game: 24-flip rotate storms and background storms in every state, double-taps, reloads, blocked/full storage, offline play of all 13 landscapes, a service-worker update, safe-area insets, odd screen sizes, a 6x slower CPU, GitHub Pages layout checks |

The long-run **soak** suites drive the real page (run them by hand, one at a time; each prints its own numbers and its usage is in its header):

| Command | What it checks |
| --- | --- |
| `node tests/e2e/soak-circuit.mjs [--quick]` | The whole one-hour circuit by replaying the planner's jumps (about 500x real time, 2 to 2.5 minutes): one chapter-enter and one song per landscape, every flag once, autosave, the beacon and Keep Going, circuit 2, reload and Continue, plus heap, DOM, listeners and sprite cache per landscape |
| `node tests/e2e/soak-fairness.mjs [--quick]` | Sampled flag-to-flag segments of several journey seeds and circuits: the planner clears all of them, and the page and headless Node agree exactly; careful, sloppy and clumsy bots as a fairness gauge |
| `node tests/e2e/soak-pace.mjs` | Real time (1x) with real swipes: Mama stays on the 110 u/s line, swipe latency, landscape crossing on time, frame pacing |
| `node tests/e2e/soak-perf.mjs [--quick]` | Frame cost per landscape and per layer, long tasks, the landscape dissolve, adaptive resolution under a 6x CPU throttle |
| `node tests/e2e/soak-audio.mjs [--quick]` | Audio lifecycle in the integrated page: one AudioContext after the first gesture, song order and crossfades, silence when paused or hidden, mute persistence |

### Release step

Before every deploy run `node tools/sync-sw.mjs`. It rewrites the file list and version fingerprint in `docs/sw.js`
so phones that already installed the game pick up the new files (and so offline play includes every file).
`tests/sw.test.mjs` fails if you forget.

## How it is built

```
docs/                 the whole deployed site (GitHub Pages serves this folder)
  index.html style.css manifest.webmanifest sw.js icons/ assets/*.webp (the 13 paintings)
  js/main.mjs         main loop and screen flow (js/loop.mjs: fixed timestep, adaptive resolution, save throttle)
  js/sim.mjs          deterministic fixed-step simulation (1/120 s), no browser APIs
  js/levelgen.mjs     seeded generator for the whole circuit (+ js/levels/*)
  js/tuning.mjs       every gameplay number in one place
  js/chapters.mjs     the 13 landscapes: names, palettes, hazards, story, pace
  js/render.mjs       camera, painted-background dissolve, layers, shadows, effects
  js/art-actors.mjs   Mama, ducklings, eggs, enemies (vector art, drawn once and stamped)
  js/art-terrain.mjs  platforms, spikes, springs, gates, beacon, water
  js/audio.mjs sfx.mjs music.mjs   Web Audio engine, effects and the 15-song score
  js/input.mjs save.mjs ui.mjs     swipes, saves (with legacy migration), menus
tests/                unit tests (Node) and e2e checks (Playwright)
tools/                level report, audio renderer, icon and service-worker helpers
SPEC.md DESIGN.md     the original requirements and the engineering contract
```

The world is a pure function of `(journeySeed, circuit)`, so a save is just a seed plus the last flag. The fixed
step makes the simulation reproducible, which is how the test bot proves every jump is possible.

The generator paces each landscape to a number of *threat-weighted* required events a minute (about 5 in Meadow rising slowly
to about 11 at the Summit: a moth counts only as much as it can really hurt a Mama who never jumps), then guards against dead
stretches by carving a small hop into any wait over about 18 s. Spikes are narrow (the art is much bigger than the hitbox), walls
that stop Mama dead are rare, and circuits after the second are not harder than the second. DESIGN.md section 4 has the details
and tests/felt.mjs measures the result from the finished geometry.

## GitHub Pages

Publish from the `main` branch and the `/docs` folder in
[Settings → Pages](https://github.com/benlambm/egg-mama/settings/pages). All URLs are relative, so the site works from
the repository subpath. Saves live in each browser's own storage, so the GitHub Pages and any other host keep separate
saves.

## Honest limits

Everything was verified in headless Chromium emulation (touch events, safe areas, rotation, offline). It has **not**
been run on a physical iPhone or Android phone, in Safari/WebKit, or listened to by a person: do that acceptance pass
(SPEC.md, "Release acceptance") before trusting it with the kids.
