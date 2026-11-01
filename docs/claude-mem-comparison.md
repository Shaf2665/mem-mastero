# Mem-mastero and Claude-Mem

Comparison checked against official Claude-Mem documentation and repository sources on 2026-11-01. Mem-mastero features below describe v0.13.0. This is a capability comparison, not a retrieval-quality benchmark.

Mem-mastero brings original sessions, useful project knowledge, verified Claude archives, semantic AI ranking, and automatic summaries into one plugin. Its AI features use an installed, already signed-in Codex, Claude Code, or Copilot client. It can cover that combined workflow without Claude-Mem or a separate API key. Claude-Mem's vector-search architecture, interfaces, and advanced workflows remain different; no benchmark here establishes that Mem-mastero has better recall, summary quality, or lower cost for every workload.

## What changed recently

| Release | In everyday terms |
|---|---|
| v0.9 | Safer sync and privacy checks, plus an updater for existing installations. |
| v0.10 | Measure disk use; upload inactive Claude sessions, verify the committed cloud copy, then remove native local files; restore them without overwriting different local work. |
| v0.11 | Keep small project/session/revision references. Download a selected archive only for read-only recall, verify it, and remove the temporary download before returning. |
| v0.12 | Keep searchable project notes, extract assistant observations, inject bounded startup context in Claude/Codex, provide memory tools, sync notes and forget markers, inspect an offline viewer, and migrate selected Claude-Mem exports. |
| v0.13 | Use the existing signed-in coding client to find memories by meaning and automatically summarize saved notes. Keep source references, report search coverage/fallback, and suppress summaries derived from forgotten sources. |

Archiving removes native Claude files after verification. It does not erase old copies from ordinary sync clones, Git history, other machines, or already exported files. The graph describes archive relationships; it is not a semantic graph of every concept discussed.

## What Claude-Mem already provides

