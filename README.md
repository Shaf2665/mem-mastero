# mem-mastero

**Your coding agent's sessions and memory follow each repo across every machine.**

https://github.com/user-attachments/assets/35518702-83cb-4cb6-9a97-68fed34d2910

<sub>Video file: [`site/demo.mp4`](site/demo.mp4)</sub>

Claude Code, Codex, Copilot CLI and Pi keep your chat history and memory **on the machine where you worked**. Clone the same repo on another laptop and the agent starts from zero.

mem-mastero syncs that history through storage **you own**, either a **private GitHub repo** or **Google Drive**. It syncs when your agent starts and finishes a turn, and also when you `git push` and `git pull`.

```bash
npx github:Shaf2665/mem-mastero setup
```

Run that one command on every machine and you're done. Projects are matched by their **git remote**, not their folder path, so `D:\Work\app` on your PC and `~/code/app` on your Mac share the same sessions.

---

## Contents

- [Supported agents](#supported-agents)
- [Setup](#setup)
- [Personal and work accounts](#personal-and-work-accounts)
- [How it works](#how-it-works)
- [Resuming a session on another machine](#resuming-a-session-on-another-machine)
- [Security and privacy](#security-and-privacy)
- [Command reference](#command-reference)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [Adding an agent](#adding-an-agent) · [Development](#development)

## Supported agents

| Agent | Status | What gets synced |
|---|---|---|
| **Claude Code** (CLI, desktop, IDE) | ✅ Supported, tested on 2.1 | Session transcripts + auto-memory (`~/.claude/projects/<project>/`) |
| **OpenAI Codex** (CLI, desktop app) | ✅ Supported, tested on 0.147 | This repo's session rollouts (`~/.codex/sessions/**/rollout-*.jsonl`) |
| **GitHub Copilot CLI** | ✅ Supported, tested live on 1.0.98 | This repo's session folders (`~/.copilot/session-state/<id>/`) |
| **Pi coding agent** (`pi`) | 🧪 Beta | This repo's session files (`~/.pi/agent/sessions/--<path>--/*.jsonl`) |
| Copilot Chat in VS Code / JetBrains | ⏳ Not yet | Chats live in IDE workspace storage, which isn't keyed by repo |
| OpenCode | ⏳ Not yet | Sessions live in a SQLite database, so they can't be copied file by file |
| Gemini CLI / Antigravity, Cursor, Windsurf, Cline, Aider | ⏳ Not yet | No adapter yet. PRs welcome, see [Adding an agent](#adding-an-agent) |

**Beta** means the adapter follows the agent's official docs and passes the test suite, but hasn't run against a live install yet.

Project instructions (`CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`) already live in your repo, so git syncs them. mem-mastero covers what git doesn't: the history and memory kept in your home folder.

## Setup

**Requirements:**
- [Node.js](https://nodejs.org) 18.17+ and [git](https://git-scm.com).
- For the GitHub option, [GitHub CLI](https://cli.github.com) signed in: `gh auth login`.

On **every** machine, whether it's your first or your tenth:

```bash
npx github:Shaf2665/mem-mastero setup
```

It asks two or three questions, and the default (in brackets) is right most of the time:

```
GitHub accounts signed in on this machine:
  1) Shaf2665
  2) mshafiq-acme
Which account holds this memory? [1]:
Memory repo [Shaf2665/claude-memory]:
✓ Found Shaf2665/claude-memory            (first time: ✓ Created private repo Shaf2665/claude-memory)
✓ Connected to github.com/shaf2665/claude-memory
Plugin in your coding agents:
  ✓ claude
  ✓ codex — open /hooks in codex once and trust mem-mastero
  ✓ copilot
Also sync on git push / pull / clone? (Y/n) [Y]:

mem-mastero stores:
  • github.com/shaf2665/claude-memory  ←  all projects
Git push/pull sync: on
```

That one command does three things:
1. **Connects your memory repo.** It finds the repo on the account you picked, or creates it as **private**. With no GitHub CLI, it asks for a repo URL instead; press Enter there to use Google Drive.
2. **Installs the plugin** into every coding agent it finds: Claude Code, Codex, Copilot CLI and Pi.
3. **Turns on sync for `git push` / `git pull` / `git clone`**, for every repo on the machine.

**On a second laptop** the same command finds the existing repo and reconnects. Which projects belong to which repo is stored in the repo itself, so it asks nothing about that.

**From inside an agent:** in Claude Code or Copilot CLI, run `/mem-mastero:setup` and the agent asks the same questions in chat.

**For Codex,** open `/hooks` once and trust mem-mastero. Codex asks you to approve plugin hooks before they run.

<details>
<summary><b>Manual installation</b> (if you'd rather not use <code>setup</code>)</summary>

| Agent | Install |
|---|---|
| Claude Code | `/plugin marketplace add Shaf2665/mem-mastero` then `/plugin install mem-mastero@mem-mastero` |
| Codex | `codex plugin marketplace add Shaf2665/mem-mastero` then `codex plugin add mem-mastero@mem-mastero`, then trust it under `/hooks` |
| Copilot CLI | `copilot plugin marketplace add Shaf2665/mem-mastero` then `copilot plugin install mem-mastero@mem-mastero` |
| Pi (beta) | `pi install git:github.com/Shaf2665/mem-mastero` |

Then write `~/.mem-mastero.json` yourself (see [Config file](#config-file)) and, optionally, run `npx github:Shaf2665/mem-mastero install-git-hooks`.
</details>

## Personal and work accounts

Run `setup` once per account. A work memory repo takes **only** the projects you list for it; everything else goes to your personal one.

```bash
npx github:Shaf2665/mem-mastero setup   # pick your work account, answer: dev.azure.com/acme/*, github.com/acme
npx github:Shaf2665/mem-mastero setup   # pick your personal account, press Enter (= all other projects)
```

```
mem-mastero stores:
  • github.com/acme/claude-memory       ←  dev.azure.com/acme/*, github.com/acme
  • github.com/shaf2665/claude-memory   ←  all other projects
```

- **Company memory stays in the company account.** Each project goes to the first store whose patterns match its git remote, so an Azure Repos or GitHub-org project from work never lands in your personal repo.
- **Both accounts work side by side.** Each memory repo's URL carries its account name (`https://you-at-work@github.com/...`), so git signs in with the right account for each one, with no switching.
- **A work-only laptop** runs setup with just the work account. Personal projects then aren't synced on it at all.
- **Patterns** are git-remote globs:
  - `dev.azure.com/org/*`
  - `github.com/org`, which covers that owner and everything under it
- **To see where a repo's memory goes,** run `npx github:Shaf2665/mem-mastero status` inside it.

Azure Repos URLs match regardless of form: `https://org@dev.azure.com/org/proj/_git/repo`, `git@ssh.dev.azure.com:v3/org/proj/repo` and `org.visualstudio.com/...` are all the same project.

## How it works

Each agent runs mem-mastero from its own lifecycle hooks (a small extension for Pi):

| Agent | When the session starts | During and at the end |
|---|---|---|
| Claude Code | pull, then push | push after every reply, and at session end |
| Codex | pull, then push | push the current session after every turn, and at session end |
| Copilot CLI | pull, then push | push on every prompt, and at session end |
| Pi | pull, then push | push after every prompt, and at shutdown |

With git sync on, it also runs on git events:

| You run | mem-mastero does |
|---|---|
| `git push` | uploads this repo's sessions and memory, in the background, so the push isn't slowed down |
| `git pull` (merge or rebase) | downloads them into each agent's folders |
| `git clone` | downloads them for the fresh clone |

The memory repo (or Drive folder) is laid out by project:

```
projects/<host>/<owner>/<repo>/            Claude Code
codex/projects/<host>/<owner>/<repo>/      Codex    (YYYY/MM/DD/rollout-*.jsonl)
copilot/projects/<host>/<owner>/<repo>/    Copilot  (<session-id>/...)
pi/projects/<host>/<owner>/<repo>/         Pi       (<timestamp>_<id>.jsonl)
mem-mastero.json                           which projects this store holds
```

- **Newest copy wins**, file by file. If two machines change the same file between syncs, the one that syncs last wins.
- **Files are synced byte for byte.** No line-ending conversion, even with Git for Windows' `autocrlf`.
- **Claude memory updates arrive immediately.** If Claude's `MEMORY.md` changed on another device, the fresh copy is handed to the new session at startup.
- **A failing sync never blocks your agent or your `git` command.** You get one line of explanation, and the next sync catches up.
- **No dependencies:** one Node script and git.

### Big sessions (over 100 MB)

GitHub rejects files over 100 MB, and long sessions grow past that. In the memory repo, any file over **45 MB** is stored as numbered parts with a manifest:

```
<session>.jsonl.parts/
  manifest.json        original name, size, SHA-256, part order
  part-001.jsonl
  part-002.jsonl
```

- **Your agent always sees the whole session.** On pull, the parts are joined back into the original file, byte for byte, where the agent expects it.
- **Nothing half-synced is used.** The rebuilt file must match the SHA-256. If a part is missing, the session is skipped and retried later.
- **Parts are cut at line ends,** so each part is valid JSONL you can read on its own.

## Resuming a session on another machine

| Agent | How |
|---|---|
| Claude Code | `/resume`, or `claude --resume` |
| Codex | `codex resume --all`. The default picker only lists sessions from the exact same folder; `codex resume <session-id>` also works |
| Copilot CLI | `copilot --resume`, or `copilot --resume=<session-id>` |
| Pi | `/resume`, or `pi --resume` |

Pull first: `git pull`, or start a new agent session in the repo. The session is then on disk when you resume.

## Security and privacy

- **Transcripts can contain anything** you pasted or a tool printed, including code, customer data and secrets. Store them only in a **private** repo, or a Drive you control.
- **Work projects belong in a work store.** Use [`for` rules](#personal-and-work-accounts) so company memory never goes to a personal account, and check your employer's policy on where transcripts may be stored.
- **mem-mastero stores no tokens or passwords.** Sign-in is handled by GitHub CLI and Git Credential Manager.
- **Some files never leave your machine:** agent lock files (`*.lock`, `*.hold`) and anything outside a repo's own session folders.
- **The git hooks only ever write to your memory repos.** Since v0.7.1, mem-mastero clears the repo variables git sets for hooks (`GIT_DIR` and others) before it does anything. A regression test checks that a pushed repo never receives a mem-mastero commit.

## Command reference

Everything is available through `npx github:Shaf2665/mem-mastero <command>`. After setup, the same script is also at `~/.mem-mastero/sync.js`.

| Command | What it does |
|---|---|
| `setup` | Connect this machine: create or reconnect a memory repo, install the plugin into your agents, turn on git sync |
| `status` | Show your stores, where the current repo's memory goes, and whether git sync is on |
| `install-git-hooks` / `uninstall-git-hooks` | Turn sync on `git push` / `pull` / `clone` on or off |
| `<agent> start` \| `push` \| `pull` | Sync one repo now, for `claude`, `codex`, `copilot` or `pi` (run inside the repo) |
| `help` | List the commands |

`setup` options, for scripting or when your agent runs it for you:

| Option | Meaning |
|---|---|
| `--account <user>` | GitHub account to use (default: asks, or the only one signed in) |
| `--repo <owner/name or URL>` | Memory repo (default: `<account>/claude-memory`) |
| `--for "<patterns>"` | Projects for this store, e.g. `"dev.azure.com/acme/*, github.com/acme"`. Leave it out for "all other projects" |
| `--drive` / `--dir <path>` | Use Google Drive, or any synced folder, instead of GitHub |
| `--yes` | Accept every default; no questions |
| `--no-hooks` / `--no-agents` | Skip git sync / skip installing the plugin into agents |

Environment variables:

| Variable | Use |
|---|---|
| `MEM_MASTERO_DIR` | Sync to this folder instead of the configured stores (handy for testing) |
| `MEM_MASTERO_LOG` | Append what each agent's hook received to this file (troubleshooting) |
| `MEM_MASTERO_PART_BYTES` | Size at which files are split into parts (default 45 MB) |
| `MEM_MASTERO_INHIBIT` | Set to `1` to skip git-triggered sync for one command |

### Config file

`setup` writes `~/.mem-mastero.json`; you don't need to edit it:

```json
{ "stores": [
  { "github": "https://you-at-work@github.com/acme/claude-memory.git", "for": ["dev.azure.com/acme/*", "github.com/acme"] },
  { "github": "https://you@github.com/you/claude-memory.git" }
] }
```

- **Stores with rules are checked first.** A store without `for` takes every project no other store claims.
- **No catch-all store** means unmatched projects aren't synced.
- **A Drive or folder store** is `{ "dir": "/path" }`, or `{}` to auto-detect `G:\My Drive` / `~/Library/CloudStorage/GoogleDrive-*/My Drive`.
- **Pre-0.8 configs** (`{ "github": "..." }` or `{ "dir": "..." }`) still work as a single store.

## Troubleshooting

| You see | Do this |
|---|---|
| `… matches none of your stores, so it isn't synced` | That repo's remote fits no store's rules. Run `setup` again to add or widen a store, or check with `status`. |
| `no git "origin" remote in this folder` | Only repos with an `origin` remote are synced, because the remote is how machines recognize the same project. |
| `couldn't clone …` during setup | Sign in with the account that owns the repo: run `gh auth login`, or approve the Git Credential Manager prompt. Then run `setup` again. |
| Codex sessions don't sync | Open `/hooks` in Codex and trust mem-mastero. |
| A session from another machine doesn't show in Codex | Use `codex resume --all`. |
| `global core.hooksPath is already …` | Another tool owns git's global hooks. mem-mastero leaves it alone; agent sync still works. |
| Want to see what a hook received | Set `MEM_MASTERO_LOG=/path/to/log.jsonl` and start your agent. |

**Known limits:**
- **Deletes don't propagate.** A session removed on one machine comes back from another; delete it in the memory repo too.
- **`git fetch` alone triggers nothing,** and neither does a `git pull` that says "Already up to date". Memory still arrives when you next start your agent.
- **Repos with their own local `core.hooksPath`** (for example Husky) don't get git-triggered sync. Agent sync still covers them.
- **Don't run the same session on two machines at once.** The last writer wins.
- **The memory repo grows** with every synced turn. If it gets very large, start a fresh one.

## Uninstall

| What | Command |
|---|---|
| Claude Code | `claude plugin uninstall mem-mastero@mem-mastero` |
| Codex | `codex plugin remove mem-mastero` |
| Copilot CLI | `copilot plugin uninstall mem-mastero` |
| Pi | `pi remove git:github.com/Shaf2665/mem-mastero` |
| Git sync | `npx github:Shaf2665/mem-mastero uninstall-git-hooks` |

Your memory stays in your repos or Drive. To remove the local config and clones, delete `~/.mem-mastero.json` and `~/.mem-mastero/`.

## Adding an agent

An agent can be supported if it (1) has lifecycle hooks or a plugin system that can run a command, and (2) stores sessions as files. Each adapter in [`sync.js`](sync.js) is a few lines:

- `local`: where the agent keeps sessions on disk
- `remote`: its folder in the memory repo
- `push`: which of those files belong to the current repo

Add the agent's manifest and hooks file, add a case to [`test.js`](test.js), and open a PR.

## Development

```bash
git clone https://github.com/Shaf2665/mem-mastero.git
cd mem-mastero
node test.js                 # unit + end-to-end tests: two machines, git hooks, setup, routing
claude plugin validate .
```

## License

[MIT](LICENSE)
