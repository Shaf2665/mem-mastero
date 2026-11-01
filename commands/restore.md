---
description: Find a Claude session archive and prepare its safe terminal restore command
---

From the user's project repository, list available cloud archives:

```bash
npx --yes github:Shaf2665/mem-mastero archive --list
```

Match the user's requested session ID and, when provided, its revision hash. Explain that they must close all Claude Code and Claude desktop processes before restoring, then run this in a regular terminal:

```bash
npx --yes github:Shaf2665/mem-mastero restore <id>
claude --resume <id>
```

`restore` selects the latest archived revision unless `--revision <hash>` is supplied. It verifies the downloaded snapshot, restores original bytes with fresh modification times, and refuses to overwrite different local contents. Do not resolve a conflict by deleting or overwriting the local session; show the conflict so the user can preserve both copies.

Do not run restore from an active Claude session. Cloud restoration requires authenticated GitHub CLI access to the configured private memory repository and an internet connection. The archive command does not automatically restore cloud-only sessions into Claude's native resume picker.

If an interrupted archive left local recovery files, `restore` attempts to recover those first. The user can run `npx --yes github:Shaf2665/mem-mastero archive --recover` with Claude closed to recover remaining originals offline, then restore missing files from the cloud when connected. Never manually delete recovery directories or overwrite conflicts.
