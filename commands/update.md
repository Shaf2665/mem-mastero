---
description: Update mem-mastero in installed coding agents and refresh its Git-hook script
---

Update mem-mastero on this machine:

```bash
npx --yes github:Shaf2665/mem-mastero update
```

The command downloads the latest version, updates existing mem-mastero installations in Claude Code, Codex, Copilot CLI and the global Pi package list, and refreshes the Git-hook script if mem-mastero owns the global Git hooks. It preserves memory stores and routing rules. It does not install mem-mastero into new agents or update unrelated plugins.

Show the per-agent results. If one update fails, the command reports failure while keeping successful updates; fix the reported issue and rerun the command. Disabled Codex installations are skipped because Codex's install command would enable them.

Tell the user to restart their coding agents. If Codex asks to trust updated hooks, review them under `/hooks`.
