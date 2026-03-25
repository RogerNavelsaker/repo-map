# repo-map

Lightweight repository mapper for Rust and TypeScript codebases.

This is the standalone source repo for the `repo-map` Bun CLI. Nix packaging lives separately in `nixpkg-repo-map`.

## Runtime

- Version: `0.1.0`
- Binary: `repo-map`
- Entrypoint: `src/cli.ts`
- Description: lightweight repository mapper for Rust and TypeScript codebases

## What This Repo Does

- Exposes the canonical `repo-map` binary
- Keeps runtime code under `src/` and agent-facing guidance under `skills/`
- Uses `rg --files` when available for ignore-aware discovery
- Exposes three task-oriented modes: `map`, `brief`, and `query`
- Emits structured handoff guidance for `code-intel-ts` and `code-intel-rust` in JSON mode

Cross-tool flow:

1. Use `repo-map brief` or `repo-map query` to narrow the task.
2. Read `handoff.primaryFile` and `handoff.recommendedTool`.
3. Start with the suggested `ast` command from `handoff.recommendedCommand`.
4. Escalate to `lsp` only when semantic resolution is needed.
