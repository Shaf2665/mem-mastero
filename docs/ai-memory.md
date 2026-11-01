# AI search and summaries

Mem-mastero v0.13 adds meaning-based search and automatic summaries through an installed, signed-in **Codex, Claude Code, or GitHub Copilot CLI**. The client handles its existing login. Mem-mastero does not ask for a separate API key or store OAuth tokens in memory configuration.

These features are optional and off until configured for the current project/store on this machine. The selected client sends the supplied question and memory excerpts to its model service, under that account's plan, usage limits, and data policies. Existing subscription access does not mean unlimited or free requests.

**Update every device to v0.13 or later before syncing generated summaries.** Older readers do not understand generated provenance, source lineage, or summary deletion receipts. Existing v0.12 notes remain readable after updating.

## Connect an existing login

Install and sign in to the coding client normally. Its command must be available on `PATH` in the environment that launches the agent and its hooks. Run Mem-mastero commands inside the target project repository, with its memory store already configured:

```bash
npx --yes github:Shaf2665/mem-mastero memory ai-settings --provider codex --semantic on --summaries on --automatic on
npx --yes github:Shaf2665/mem-mastero memory ai-status
```

Use `--provider claude` or `--provider copilot` to select that existing client instead. `--model MODEL` optionally selects a model supported by the chosen client and account; omit it to use the client's default. No API endpoint, key, token, or arbitrary executable belongs in this configuration.

Inspect or disable the features independently:

```bash
npx --yes github:Shaf2665/mem-mastero memory ai-settings
npx --yes github:Shaf2665/mem-mastero memory ai-settings --automatic off
npx --yes github:Shaf2665/mem-mastero memory ai-settings --semantic off --summaries off --automatic off
```

`automatic off` stops automatic summary work while keeping explicit summarization available when `summaries` remains on. Turning off `semantic` retains keyword search. AI settings, job state, and search caches are machine-local; knowledge records and deletion receipts use the existing selected memory store.

The adapters require supported non-interactive client capabilities. They isolate temporary work, restrict tools/customizations, prevent Mem-mastero from capturing its own processing, bound output and execution time, and clean up temporary processing files. If a failed client cannot be stopped, its owned temporary directory is retained to avoid deleting files under a live process. An unavailable command, expired login, unsupported client capability, or account limit produces a bounded failure instead of silently selecting a different provider. This is ordinary use of the installed clients, not a copied OAuth token sent to an unofficial endpoint.

Copilot processing uses an isolated temporary `COPILOT_HOME`. Its native client must be able to resolve the existing sign-in there, for example through its supported keychain or GitHub CLI authentication. If credentials exist only in the old Copilot configuration and are not discoverable in the isolated session, processing stops before sending memory content. Mem-mastero does not copy those credentials into the temporary home. Sign in with `gh auth login` through GitHub CLI when supported by the installed Copilot client, or choose the already signed-in Codex/Claude provider.

## Search by meaning

```bash
npx --yes github:Shaf2665/mem-mastero memory search "How do we avoid repeating failed requests forever?" --mode hybrid
npx --yes github:Shaf2665/mem-mastero memory search "retry limit" --mode keyword
npx --yes github:Shaf2665/mem-mastero memory search "What was the resilience decision?" --mode semantic --candidates 80
```

- `keyword` performs local ranked keyword search without a model call.
- `semantic` asks the configured client to select relevant memories by meaning, including paraphrases, from a bounded candidate page.
- `hybrid` combines semantic and keyword rankings.
- `auto`, the default, uses hybrid search when semantic AI is enabled and keyword search otherwise.

This is **AI semantic reranking, not an embedding/vector index**. Each call orders keyword hits first, then other recent notes, and sends limited excerpts from that page. The default candidate limit is 80, configurable from 1 to 200; a 24 KiB prompt budget can reduce the actual number. Excerpts can omit relevant information. This is not an exhaustive search of every saved note or archived transcript.

Results include `modeUsed`, optional `fallback`, and `coverage` with `considered`, `total`, and `nextOffset`. If `nextOffset` is present, continue using that returned offset with the same query and filters:

```bash
npx --yes github:Shaf2665/mem-mastero memory search "What was the resilience decision?" --mode semantic --offset 80 --candidates 80
```

