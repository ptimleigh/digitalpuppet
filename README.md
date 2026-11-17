# Digital Puppet

A browser-based puppet in the style of JibJab: load an image, mark the part that is the mouth, and it flaps along with your **live microphone** or a **recorded audio file**. Keyboard keys trigger animations (expressions, bounces, spins…).

No build step and no dependencies. Open `index.html` in Chrome/Edge/Firefox. The microphone needs a secure context (`https://` or `http://localhost`), so for mic use run:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

Click **Puppet → Load demo puppet** to try it straight away (hold **Space** to flap the mouth, keys **A S B P D N** trigger animations).

## Features

| Tab | What it does |
|---|---|
| **Scene** | Background image or animated GIF (fit/fill), background colour (green for chroma-key), stage aspect ratio |
| **Puppet** | Base image + any number of *animation cells* (alternate poses/frames); size/position (also drag & scroll-wheel on the stage); flip, idle breathing, lock |
| **Mouth** | Drag a box around the part that moves (the jaw). Choose rectangle/ellipse, drop distance, hinge angle and mouth-interior colour, with live preview. Each cell may have its own mouth region |
| **Animate** | Build animations from a sequence of cells (fps, loop) and/or a motion effect (bounce, jump, shake, nod, sway, spin, pulse, squash with amount/duration/repeats) |
| **Keys** | Press-to-capture key bindings → animation, with mode *while held* / *once* / *toggle*. Also sets the manual "flap" key |
| **Audio** | Microphone or audio file; sensitivity, noise gate and close-speed with live meters |
| **Project** | Auto-saves in the browser (IndexedDB); export/import a `.json` project file |

`Tab` hides the panel for a clean performance view; **Fullscreen** fills the screen. For streaming, capture the window in OBS (use a green Scene colour + chroma key filter).

## How the mouth works

The box you draw is cut out of the image. While audio is loud the box is drawn lower (and optionally rotated about its top edge) and the hole it leaves behind is filled with the "mouth inside" colour. Draw the box around the lower lip and chin for the classic flappy-jaw look.

## Files

- `index.html`, `style.css`, `app.js` – the entire app
