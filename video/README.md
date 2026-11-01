# Mem-mastero explainer video

The 137.5-second v0.13 walkthrough explains how Mem-mastero works and how to use it: setup, updates, existing-login AI configuration, captured notes, source-linked summaries, hybrid search, storage measurement, verified Claude archival, and temporary read-only recall. It renders at 1920×1080 and 30 fps with voice narration, visible English captions, and a gentle instrumental bed. Terminal examples and session data are illustrative; the video does not operate on a user's real memory store.

Source files:

- `scene.html`: deterministic motion graphics and on-screen captions.
- `render.cjs`: 30 fps rendering, poster capture, and final audio mix.
- `captions.json`: narration-aligned English captions, scene starts, duration, playback rate, and lead time; captions also export to `site/demo.vtt`.
- `narration.txt` / `narration.mp3`: narration script and voice track.
- `music.py`: original background-music generator (Python and NumPy).
- `music.mp3`: prepared music track used by the renderer; normal rendering needs no Python. The mix gently ducks music during speech.

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

Render intermediates and review stills go to the ignored `brag-output/v3` directory. Local `video/node_modules` and `video/package-lock.json` are also ignored.

Published assets are `site/demo.mp4`, `site/demo-poster.jpg`, and `site/demo.vtt`. The README poster links to the public [website player](https://mem-mastero.vercel.app/#demo), with a separate direct MP4 link. The player has audio controls. The optional English caption track is off by default because the video already includes visible captions.

Narration was synthesized with vidIQ's Eric voice and plays at normal speed with a 0.65-second lead. Caption timings follow that final playback and are checked against the delivered narration. The light music bed is synthesized locally from original oscillator patterns, with no samples or stock recordings. To regenerate it, run `python video/music.py` with NumPy installed, then encode `brag-output/v3/music-bed.wav` to `video/music.mp3` with FFmpeg. An optional duration in seconds can be passed to the music generator; otherwise it follows `captions.json`.

Keep product claims aligned with the current release:

- AI is optional and uses an installed, signed-in Codex, Claude Code, or Copilot CLI. Requests consume the account's allowance and send filtered excerpts to that provider.
- Semantic search ranks a bounded page of saved notes. It does not search every archived transcript. Summaries are model interpretations with inspectable source IDs.
- Archives require explicit commands, stopped Claude processes, and private GitHub storage. Local removal follows cloud verification. Legacy clones and Git history can remain.
- Graph references contain metadata. Recall downloads and verifies the selected archive, returns a bounded portion, and removes its temporary downloaded files. Returned snippets can remain in the active conversation.
- Update every device to v0.13 or later before syncing generated summaries. Restart agents and review updated hooks if requested.

Long commands wrap visually without adding shell continuation characters. Placeholder IDs must be replaced with actual values returned by the corresponding memory or graph command. See [AI setup](../docs/ai-memory.md) and [archive recall](../commands/recall.md) for copyable commands and detailed limits.
