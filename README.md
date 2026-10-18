# mem-mastero

**Your Claude Code sessions and memory follow each repo across every machine.**

Claude Code keeps each project's chat history (`*.jsonl` session transcripts) and auto-memory (`memory/`) in `~/.claude/projects/<path-of-folder>/`. That folder exists only on the machine where you worked. If you clone the same repo on another computer, you start from zero.

mem-mastero syncs that folder through storage **you own**:

- **Google Drive** (via Google Drive for Desktop), or
- **a private GitHub repo**

Projects are matched by their **git `origin` URL**, not their folder path. A clone at `D:\Work\app` on your Windows PC and `~/code/app` on your Mac share the same sessions and memory.

---

## Requirements

- [Claude Code](https://claude.com/claude-code)
- [Node.js](https://nodejs.org) 18+ on your `PATH`
- [git](https://git-scm.com)
- **One** of these:
  - [Google Drive for Desktop](https://www.google.com/drive/download/), signed in
  - a GitHub account

## Installation

### 1. Install the plugin

Inside Claude Code:

```
/plugin marketplace add Shaf2665/mem-mastero
/plugin install mem-mastero@mem-mastero
```

Or from a terminal:

```bash
claude plugin marketplace add Shaf2665/mem-mastero
```

```bash
claude plugin install mem-mastero@mem-mastero
```

Restart Claude Code afterwards.

### 2. Choose where to sync

#### Option A: Google Drive (default, no config needed)

1. Install **Google Drive for Desktop** and sign in.
2. That's it. mem-mastero finds your Drive folder automatically:
   - Windows: `G:\My Drive` (any drive letter)
   - macOS: `~/Library/CloudStorage/GoogleDrive-*/My Drive`

   Data goes to `My Drive/mem-mastero/projects/<host>/<owner>/<repo>/`.

To use a different folder (for example an `rclone mount` on Linux, or Dropbox or OneDrive), create `~/.mem-mastero.json`:

```json
{ "dir": "/path/to/synced/folder" }
```

#### Option B: Private GitHub repo

1. Create a **private** repo to hold your memory. Using the GitHub CLI:

   ```bash
   gh repo create claude-memory --private
   ```

2. Create `~/.mem-mastero.json` on **every** machine. On Windows that's `C:\Users\<you>\.mem-mastero.json`.

   ```json
   { "github": "https://github.com/<your-username>/claude-memory.git" }
   ```

3. Make sure git can push to it without a prompt. Any of these works:
   - Git Credential Manager (bundled with Git for Windows)
   - an SSH key (then use the `git@github.com:...` URL)
   - `gh auth setup-git`

On first use the repo is cloned to `~/.mem-mastero/repo`.

### 3. Do the same on your other machines

Install the plugin and set up the same backend. Open any repo in Claude Code and your history arrives.

---

## How it works

| When | Google Drive | GitHub |
|---|---|---|
| Session starts | Pull newer files, push local ones | Commit local changes, `pull --rebase`, push, copy pulled files in |
| After each reply / session ends | Copy changed files to Drive | Commit changed files, push in the background |

- For each file, the newer copy wins. If two machines edit the same file between syncs, the one that syncs last wins.
- If `MEMORY.md` was updated from another device at startup, the fresh copy is injected straight into the session.
- A failing sync never blocks Claude Code. You get one line of explanation and the session carries on.
- There are no dependencies: one Node script and git.

Manual sync from inside a repo: `node <plugin-dir>/sync.js start` (or `push` / `pull`).

## Resuming a session from another machine

Sessions pulled at startup show up in `/resume` inside that session, and in `claude --resume` on the next launch.

## Good to know

- **Repos only.** A folder without a git `origin` remote isn't synced, because the remote URL is how machines agree on which project is which.
- **Privacy:** transcripts can contain anything you pasted or that tools printed, including secrets. They're stored in *your* Drive or repo. **Keep the GitHub repo private.**
- **Deletes don't propagate.** A memory removed on one machine comes back from another. Delete it from Drive or the repo too.
- **GitHub repo size:** every turn commits the changed transcript, so the repo grows over time. GitHub rejects single files over 100 MB.
- **First GitHub sync on an extra machine:** if that machine already had its own `MEMORY.md` for a project, the one from the repo replaces it.
- Transcripts keep the original machine's absolute paths (`cwd`). Resume works, but old tool output shows the other machine's paths.
- Don't run the *same* session on two machines at the same time. The last writer wins.
- Only Claude Code is supported for now.

## Uninstall

```bash
claude plugin uninstall mem-mastero@mem-mastero
```

Your synced data stays in Drive or the repo. Delete `~/.mem-mastero.json` and `~/.mem-mastero/` to remove the local config and clone.

## Development

```bash
git clone https://github.com/Shaf2665/mem-mastero.git
cd mem-mastero
node test.js
claude plugin validate .
```

## License

[MIT](LICENSE)
