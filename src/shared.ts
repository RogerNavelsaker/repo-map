#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Position = { file: string; line: number; col: number };
export type Diagnostic = Position & {
  endLine?: number;
  endCol?: number;
  severity?: string;
  code?: string | number;
  source?: string;
  message: string;
};

export function resolveRepoRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git")) || existsSync(join(current, ".flox"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export function skillDir(importMetaUrl: string): string {
  return dirname(new URL(importMetaUrl).pathname);
}

export function parseCommonArgs(argv: string[]) {
  const args = [...argv];
  const jsonIndex = args.indexOf("--json");
  const json = jsonIndex >= 0;
  if (json) args.splice(jsonIndex, 1);
  const repoRootIndex = args.indexOf("--repo-root");
  let repoRoot: string | undefined;
  if (repoRootIndex >= 0) {
    repoRoot = args[repoRootIndex + 1];
    args.splice(repoRootIndex, 2);
  }
  return { args, json, repoRoot: resolveRepoRoot(repoRoot) };
}

export function printOutput(data: Json, json: boolean) {
  if (json) {
    console.log(JSON.stringify(data));
    return;
  }
  if (typeof data === "string") {
    console.log(data);
    return;
  }
  console.log(formatHuman(data));
}

export function fail(code: string, message: string, json = false): never {
  const payload = { error: code, message };
  if (json) {
    console.error(JSON.stringify(payload));
  } else {
    console.error(`${code}: ${message}`);
  }
  process.exit(1);
}

export function requireFile(file: string, repoRoot = process.cwd()): string {
  const resolved = isAbsolute(file) ? file : resolve(repoRoot, file);
  if (!existsSync(resolved)) fail("not_found", `File not found: ${file}`);
  if (!statSync(resolved).isFile()) fail("not_file", `Path is not a file: ${file}`);
  return resolved;
}

export function commandExists(command: string): boolean {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return true;
  }
  return false;
}

export function getAstGrepBinary(): string {
  if (commandExists("ast-grep")) return "ast-grep";
  fail("missing_ast_grep", "ast-grep is not installed. Add it to the flox environment and activate the environment.");
}

export async function runCommand(command: string[], cwd: string, stdin?: string) {
  const proc = spawn(command[0], command.slice(1), { cwd, stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  if (stdin) proc.stdin.write(stdin);
  proc.stdin.end();
  const code = await new Promise<number>((resolveCode, reject) => {
    proc.on("error", reject);
    proc.on("close", resolveCode);
  });
  return { code, stdout, stderr };
}

export function rel(file: string, repoRoot: string) {
  const resolved = resolve(file);
  return resolved.startsWith(repoRoot) ? resolved.slice(repoRoot.length + 1) : resolved;
}

export function extensionLanguage(file: string): string {
  const ext = extname(file);
  if (ext === ".rs") return "rust";
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  if (ext === ".java") return "java";
  if (ext === ".nix") return "nix";
  if (ext === ".toml") return "toml";
  if ([".yaml", ".yml"].includes(ext)) return "yaml";
  if (ext === ".json") return "json";
  if (ext === ".sh" || ext === ".bash" || ext === ".zsh") return "shell";
  if (ext === ".c") return "c";
  if ([".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"].includes(ext)) return "cpp";
  if (ext === ".h") return "c-header";
  return "unknown";
}

export function offsetAt(text: string, line: number, col: number): number {
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (let i = 1; i < line; i++) offset += (lines[i - 1]?.length ?? 0) + 1;
  return offset + Math.max(col - 1, 0);
}

export function positionFromOffset(text: string, offset: number): { line: number; col: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const slice = text.slice(0, clamped);
  const lines = slice.split(/\r?\n/);
  const line = lines.length;
  const col = (lines.at(-1)?.length ?? 0) + 1;
  return { line, col };
}

export function uriFromPath(file: string) {
  return new URL(`file://${resolve(file)}`).toString();
}

export function pathFromUri(uri: string) {
  return uri.startsWith("file://") ? new URL(uri).pathname : uri;
}

export function normalizeLocation(location: any): Position {
  const uri = location.uri ?? location.targetUri;
  const range = location.range ?? location.targetSelectionRange ?? location.targetRange;
  return {
    file: pathFromUri(uri),
    line: (range?.start?.line ?? 0) + 1,
    col: (range?.start?.character ?? 0) + 1,
  };
}

export function normalizeLocations(result: any): Position[] {
  if (!result) return [];
  if (Array.isArray(result)) return result.map(normalizeLocation);
  return [normalizeLocation(result)];
}

export function normalizeDiagnostics(file: string, diagnostics: any[]): Diagnostic[] {
  return (diagnostics ?? []).map((entry) => ({
    file,
    line: (entry.range?.start?.line ?? 0) + 1,
    col: (entry.range?.start?.character ?? 0) + 1,
    endLine: (entry.range?.end?.line ?? 0) + 1,
    endCol: (entry.range?.end?.character ?? 0) + 1,
    severity: diagnosticSeverity(entry.severity),
    code: entry.code,
    source: entry.source,
    message: entry.message,
  }));
}

function diagnosticSeverity(value: number | undefined) {
  switch (value) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return undefined;
  }
}

export type LspServerConfig = {
  name: string;
  command: string[];
  port: number;
  languageId: string;
  initializeOptions?: Record<string, unknown>;
};

type Pending = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
};

