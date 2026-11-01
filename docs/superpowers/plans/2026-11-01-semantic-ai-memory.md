# Semantic Search and Automatic Summaries Implementation Plan

> **For agentic workers:** Use the parallel provider, retrieval, summary/store, and integration tasks below. Each task has independent tests and receives a second review.

**Goal:** Add useful meaning-based retrieval and automatic, source-linked summaries to Mem-mastero using an existing signed-in coding-agent CLI.

**Architecture:** The user explicitly chose existing Codex, Claude Code, or Copilot OAuth. Invoke supported native interfaces with tools/customizations disabled; never extract, copy, or repurpose OAuth tokens. Use the model to rank bounded memory candidates, rather than claiming an embedding API is available through those subscriptions. Summarize already-filtered knowledge into generated records whose source dependencies remain visible and enforce forgetting. Ordinary keyword search and session/archive behavior stay available without AI.

**Tech Stack:** Node built-ins, local stdio child processes, existing agent CLIs, existing scoped immutable memory records. No vector database, model download, direct model API key, or additional background service.

**Spec:** The user's approved request is semantic search plus automatic AI summaries, tested and pushed directly to main. Their provider choice is existing Codex/Claude Code/Copilot OAuth.

## Constraints

- Configuration and derived ranking caches are local to a project/store; never sync credentials, provider configuration, raw queries, or temporary AI sessions.
- AI use is explicitly enabled per project and consumes the selected account's ordinary usage allowance. Do not silently switch accounts/providers or fall back to an API key.
- Send only bounded, privacy-filtered derived knowledge. Do not fetch cold archives or read raw native transcripts for AI requests.
- Treat notes and model output as untrusted. Validate source IDs, schemas, lengths, and numeric scores. No generated tool execution.
- Disable external tools, user hooks/plugins, instructions, and persistent sessions where supported. Fail closed for unsupported client capabilities.
- Keep keyword search usable on provider absence, authentication failure, timeout, invalid output, or disabled AI. Report partial semantic coverage honestly.
- Never claim guaranteed factual accuracy, exhaustive semantic recall, or measured superiority to Claude-Mem.
- Preserve existing `.review-44o34A/` and test only synthetic data. User-authorized branch is main.

## Tasks

- [x] Implement strict local AI configuration, native provider adapters, bounded process transport, cancellation, and owned temporary-file cleanup.
- [x] Add meaning-based ranking and hybrid keyword/AI retrieval, honest candidate coverage/pagination, bounded local caches, and fallback behavior.
- [x] Add generated-summary provenance, source lineage, deterministic job identity, source-forgetting propagation, and content-free receipts that prevent forgotten-summary regeneration across devices.
- [x] Add automatic background jobs with concurrency and usage bounds, recursion protection, status reporting, retry behavior, and normal note sync after generation.
- [x] Expose configuration, semantic search, summary preview/generation, and status through CLI/MCP; keep startup context local and fast.
- [x] Test provider isolation, malformed output, auth failures, timeouts, privacy, prompt injection, stale/forgotten sources, settings changes, restart/replay, sync, and hooks.
- [x] Run synthetic live-provider smoke tests where the existing login is usable; distinguish unavailable providers from simulated transport coverage.
- [x] Update user guidance and comparison and align release metadata to v0.13.0.

## Validation and release gate

The synthetic live fixture passed with all three existing native sign-ins: Codex, Claude Code, and Copilot. Each ranked the intended note first for a question with no keyword matches, generated a summary citing all three supplied sources, cleaned its temporary work, and hid the summary after a source was forgotten. This small functional check is not a retrieval-quality benchmark or a comparison against Claude-Mem. No real project memories were processed or migrated.

Final integration review found no release blockers. Claude plugin validation passed with the existing missing-icon warning. Run the complete isolated suite before committing, push directly to the user-authorized `main`, and confirm the Windows/macOS/Linux Test workflow for that commit. The completion report records the resulting commit and CI outcome.

## Review focus

The highest-risk boundaries are inherited agent capabilities, accidental API-key billing, model-created unsupported facts, stale results after forgetting, repeated automatic calls, and temporary session accumulation. All receive explicit failure-path tests. Semantic ranking examines a bounded candidate page and returns coverage metadata; it is not a full-corpus vector index.
