---
description: Find metadata-only references to archived Claude sessions without downloading their contents
---

From the user's project repository, inspect the archive graph:

```bash
npx --yes github:Shaf2665/mem-mastero graph --json
```

The graph links the project to its sessions and immutable archive revisions. It keeps metadata such as session IDs, dates, sizes, and file names; it does not keep transcript content. An existing cached graph can be read offline. If no cache exists, the command builds it from cloud manifests. To discover newer cloud archives, refresh it explicitly:

```bash
npx --yes github:Shaf2665/mem-mastero graph --refresh --json
```

Refresh checks the manifests in the project's configured private GitHub memory repository without downloading archive payloads. Use `--query "text"` to narrow the metadata results. Matching is case-insensitive across project/session IDs, node IDs, revisions, dates, and the graph's file paths; every whitespace-separated query term must match. The graph keeps up to 128 sorted file paths per archive and sets `pathsTruncated` when there are more. This is metadata matching, not semantic search across conversations, so absence from query results does not prove a conversation never discussed the topic.

When older history is relevant to the user's task, identify the matching session and revision, then use `/mem-mastero:recall` or the `recall` command with its `archive:<hash>` node ID. Prefer that node ID over a bare session ID when a particular revision matters. Do not download every archive or treat the existence of a reference as a request to read it.

Graph references are bound to the configured memory repository and project. Never replace a failed reference with a guessed repository, URL, local file path, or another project's session. If no result matches, explain that the graph contains only metadata and ask for a session ID, date, or file name that can identify the requested history.