class LspTransport {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);

  constructor(command: string[], cwd: string) {
    this.child = spawn(command[0], command.slice(1), { cwd, stdio: "pipe" });
    this.child.stdout.on("data", (chunk) => this.onData(Buffer.from(chunk)));
    this.child.stderr.on("data", () => {});
    this.child.on("exit", (code) => {
      for (const [, pending] of this.pending) pending.reject(new Error(`LSP process exited with code ${code}`));
      this.pending.clear();
    });
  }

  notify(method: string, params: any) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: any) {
    const id = ++this.sequence;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise<any>((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private write(payload: any) {
    const body = Buffer.from(JSON.stringify(payload));
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(Buffer.concat([header, body]));
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const separator = this.buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const header = this.buffer.slice(0, separator).toString();
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) throw new Error("Missing Content-Length header");
      const length = Number(match[1]);
      const bodyStart = separator + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.slice(bodyStart, bodyEnd).toString();
      this.buffer = this.buffer.slice(bodyEnd);
      this.handleMessage(JSON.parse(body));
    }
  }

  private handleMessage(message: any) {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(message.error);
      else pending.resolve(message.result);
    }
  }
}

export async function serveLsp(config: LspServerConfig) {
  const repoRoot = resolveRepoRoot();
  const transport = new LspTransport(config.command, repoRoot);
  await transport.request("initialize", {
    processId: process.pid,
    rootUri: uriFromPath(repoRoot),
    capabilities: {
      textDocument: {
        definition: {},
        references: {},
        hover: {},
        diagnostic: {},
        callHierarchy: {},
      },
    },
    initializationOptions: config.initializeOptions ?? {},
  });
  transport.notify("initialized", {});
  const server = Bun.serve({
    port: config.port,
    idleTimeout: 255,
    fetch: async (req) => {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      try {
        const payload = await req.json();
        const result = await handleServiceRequest(transport, config, payload, repoRoot);
        return Response.json(result);
      } catch (error: any) {
        return Response.json({ error: error?.code ?? "lsp_error", message: error?.message ?? String(error) }, { status: 500 });
      }
    },
  });
  console.log(`${config.name} bridge listening on 127.0.0.1:${server.port}`);
}

async function handleServiceRequest(transport: LspTransport, config: LspServerConfig, payload: any, repoRoot: string) {
  const file = requireFile(payload.file, repoRoot);
  const text = readFileSync(file, "utf8");
  const uri = uriFromPath(file);
  transport.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: config.languageId, version: 1, text },
  });
  await Bun.sleep(250);
  const position = payload.line && payload.col
    ? { line: Number(payload.line) - 1, character: Number(payload.col) - 1 }
    : undefined;
  switch (payload.method) {
    case "definition":
      return normalizeLocations(await transport.request("textDocument/definition", { textDocument: { uri }, position }));
    case "references":
      return normalizeLocations(await transport.request("textDocument/references", {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
      }));
    case "hover":
      return await transport.request("textDocument/hover", { textDocument: { uri }, position });
    case "diagnostics": {
      const result = await transport.request("textDocument/diagnostic", {
        textDocument: { uri },
        identifier: `${config.name}-${Date.now()}`,
        previousResultId: null,
      }).catch(() => ({ items: [] }));
      return normalizeDiagnostics(file, result.items ?? result?.fullDocumentDiagnosticReport?.items ?? []);
    }
    case "calls": {
      const items = await transport.request("textDocument/prepareCallHierarchy", { textDocument: { uri }, position });
      const first = Array.isArray(items) ? items[0] : items;
      if (!first) return [];
      const raw = payload.direction === "in"
        ? await transport.request("callHierarchy/incomingCalls", { item: first })
        : await transport.request("callHierarchy/outgoingCalls", { item: first });
      return (raw ?? []).map((entry: any) => ({
        from: normalizeLocation(entry.from ?? entry.to),
        ranges: (entry.fromRanges ?? entry.toRanges ?? []).map((range: any) => ({
          line: (range.start?.line ?? 0) + 1,
          col: (range.start?.character ?? 0) + 1,
        })),
      }));
    }
    default:
      throw Object.assign(new Error(`Unsupported method: ${payload.method}`), { code: "unsupported_method" });
  }
}

export async function callLspService(config: LspServerConfig, payload: Record<string, unknown>, json = false) {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) fail(data.error ?? "lsp_service_error", data.message ?? `${config.name} service request failed`, json);
    return data;
  } catch (error: any) {
    fail("lsp_service_unavailable", `${config.name} service is not running. Start flox services and retry. (${error?.message ?? error})`, json);
  }
}

function formatHuman(value: Json, indent = 0): string {
  const pad = " ".repeat(indent);
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "(none)";
    return value
      .map((item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          return `${pad}- ${formatHuman(item, indent + 2).trimStart()}`;
        }
        return `${pad}- ${formatHuman(item, indent + 2)}`;
      })
      .join("\n");
  }
  return Object.entries(value)
    .map(([key, entry]) => {
      if (entry && typeof entry === "object") return `${pad}${key}:\n${formatHuman(entry as Json, indent + 2)}`;
      return `${pad}${key}: ${formatHuman(entry as Json, indent + 2)}`;
    })
    .join("\n");
}
