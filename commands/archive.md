---
description: Preview Claude session archives and prepare a safe terminal archive command
---

From the user's project repository, preview sessions eligible for explicit archival:

```bash
npx --yes github:Shaf2665/mem-mastero archive --dry-run
```

The default selects sessions last modified more than 30 days ago. If the user specifies an age, use `--older-than <days>`. If the user specifies a session ID, use `--session <id> --dry-run` instead. Show the selected session IDs and candidate reclaimable bytes.

Explain the required next step: close every Claude Code and Claude desktop process, then run the matching command in a regular terminal without `--dry-run`:

```bash
npx --yes github:Shaf2665/mem-mastero archive --session <id>
```

For an age-based selection, the terminal command is `npx --yes github:Shaf2665/mem-mastero archive --older-than <days>`.

Do not run the removing command from an active Claude session. The archive command uploads to the project's configured private GitHub memory repository, downloads and verifies the complete snapshot, and only then removes unchanged local session files. Claude must remain closed until it finishes. Existing memory clones and their Git history remain; durable auto-memory is not archived. All machines should run mem-mastero v0.10.0 or later.

For cloud archive inventory, use `npx --yes github:Shaf2665/mem-mastero archive --list`. Never substitute manual file deletion for the archive command.

If a previous archive was interrupted during local removal, tell the user to keep Claude closed and run `npx --yes github:Shaf2665/mem-mastero archive --recover` in the terminal. This recovers remaining quarantined originals without cloud access and preserves conflicting files. `restore <id>` fills any paths already removed after cloud verification. Never delete recovery directories manually.