Claude-Mem captures session activity, processes it into observations and session summaries, and injects selected memory into future sessions. Its architecture includes a worker, SQLite, model-provider integration, and optional Chroma semantic search. Mem-mastero extracts assistant observations locally, then an optional separate worker summarizes bounded batches of already filtered notes using the selected signed-in client. It preserves the original notes and labels generated interpretations with their source IDs. The workflows overlap without sharing the same implementation or claiming identical summary quality. [Architecture](https://docs.claude-mem.ai/architecture/overview)

Claude-Mem supports a progressive retrieval workflow: search a compact index, inspect nearby history, and request full selected observations. Mem-mastero offers the same broad index → timeline → selected-detail interaction pattern. Its optional semantic mode asks the selected coding client to rank a limited page of memory excerpts by meaning; hybrid mode combines that with keyword ranking. This is AI reranking, not a vector index or an exhaustive scan. Responses report coverage and pagination, and provider failures fall back to keyword results. This does not establish equivalent relevance or token savings. [Search architecture](https://docs.claude-mem.ai/architecture/search-architecture), [search tools](https://docs.claude-mem.ai/usage/search-tools)

Claude-Mem is no longer limited to Claude Code: its installation instructions describe several other harnesses. It also offers optional cmem.ai cloud synchronization for observations, summaries, and prompts. Cross-agent support and cloud sync alone are therefore not unique Mem-mastero advantages. Mem-mastero's distinction is user-owned GitHub/Drive storage and preserving original agent sessions, including verified Claude cold archives. [Installation](https://docs.claude-mem.ai/installation), [cloud sync](https://docs.claude-mem.ai/cloud-sync)

Claude-Mem's local My Work and memory interfaces support ongoing inspection, while Knowledge Agents can query selected observation collections. Mem-mastero provides a searchable, self-contained HTML snapshot with CLI correction and forgetting; it is not a live dashboard or a corpus-query agent. [My Work](https://docs.claude-mem.ai/usage/my-work), [Knowledge Agents](https://docs.claude-mem.ai/usage/knowledge-agents)

Both systems need careful privacy boundaries. Claude-Mem documents private tags and optional secret redaction. Mem-mastero applies private-tag filtering and pattern-based secret redaction to derived knowledge. Original session backups remain byte-preserving and can contain sensitive information. Neither filtering nor a private repository guarantees that all secrets have been detected. [Claude-Mem private tags](https://docs.claude-mem.ai/usage/private-tags), [auto-redaction](https://docs.claude-mem.ai/usage/auto-redaction)

## What v0.13 implements

| Capability | Implementation and boundary |
|---|---|
| Typed project memories | Decisions, bug fixes, discoveries, preferences, constraints, progress, summaries, and observations. Each has an immutable ID, date, project/store scope, provenance, and source fields. |
| Automatic capture | Incremental, bounded extraction of assistant-message observations when a supported hook supplies the transcript. No raw tool payloads or user prompts are saved as derived knowledge. Capture remains local; optional AI synthesis is a separate step. |
| Automatic AI summaries | Existing signed-in Codex/Claude Code/Copilot client, enabled per project/store and machine. At most three batches per worker run, at least 60 seconds between attempt starts, up to 20 notes per batch. Source IDs and generated provenance accompany unverified model interpretations. |
| Agent-curated knowledge | A person or the active agent can save concise durable facts through CLI or `memory_save`. Claims still need verification; an agent-authored note is not automatically authoritative. |
| Retrieval | Ranked keywords, optional AI semantic ranking or hybrid search, timeline, selected details, and kind/agent/date filters. Bounded candidate pages and excerpts have reported coverage; no embedding index or exhaustive-corpus guarantee. |
| Startup context | Claude/Codex hooks emit bounded local project notes; default 4,000 characters. Cached notes are emitted before cloud sync; a first device without notes gets context after its initial pull. Priority and recency select the default context; search/get can retrieve newer synced notes. Copilot/Pi do not receive automatic startup context in this release. |
| MCP | Local stdio tools `memory_search`, `memory_timeline`, `memory_get`, `memory_save`, `memory_forget`, `memory_summarize`. Each requires absolute project `cwd`. Claude/Copilot manifests register the server; other clients can launch it through their own supported MCP configuration. |
| Synchronization | Immutable records and sticky forget markers share the selected store. Source deletion hides dependent summaries. Content-free summary receipts prevent regeneration after deletion, including different wording generated on another device. Settings and AI caches remain local. |
| Privacy controls | Private tags, recognized-secret redaction, and local capture/context switches. These do not pause original-session sync or erase its contents. |
| Inspection and correction | Private offline viewer snapshot; CLI edit, forget, export, and scoped import. Editing creates a replacement and forgets the old record. Existing snapshots and historical copies remain. |
| Claude-Mem migration | Preview and import observations/summaries for an explicitly selected source project. Current and legacy session-ID fields are supported. Prompts/tool payloads are excluded, malformed records are reported, repeats are skipped. |
| Archive connection | Notes can carry a verified graph's `archive:<hash>` source reference. Reading a note does not fetch its archive; explicit recall verifies and temporarily reads the needed source. |

The stdio server implements MCP's `2025-11-25` initialization lifecycle and compatible `2025-06-18`, `2025-03-26`, and `2024-11-05` versions. It does not claim the newer `2026-07-28` stateless protocol. [Implemented lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [newer versioning model](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)

The plugin registration follows the documented inline `mcpServers` fields for [Claude Code](https://code.claude.com/docs/en/plugins-reference#mcpservers) and [Copilot's legacy plugin format](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference). No undocumented Codex manifest fields are added. [AI setup and operating limits](ai-memory.md) describe the native client configuration. Update all devices to v0.13 or later before syncing generated records.

## Migration without losing the originals

Create a portable JSON export using Claude-Mem's own export tooling. Keep that export and the original installation until the selected memories have been checked in Mem-mastero. Its current exporter includes observations, summaries, sessions, and prompts; Mem-mastero intentionally imports only observations and summaries. [Export/import guide](https://docs.claude-mem.ai/usage/export-import), [export source](https://github.com/thedotmack/claude-mem/blob/main/scripts/export-memories.ts)

From the target project's repository:

```bash
npx --yes github:Shaf2665/mem-mastero memory import-claude-mem ./claude-mem-export.json --source-project "my-app" --dry-run
npx --yes github:Shaf2665/mem-mastero memory import-claude-mem ./claude-mem-export.json --source-project "my-app"
npx --yes github:Shaf2665/mem-mastero memory search "important decision"
npx --yes github:Shaf2665/mem-mastero memory view
npx --yes github:Shaf2665/mem-mastero memory sync
```

The source project name is an explicit mapping into the current target repository. Preview writes nothing. Reports show accepted candidates, skipped duplicates/other projects, and rejected records without reproducing their raw text. No live Claude-Mem database is read or changed, and no other plugin is disabled automatically. Current import field compatibility was checked against Claude-Mem's [import validation](https://github.com/thedotmack/claude-mem/blob/main/src/services/worker/http/routes/DataRoutes.ts).

## What to improve next

The implementation now covers sessions, archives, searchable knowledge, and opt-in AI synthesis in one plugin. The next priorities are measurable quality and operating scale:

1. **Evaluate recall on representative questions.** Check relevant-memory retrieval, citations, stale/conflicting notes, private-content exclusion, context size, startup latency, and storage growth. Existing tests establish behavior and safety properties, not superiority to another plugin.
2. **Improve semantic candidate selection and summary quality.** Evaluate paraphrases, multilingual questions, older facts beyond the first candidate page, hallucinations, and conflicting sources. Compare the implemented AI ranking with keyword-only retrieval using the same corpus and questions. Any future full-corpus index should justify its storage and operating costs.
3. **Expand agent integration.** Verify live hook and MCP behavior across supported client versions, then add startup context where the client supports it. Additional session adapters need their own tested ownership and recovery rules.
4. **Improve large collections and lifecycle management.** Add bounded indexing/retention, stronger contradiction handling, and management views. Preserve recoverability and distinguish active-memory forgetting from physical historical-data deletion.
5. **Address advanced workflows separately.** Live dashboards, team permissions, corpus agents, and richer semantic relationships need explicit design and tests; v0.13 does not claim those features.

Users who need native session sync, safe Claude archival, searchable project knowledge, and bounded AI summaries can use Mem-mastero alone for that scope. Users depending on Claude-Mem's vector-search behavior, Knowledge Agents, or advanced interfaces should evaluate the replacement on their actual questions. Existing-client AI calls still consume that account's allowance and follow its data policies; using OAuth does not make processing local or unlimited.
