# Egg Mama

Guide Egg Mama through 13 pixel-art chapters to recover the scattered clutch and relight the summit beacon. Golden eggs hatch into ducklings that follow Mama and act as extra lives. The game saves at checkpoint flags and chapter transitions in the current browser.

## Play

Landscape gives you more room to see upcoming gaps on a phone. Mama rolls forward at a steady pace as soon as you start or continue.

| Input | Action |
| --- | --- |
| Swipe up on the game field | Jump |
| Swipe left or right | Back up or push forward |
| On-screen arrow and Jump buttons | Hold to steer or jump |
| A/D or left/right arrows | Steer with a keyboard |
| Space or Up | Jump with a keyboard |
| Shift | Sprint |
| P or Escape | Pause |
| M | Mute or unmute the soundtrack and effects |

Choose **Continue** to load the latest checkpoint. **Start Over** on the title screen replaces the saved journey after confirmation.

## Run locally

The game uses plain HTML, CSS, Canvas, and Web Audio. It has no build step or runtime dependencies.

```sh
python3 -m http.server 8080 --directory docs
node --test
```

Open http://localhost:8080/ to play. The tests check swipe classification, forward momentum, jump reach, extra lives, chapter progression, and checkpoint compatibility.

## GitHub Pages

Publish from the `main` branch and the `/docs` folder in [Settings → Pages](https://github.com/benlambm/egg-mama/settings/pages). This connects every push to `main` to GitHub Pages. The site files use relative URLs so they can be served from the repository subpath.

GitHub Pages and the original Sites build have separate browser saves because they run on different domains.
