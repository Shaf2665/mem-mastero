# Unified Memory Implementation Plan

> **For agentic workers:** Use the existing parallel subagent workflow to implement and review the independent modules below. Steps use checkboxes for completion tracking.

**Goal:** Make Mem-mastero a single plugin for portable original sessions, safe cold archives, and useful durable project knowledge.

**Architecture:** Keep original sessions and verified archives separate from derived knowledge. Store small immutable, scoped memory records and persistent deletion markers, sync them through the configured private repository or folder, and expose progressive retrieval through CLI and stdio MCP tools. Capture assistant text locally; agents can save curated decisions and summaries using the same tools without another background model service.

**Tech Stack:** Node.js 18.17+, built-in modules, Git, authenticated GitHub CLI where already required. No new runtime package, database server, paid model service, or telemetry.

**Spec:** The user requested a current Claude-Mem comparison, an implementation plan, and implementation of the missing core capabilities so one plugin can manage sessions and memory. The scope and limits below are this plan's design decisions.

## Global constraints

- Preserve native transcripts and archive verification/cleanup behavior; never overwrite project instructions or native MEMORY.md with derived content.
- Keep company/personal stores and project identities isolated. Local reads and capture must work without network access.
- Redact private blocks and common secrets before storing or indexing derived memory. Original session sync remains byte-preserving and is not redacted by this feature.
- Treat retrieved text as untrusted historical data. Limit startup context and tool output; never preload full archives.
- Immutable records and sticky tombstones merge without timestamp-based resurrection. Forgetting active knowledge cannot erase existing Git history or original transcripts.
- Use isolated synthetic data for tests, not the user's real conversations. Preserve the pre-existing `.review-44o34A/` directory.
- Keep plugin manifests version-aligned; use the previously authorized main-branch workflow.

## Review focus

- Offline or inaccessible cloud storage must not prevent local capture/search/context.
- A stale machine must not resurrect a forgotten record during merge.
- Private tags spanning records, oversized JSONL lines, malformed cursors, and prompt-like archived text must not leak into trusted instructions.
- Imported exports can contain several projects, legacy field names, malformed rows, and secrets; require explicit project selection and report skipped/rejected entries.
- Native session formats, multiple local paths, and folder-store paths differ between machines; stable provenance and project identity must survive these differences.

## Task 1: Durable memory store and retrieval

Files: `memory-store.js`, `test-memory-store.js`.

- [x] Implement scoped immutable records and tombstones with bounded schemas, safe paths, content integrity, per-scope locks, and atomic writes.
- [x] Add explicit notes, exact get, weighted keyword search, chronological neighboring context, export/import, and deletion that wins against old peers.
- [x] Add validated bidirectional sync under a separate `knowledge` namespace; never use newest-mtime-wins for these records.
- [x] Test corruption, conflicts, folder portability, cross-store/project isolation, ranking, deduplication, and delete-versus-stale-peer behavior.

## Task 2: Private incremental capture

Files: `memory-privacy.js`, `memory-capture.js`, `test-memory-capture.js`.

- [x] Capture known assistant text from Claude/Codex/Copilot/Pi JSONL schemas with bounded reads and durable cursors.
- [x] Exclude raw user prompts and tool payloads by default; respect private turns and redact common credentials before creating observations.
- [x] Retain stable source agent/session/event identities and honest `captured` provenance; these are excerpts, not independently verified facts or AI-generated summaries.
- [x] Test replay, partial and oversized lines, replaced/truncated files, unsafe transcript paths, project mismatch, privacy boundaries, and cursor recovery.

## Task 3: Agent tools and migration

Files: `memory-mcp.js`, `memory-import.js`, corresponding tests, Claude/Copilot inline plugin manifests.

- [x] Expose memory search, timeline, batch get, save, and forget through bounded stdio MCP JSON-RPC using documented supported protocol versions.
- [x] Resolve project/store context afresh for every tool request; keep stdout protocol-only and validate tool arguments.
- [x] Import only selected-project observations and summaries from a Claude-Mem JSON export, with dry-run reports, legacy aliases, redaction, and repeat-safe IDs. Do not alter its live database or uninstall anything.
- [x] Test malformed messages, request/output bounds, scope, mutation annotations, mixed-project exports, repeat imports, and no-write previews.

## Task 4: Runtime, management, and integration

Files: `memory-runtime.js`, `memory-command.js`, `memory-view.js`, `sync.js`, command documentation and integration tests.

- [x] Add local capture/context controls, offline startup context, CLI add/edit/search/timeline/get/forget/capture/context/export/import/view operations, and a private local HTML browser.
- [x] Connect existing lifecycle hooks to capture and knowledge sync. Emit cached bounded historical context before cloud access, or newly pulled context on a first device; provide guidance for saving curated notes through the current agent.
- [x] Ship new helpers with the installed stable dispatcher and register MCP for Claude/Copilot without adding unsupported configuration to other hosts.
- [x] Add source-cited current comparison and user guidance; distinguish implemented core workflow from remaining semantic/vector retrieval and background synthesis.
- [x] Run the full isolated suite and independent safety reviews; exercise the viewer in Chromium, including inert hostile text and mobile layout.

Release gate: push the verified changes to `main` and report the Windows/macOS/Linux CI result in the completion message.

## Review improvements

Capture and migration publish validated batches, avoiding repeated full-store scans for every note. Malformed transcript rows fail closed for privacy until a new public user turn. Pause/resume controls must not backfill the paused interval. Existing cached context is emitted before network work; agents can search freshly synced records after startup.

## Follow-up quality work, separate from this core implementation

Evaluate retrieval on realistic historical questions before deciding whether optional embeddings and model-based consolidation justify their disk, latency, privacy, and provider costs. Claude-Mem's knowledge agents, collaboration, hosted service, and advanced integrations are not claimed as equivalent. Native archive retention/legacy Git-history migration also remains a separate data-management project.