Replace `80` after `--offset` with the actual returned `nextOffset`; a byte-limited page may be smaller. Changes to the memory collection can change pagination order. `--kind`, `--agent`, `--from`, `--to`, and `--limit` still apply. A missing match does not prove that the whole history lacks an answer.

The model can return only IDs from its supplied page and bounded relevance scores. Returned titles, excerpts, and source metadata come from stored records. Provider failures or invalid model output fall back to local keyword results and report that fallback. Use `memory get ID` to read selected full notes and check their sources.

Semantic caches contain hashed request identities and selected IDs/scores, not plaintext query text or new copies of note bodies. They are scoped locally, capped at 32 entries/512 KiB, and expire after six hours. Immutable candidate IDs, configuration, and filters bind each cache entry; active visibility is checked again before returning cached or fresh results.

## Generate summaries

```bash
npx --yes github:Shaf2665/mem-mastero memory summarize --dry-run
npx --yes github:Shaf2665/mem-mastero memory summarize --limit 20
npx --yes github:Shaf2665/mem-mastero memory search "pending decisions" --kind summary
```

Preview returns the selected source IDs without calling the model or writing a summary. An explicit run processes at most one batch of 1–20 uncovered active memories. Each source excerpt is bounded, and the combined source input is capped at 24 KiB. Generated summaries are excluded as new summary inputs. The response contains a short summary, decisions, fixes, and open questions, validated against the selected source IDs and filtered for private blocks and recognized secrets again.

Generated records have `provenance: generated` and `source.memoryIds`. They remain **unverified model interpretations**. Source IDs establish where the inputs came from; they cannot prove that a model's interpretation is correct. Read the cited notes before treating an important conclusion as current fact.

When `automatic` and `summaries` are on, lifecycle hooks schedule a separate worker after capture and at startup. A worker makes at most three summary batches, with at least 60 seconds between attempt start times. Each batch covers at most 20 notes. Per-project ownership prevents overlapping automatic workers. A remaining backlog is eligible on a later hook; the worker is not a permanent daemon. Failures leave original notes available, and `memory ai-status` reports progress and whether syncing is pending.

Pausing local capture also pauses automatic summaries, including publication when capture is paused during a model call. Explicit `memory summarize` can still summarize already saved notes while capture is paused. Disabling summaries or changing the selected provider during generation prevents that result from being published.

## Sources, forgetting, and synchronization

Each summary's recipe is bound to its source IDs and provider configuration. Repeated work is skipped. If two devices generate different wording for the same recipe, their merge selects one deterministic active result.

Forgetting a source hides its dependent summaries from search, get, context, timeline, and exports. This applies transitively to notes with source lineage. A summary whose sources have not arrived yet also remains hidden. Forgetting a generated summary leaves a content-free receipt containing its recipe and source IDs, so another device or a repeated import cannot regenerate alternate wording to bypass that deletion.

Forgetting is still not physical erasure. Original transcripts, retained record files, old exports/viewer snapshots, Git history, and disconnected copies can retain data. A device can learn another device's deletion only after syncing.

Provider processing receives already-filtered knowledge excerpts and filtered search queries; it does not download cloud archives or read original transcripts. Pattern-based redaction cannot guarantee that every sensitive fact or credential has been detected. Review the notes and the selected client's data policy before enabling AI for a sensitive project.

## Troubleshooting

- **Keyword fallback:** inspect `fallback`, confirm the selected client is installed and signed in, and retry explicitly. Keyword search and saved notes remain available.
- **`provider_error` or `invalid_output`:** the model request failed or did not satisfy the bounded response contract. No generated summary is published. Correct the login/client issue and run `memory summarize` again.
- **`empty`:** no uncovered active sources are pending. Previously summarized inputs, including inputs of a forgotten summary, are not automatically summarized again.
- **`sources_changed` or `settings_changed`:** a source was forgotten, capture/AI was paused, or provider configuration changed while the model was working. The result was not published.
- **Partial search coverage:** use the returned `nextOffset`, narrower filters, or selected full-note retrieval. Increasing `--candidates` cannot override the prompt byte cap.

For a capability comparison and migration from Claude-Mem, see [Mem-mastero and Claude-Mem](claude-mem-comparison.md).
