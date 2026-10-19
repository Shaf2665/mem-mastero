---
description: Connect this machine to your mem-mastero memory: create or reconnect a private repo (personal or work account) or Google Drive
---

Set up mem-mastero on this machine. Keep it to as few questions as possible.

1. Run `gh auth status` to see which GitHub accounts are signed in, and `node "${CLAUDE_PLUGIN_ROOT}/sync.js" status` to see what's already configured. (If `${CLAUDE_PLUGIN_ROOT}` isn't set, use `~/.mem-mastero/sync.js`, or `npx github:Shaf2665/mem-mastero` in place of `node .../sync.js`.)
2. Ask the user **one** question with sensible defaults filled in:
   - **Which account / repo:** default `<account>/claude-memory`. With one signed-in account, just confirm it. If `gh` isn't signed in, offer Google Drive, or ask them to run `gh auth login` first.
   - **Only for a work account:** which projects belong to it, as git-remote patterns. Suggest patterns from the repos they work in, for example `dev.azure.com/<org>/*` or `github.com/<org>`. Skip this when reconnecting: the repo already holds its rules.
3. Run:
   `node "${CLAUDE_PLUGIN_ROOT}/sync.js" setup --yes --account <account> --repo <owner/name> [--for "<patterns>"]`
   For Google Drive use `setup --yes --drive`. Add `--no-hooks` only if the user doesn't want sync on `git push` / `git pull`.
4. Show the user the summary it prints, which lists the stores, where this repo goes, and whether git sync is on. Run setup again to add a second account (for example work + personal).

If cloning fails because of authentication, tell the user to run `gh auth login` (or sign in when Git Credential Manager asks), then run this again.
