# Mem-mastero explainer video

The 65-second, 1920×1080 demo explains project-linked session sync, storage reporting, and explicit verified Claude Code archive/restore. Terminal examples and session data are illustrative.

Source files:

- `scene.html`: deterministic motion graphics and on-screen captions.
- `render.cjs`: 30 fps rendering, poster capture, and final audio mix.
- `captions.json`: timed English captions, also exported to `site/demo.vtt`.
- `narration.txt` / `narration.mp3`: narration script and voice track.
- `music.py`: original background-music generator (Python and NumPy).
- `music.mp3`: prepared music track used by the renderer; normal rendering needs no Python.

The renderer can reuse the existing dependencies under `brag-output/work/node_modules`. Otherwise, install its rendering tools locally:

```sh
npm --prefix video install --no-save playwright-core@1.56.1 ffmpeg-static@5.2.0
```

Set `CHROMIUM_PATH` to a Chromium executable if automatic local discovery does not find one. Run from the repository root:

```sh
node video/render.cjs stills
node video/render.cjs video
node video/render.cjs poster
```

Render intermediates and review stills go to the ignored `brag-output/v2` directory. Local `video/node_modules` and `video/package-lock.json` are also ignored.

Published assets are `site/demo.mp4`, `site/demo-poster.jpg`, and `site/demo.vtt`. The README poster links to the MP4, and the website embeds it with audio controls. The optional English caption track is off by default because the video already includes visible captions.

Narration was synthesized with vidIQ's Eric voice and plays at 1.08× speed with a 0.65-second lead. Caption timings follow that final playback. The quiet music bed is synthesized locally from original oscillator patterns, with no samples or stock recordings. To regenerate it, run `python video/music.py` with NumPy installed, then encode the resulting WAV to `video/music.mp3` with FFmpeg.

Keep product claims aligned with the current release: sync supports Claude Code, Codex, Copilot CLI and Pi beta; archives require explicit commands, stopped Claude processes, and private GitHub storage. Legacy clones/history remain outside archive cleanup. Graph search and automatic retrieval are not part of this demo.
