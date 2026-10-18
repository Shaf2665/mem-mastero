# mem-mastero

**Your coding agent's sessions and memory follow each repo across every machine.**

https://github.com/user-attachments/assets/35518702-83cb-4cb6-9a97-68fed34d2910

<sub>Video file: [`assets/demo.mp4`](assets/demo.mp4)</sub>

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
| **GitHub Copilot CLI** | ✅ Supported | Session folders for this repo (`~/.copilot/session-state/<id>/`) |
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
<summary><b>GitHub Copilot CLI</b></summary>

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

Restart `copilot`. Copilot CLI can also sync sessions to your GitHub account by itself (`/chronicle`). mem-mastero additionally restores the session files on your other machines, so `copilot --resume` finds them there. Machine-local lock files (`inuse.*.lock`) are never synced.
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

### Step 3 (recommended): Sync on `git push` / `git pull` / `git clone`

This makes memory follow your code. It works with GitHub, Azure Repos, GitLab and Bitbucket, from the terminal, VS Code, Visual Studio or any git client. It also works for every agent, even when no agent is open.

| You run | mem-mastero does |
|---|---|
| `git push` | uploads this repo's sessions and memory, in the background, so your push isn't slowed down |
| `git pull` (merge or rebase) | downloads them into Claude Code / Codex / Copilot / Pi's folders |
| `git clone` | downloads them for the fresh clone |

Turn it on once per machine:

```bash
node ~/.claude/plugins/marketplaces/mem-mastero/sync.js install-git-hooks
```

That path is where Claude Code keeps the plugin. With Codex it's `~/.codex/.tmp/marketplaces/mem-mastero/sync.js`, but any copy of `sync.js` works. The command copies itself to `~/.mem-mastero/sync.js` and sets git's global `core.hooksPath` to `~/.mem-mastero/git-hooks`. Undo it with:

```bash
node ~/.mem-mastero/sync.js uninstall-git-hooks
```

Good to know:

- **Your repos' own hooks keep working.** Every hook mem-mastero installs runs the repo's `.git/hooks/<name>` afterwards (Git LFS, pre-commit, and so on).
- **It won't overwrite another global hooks path.** If you already set a global `core.hooksPath`, install refuses and changes nothing. Repos that set their own local `core.hooksPath` (for example Husky) keep their hooks, but don't get git-triggered sync. The agent hooks still sync them.
- **`git fetch` alone has no git hook**, and neither does a `git pull` that says "Already up to date". Memory still arrives when you next start your agent.
- **New clones:** the clone path can differ from the folder your agent later opens (for example a different drive-letter case), so agent startup remains the guaranteed sync. Treat the clone sync as a head start.

### Step 4: Repeat on your other machines

Install the plugin in the same agents, set up the same backend, and (optionally) the git hooks. Open or pull the repo and your history arrives.

---

## How it works

Each agent runs mem-mastero from its own lifecycle hooks (a small extension for Pi):

| Agent | Session start | During / end of session |
|---|---|---|
| Claude Code | pull + push | push after every reply, and at session end |
| Codex | pull + push | push the current session after every turn, and at session end |
| Pi | pull + push | push the current session after every prompt, and at shutdown |
| Copilot CLI | pull + push | push the session on every prompt, and at session end |

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

### Big sessions (over 100 MB)

GitHub rejects any file over 100 MB, and long agent sessions can grow past that. In the synced folder, mem-mastero stores every file over **45 MB** as numbered parts next to a manifest:

```
<session>.jsonl.parts/
  manifest.json        original name, size, SHA-256, and the parts in order
  part-001.jsonl
  part-002.jsonl
  part-003.jsonl
```

- **Your agent always sees the whole session.** When a machine pulls, the parts are joined back into the original file, byte for byte, in the place the agent expects. `/resume` works as usual, with the full context.
- **The original is checked before use.** The rebuilt file must match the manifest's SHA-256. If a part is missing or hasn't finished syncing, the session is skipped and retried next time, so you never get a corrupt session.
- **Each part is readable on its own.** Parts are cut at line boundaries, so every part is valid JSONL, in order. You (or an agent) can open part-001 in the repo and read the start of the conversation.
- It works the same on Google Drive. You can change the part size with the `MEM_MASTERO_PART_BYTES` environment variable (in bytes).

## Resuming a session from another machine

| Agent | How |
|---|---|
| Claude Code | `/resume`, or `claude --resume` |
| Codex | `codex resume --all`. The default picker only lists sessions whose folder matches the current one exactly, so use `--all` or `codex resume <session-id>` |
| Copilot CLI | `copilot --resume`, or `copilot --resume=<session-id>` |
| Pi | `/resume`, or `pi --resume`. Pulled sessions are placed in this machine's folder for the repo |

## Good to know

- **Repos only.** A folder without a git `origin` remote isn't synced, because the remote URL is how machines agree on which project is which.
- **Privacy:** transcripts can contain anything you pasted or that tools printed, including secrets. They're stored in *your* Drive or repo. **Keep the GitHub repo private.**
- **Deletes don't propagate.** A session or memory removed on one machine comes back from another. Delete it from Drive or the repo too.
- **GitHub repo size:** every turn commits the changed transcript, so the repo grows over time. Single files over 100 MB are handled by [splitting them into parts](#big-sessions-over-100-mb). GitHub recommends keeping repos under a few GB, so start a fresh memory repo now and then if yours gets huge.
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
| Git hooks | `node ~/.mem-mastero/sync.js uninstall-git-hooks` |

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
