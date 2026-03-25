---
name: repo-map
description: Build a task-focused repository context pack before using language-specific code-intel tools.
---

# Repo Map

Use this skill first when you need orientation rather than exact symbol resolution.

It is the repo-scoping step in the workflow:

- `repo-map`: narrow a task to likely files, modules, and imports
- `code-intel-ts`: resolve precise TypeScript structure or semantics
- `code-intel-rust`: resolve precise Rust structure or semantics

## When To Use It

- Start here if the task is broad: feature work, bug triage, ownership, subsystem discovery.
- Use it when the agent only has a topic, glob, or rough path and needs candidate files.
- Use `--repo-root` when running from a nested worktree or outside the target checkout.

## Commands

```bash
repo-map map "**/*" --lang rs --lang ts --json
repo-map brief "apps/**/*" --lang ts --lang js --top 16 --max-files 8 --entrypoint app --entrypoint server --exclude "**/*.test.ts" --json
repo-map query "**/*" --term auth --term token --lang rs --lang ts --exclude "docs/**" --limit 12 --json
repo-map brief "**/*" --lang py --lang go --include-generated --repo-root /path/to/worktree --json
```

## Output Contract

- Default output is a human-readable repo briefing.
- `map` returns a machine-friendly context pack with `repoRoot`, `cwd`, `files`, and follow-up suggestions.
- `brief` returns a condensed subsystem summary and likely entrypoints.
  It supports `--top`, `--max-files`, and repeated `--entrypoint` hints for context budgeting.
  Each file now includes a compact `why` summary plus representative symbols/imports instead of dumping full metadata.
- `query` ranks candidate files by topic terms such as `auth`, `billing`, or `worker`.
  Ranking is intentionally simple:
  `file +5`, `module +4`, `symbol +3`, `import +2`.
- `map`, `brief`, and `query` now emit a `handoff` block in JSON mode with:
  `recommendedTool`, `recommendedMode`, `recommendedCommand`, `candidateFiles`, `primaryFile`, `secondaryFiles`, `handoffReason`, and `confidence`.
- File discovery prefers `rg --files`, so gitignore-style filtering works in normal repos.
- `--exclude <glob>` removes repo paths from discovery.
- generated/vendor-like paths are excluded by default; use `--include-generated` to opt back in.
- Metadata falls back to regex extraction if `ast-grep` is unavailable.

## Agent Workflow

1. Use `repo-map brief` to get a fast subsystem summary sized for agent context.
2. Use `repo-map query` when you have topic words but not exact files.
3. Use `repo-map map` when you want the full file-level context pack.
4. Read the `handoff` block and start with `primaryFile`.
5. If `recommendedTool` is `code-intel-ts` or `code-intel-rust`, run the suggested `ast` command first.
6. Escalate to `lsp` only if the structural pass is not precise enough.
