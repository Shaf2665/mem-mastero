# mem-mastero

**Your coding agent's sessions and memory follow each repo across every machine.**

Coding agents keep chat history and memory **on the machine where you worked**. Clone the same repo on another computer and you start from zero. mem-mastero syncs that history through storage **you own**:

- **Google Drive** (via Google Drive for Desktop), or
- **a private GitHub repo**

Projects are matched by their **git `origin` URL**, not their folder path. A clone at `D:\Work\app` on your Windows PC and `~/code/app` on your Mac share the same sessions.

## Supported agents

| Agent | Status | What gets synced |
|---|---|---|
| **Claude Code** (CLI, desktop, IDE) | ✅ Supported | Session transcripts + auto-memory (`~/.claude/projects/<project>/`) |
| **OpenAI Codex** (CLI, desktop app) | ✅ Supported | Session rollouts for this repo (`~/.codex/sessions/**/rollout-*.jsonl`) |
| **Pi coding agent** (`pi`) | 🧪 Beta | Session files for this repo (`~/.pi/agent/sessions/--<path>--/*.jsonl`) |
| **GitHub Copilot CLI** | 🧪 Beta | Session folders for this repo (`~/.copilot/session-state/<id>/`) |
| Copilot Chat in VS Code / JetBrains | ⏳ Not yet | Chats are stored in IDE workspace storage, which isn't keyed by repo |
| OpenCode | ⏳ Not yet | Sessions live in a SQLite database, so they can't be copied file by file |
| Gemini CLI / Antigravity | ⏳ Not yet | Different session layout; adapter not written yet |
| Cursor, Windsurf, Cline, Aider, others | ⏳ Not yet | No adapter yet. PRs welcome (see [Adding an agent](#adding-an-agent)) |

> **Beta** means the adapter follows the agent's official docs and passes the test suite, but hasn't been run against a live install yet. Please open an issue if something's off.

Project *instructions* such as `CLAUDE.md`, `AGENTS.md` and `.github/copilot-instructions.md` already live in your repo, so git syncs them. mem-mastero covers what git doesn't: the history and memory kept in your home folder.

---

## Requirements

- [Node.js](https://nodejs.org) 18+ on your `PATH`
- [git](https://git-scm.com)
- **One** of these:
  - [Google Drive for Desktop](https://www.google.com/drive/download/), signed in
  - a GitHub account

## Installation

### Step 1: Install the plugin in your agent(s)

Install it in every agent you use. They all share the same sync setup.

<details open>
<summary><b>Claude Code</b></summary>

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

Restart Claude Code.
</details>

<details open>
<summary><b>OpenAI Codex</b> (CLI, desktop app)</summary>

```bash
codex plugin marketplace add Shaf2665/mem-mastero
```

```bash
codex plugin add mem-mastero@mem-mastero
```

Then run `codex`, open **`/hooks`**, review and **trust** mem-mastero's hooks, and start a new thread. The Codex desktop app uses the same install; restart it afterwards.
</details>

<details open>
<summary><b>Pi coding agent</b> (beta)</summary>

```bash
pi install git:github.com/Shaf2665/mem-mastero
```

Restart `pi`. At startup you'll see a `mem-mastero: pi ...` notice showing what was synced.
</details>

<details open>
<summary><b>GitHub Copilot CLI</b> (beta)</summary>

```bash
copilot plugin marketplace add Shaf2665/mem-mastero
```

```bash
copilot plugin install mem-mastero@mem-mastero
```

Or inside an interactive Copilot CLI session:

```
/plugin marketplace add Shaf2665/mem-mastero
/plugin install mem-mastero@mem-mastero
```

Copilot CLI can also sync sessions to your GitHub account by itself (`/chronicle`). mem-mastero additionally restores the session files on your other machines, so `copilot --resume` finds them there.
</details>

### Step 2: Choose where to sync

#### Option A: Google Drive (default, no config needed)

1. Install **Google Drive for Desktop** and sign in.
2. That's it. mem-mastero finds your Drive folder automatically:
   - Windows: `G:\My Drive` (any drive letter)
   - macOS: `~/Library/CloudStorage/GoogleDrive-*/My Drive`

To use a different folder (for example an `rclone mount` on Linux, or Dropbox or OneDrive), create `~/.mem-mastero.json`:

```json
{ "dir": "/path/to/synced/folder" }
```

#### Option B: Private GitHub repo

1. Create a **private** repo to hold your memory:

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

### Step 3: Repeat on your other machines

Install the plugin in the same agents and set up the same backend. Open the repo and your history arrives.

---

## How it works

Each agent runs mem-mastero from its own lifecycle hooks (a small extension for Pi):

| Agent | Session start | During / end of session |
|---|---|---|
| Claude Code | pull + push | push after every reply, and at session end |
| Codex | pull + push | push the current session after every turn, and at session end |
| Pi | pull + push | push the current session after every prompt, and at shutdown |
| Copilot CLI | pull + push | push the session at session end |

The synced folder (Drive or the GitHub repo) looks like this:

```
projects/<host>/<owner>/<repo>/            Claude Code
codex/projects/<host>/<owner>/<repo>/      Codex   (YYYY/MM/DD/rollout-*.jsonl)
copilot/projects/<host>/<owner>/<repo>/    Copilot (<session-id>/...)
pi/projects/<host>/<owner>/<repo>/         Pi      (<timestamp>_<id>.jsonl)
```

- For each file, the newer copy wins. If two machines edit the same file between syncs, the one that syncs last wins.
- With GitHub, every sync is a commit, and pushes during a session happen in the background.
- If Claude's `MEMORY.md` was updated from another device, the fresh copy is injected into the session at startup.
- A failing sync never blocks your agent. You get one line of explanation and the session carries on.
- There are no dependencies: one Node script and git.

Manual sync from inside a repo: `node <plugin-dir>/sync.js <claude|codex|copilot|pi> start`

## Resuming a session from another machine

| Agent | How |
|---|---|
| Claude Code | `/resume`, or `claude --resume` |
| Codex | `codex resume --all`. The default picker only lists sessions whose folder matches the current one exactly, so use `--all` or `codex resume <session-id>` |
| Copilot CLI | `copilot --resume` |
| Pi | `/resume`, or `pi --resume`. Pulled sessions are placed in this machine's folder for the repo |

## Good to know

- **Repos only.** A folder without a git `origin` remote isn't synced, because the remote URL is how machines agree on which project is which.
- **Privacy:** transcripts can contain anything you pasted or that tools printed, including secrets. They're stored in *your* Drive or repo. **Keep the GitHub repo private.**
- **Deletes don't propagate.** A session or memory removed on one machine comes back from another. Delete it from Drive or the repo too.
- **GitHub repo size:** every turn commits the changed transcript, so the repo grows over time. GitHub rejects single files over 100 MB.
- **First GitHub sync on an extra machine:** if that machine already had its own Claude `MEMORY.md` for a project, the one from the repo replaces it.
- Transcripts keep the original machine's absolute paths. Resume works, but old tool output shows the other machine's paths.
- Don't run the *same* session on two machines at the same time. The last writer wins.

## Uninstall

| Agent | Command |
|---|---|
| Claude Code | `claude plugin uninstall mem-mastero@mem-mastero` |
| Codex | `codex plugin remove mem-mastero` |
| Copilot CLI | `copilot plugin uninstall mem-mastero` |
| Pi | `pi remove git:github.com/Shaf2665/mem-mastero` |

Your synced data stays in Drive or the repo. Delete `~/.mem-mastero.json` and `~/.mem-mastero/` to remove the local config and clone.

## Adding an agent

An agent can be supported when it (1) has lifecycle hooks or a plugin system that can run a command, and (2) stores sessions as files. Each adapter in [`sync.js`](sync.js) is a few lines:

- `local`: where the agent keeps sessions
- `remote`: its prefix in the synced folder
- `push`: which of those files belong to the current repo

Add the agent's manifest and hooks file, add a case to [`test.js`](test.js), and open a PR.

## Development

```bash
git clone https://github.com/Shaf2665/mem-mastero.git
cd mem-mastero
node test.js
claude plugin validate .
```

## License

[MIT](LICENSE)
