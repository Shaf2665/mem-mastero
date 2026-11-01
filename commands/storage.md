---
description: Measure local Claude and mem-mastero storage without changing sessions
---

Run the read-only local storage report:

```bash
npx --yes github:Shaf2665/mem-mastero storage --json
```

Summarize Claude session data, companion data, durable memory, and mem-mastero clone/Git-history sizes from the report. Report unreadable-path errors; do not present an incomplete measurement as a complete total. Values are logical file bytes, which can differ from physical disk allocation.

If the user wants to release session space, run this project's preview:

```bash
npx --yes github:Shaf2665/mem-mastero archive --dry-run
```

Explain that actual archiving requires all Claude Code and Claude desktop processes to be closed. Existing memory clones and Git history are retained. Do not remove files as part of a storage report.
