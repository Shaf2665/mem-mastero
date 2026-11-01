# Claude storage and archive implementation plan

**Goal:** Measure local storage and safely archive and restore inactive Claude Code sessions using the configured private GitHub memory repository.

**Architecture:** Keep immutable, compressed session snapshots on the separate `mem-mastero-archives-v1` branch, accessed through GitHub's API without cloning it. A local eviction registry prevents ordinary sync from restoring archived sessions. Before deleting anything, independently download and verify every archived byte, check that local files are unchanged, and require Claude to be stopped.

**Tech stack:** Dependency-free Node.js 18.17+, Git, authenticated GitHub CLI; Windows, Linux, macOS.

**Spec:** The approved proposal in this chat: storage measurement, safe explicit archive/restore for Claude Code, verification before removal, comprehensive tests, push to main.

## Scope and decisions

- Explicit CLI only: `storage [--json]`, `archive [--session ID | --older-than DAYS] [--dry-run]`, `archive --list`, `restore ID [--revision SHA256]`. Default age is 30 days; no automatic deletion hooks.
- Archive current project's Claude transcript, project session sidecars, file-history and known session-specific assets. Keep auto-memory resident. Preserve exact file bytes; restore with current local mtimes to avoid immediate native age-based cleanup.
- No overwrite of differing local files, symlinks, unsafe paths or uncertain liveness. Offline or failed verification keeps original files. Partial deletion remains recoverable from the verified cloud revision.
- Archive state is per machine/profile/project/store. Acquire the same local archive lock in ordinary Claude sync and archive/restore.
- New clones and normal pulls fetch only their normal branch. Existing legacy clones/history are measured and retained; this version does not rewrite history or promise to reclaim their bytes.
- Empty GitHub repositories must be initialized by normal setup/sync first. Archive branch commits are append-only, with non-force updates and bounded concurrency retries.
- This is a transcript/known-assets archive, not a workspace backup or a native remote session-picker integration. Graph search, automatic retention, resume launching, Drive archiving and other agents are deferred.

## Tasks and interfaces

- [x] `archive-store.js`, `test-archive-store.js`: `createArchiveStore(store, options)` exposes synchronous publishSnapshot, listSnapshots, readManifest and downloadSnapshot. Tests cover private/account routing, API failures, racing writers, pinned reads and malicious paths.
- [x] `claude-files.js`, `test-claude-files.js`: scanStorage, discoverSessions and assertClaudeStopped; byte inventory, known companion discovery and fail-closed process checks. Tests use synthetic homes and injected process inventories.
- [x] `archive.js`, `archive-state.js`, `test-archive.js`: bounded compression, manifests, verification, eviction journal, conflict-safe restoration and CLI validation. Test interrupted upload, corrupt remote data, local mutation, live Claude, missing/differing targets and malformed state.
- [x] `sync.js`, `test-archive-sync.js`, `test-recovery.js`: dispatch commands with failure exit codes; coordinate sync locks and suppress local evictions; single-branch clone/fetch; package helper modules with stable hook script.
- [x] README, command skills, manifest versions and runner: describe safe operation, measured versus retained bytes, compatibility and limitations; run all local suites. Platform CI runs after the authorized push.

## Review focus

1. Verify remote contents rather than trusting local commit/upload success.
2. No deletion after any file or process state changed; preserve files on partial failure.
3. Reject path traversal, Windows special names, case collisions and symlink ancestors before writing or removing native files.
4. Concurrent ordinary sync must neither rehydrate an eviction nor overwrite a restored revision.
5. Avoid archive payloads in persistent clones; report legacy bytes honestly and keep older-machine compatibility limits explicit.

## Execution ledger

- User explicitly authorized implementation and direct push to main; no additional approval gate.
- Parallel owners: backend, inventory, root transaction/integration; separate read-only safety reviewer.
- Ruling: retain existing legacy clone/history, because deleting or rewriting it risks unpushed data. Report its size separately; native session reclamation is independently measurable.
- Review fixes: quarantine originals before final verification/removal; recover partial moves without replacing newer data; handle interruption between hard-link publication and unlink; reject every manifest ancestor collision; detect Node/Bun Claude launchers.
- Added `archive --recover` for offline recovery of interrupted removal. Archive readback hashes decompressed chunks without writing a full reconstructed copy, and reuses upload staging space.
- Verification: full local test runner, synthetic GitHub object API, real CLI with isolated homes/local bare Git stores, platform process adapters, and adversarial filesystem interleavings. Actual read-only GitHub response parsing and local storage inventory smoke checks passed. No real session was archived or removed and no cloud archive was written during testing.
