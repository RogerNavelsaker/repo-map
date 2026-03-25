#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";
import { commandExists, extensionLanguage, parseCommonArgs, printOutput, runCommand } from "./shared.ts";

type RepoEntry = {
  file: string;
  language: string;
  module: string;
  imports: string[];
  symbols: Array<{ line: number; signature: string }>;
  metadataSource: string;
  score?: number;
  reasons?: string[];
};

type RepoBriefEntry = {
  file: string;
  language: string;
  module: string;
  score: number;
  why: string[];
  symbolCount: number;
  importCount: number;
  sampleSymbols: string[];
  sampleImports: string[];
};

type Handoff = {
  recommendedTool: string | null;
  recommendedMode: string | null;
  recommendedCommand: string | null;
  candidateFiles: string[];
  primaryFile: string | null;
  secondaryFiles: string[];
  handoffReason: string;
  confidence: "high" | "medium" | "low";
};

const { args, json, repoRoot } = parseCommonArgs(process.argv.slice(2));
const useAst = commandExists("ast-grep");
const [commandOrPattern, ...rest] = args;
const command = isCommand(commandOrPattern) ? commandOrPattern : "map";
const commandArgs = command === "map" ? args : rest;
const parsed = parseRepoMapArgs(commandArgs);
const files = await listFiles(repoRoot, parsed);
const entries = files
  .filter((file) => {
    if (parsed.languages.length === 0) return true;
    return parsed.languages.includes(normalizeLanguage(extensionLanguage(file)));
  })
  .map((file) => mapFile(file));

switch (command) {
  case "map":
    printOutput(repoMapPayload(entries, parsed), json);
    break;
  case "brief":
    printOutput(repoBriefPayload(entries, parsed), json);
    break;
  case "query":
    if (parsed.terms.length === 0) printUsageAndExit(json);
    printOutput(repoQueryPayload(entries, parsed), json);
    break;
  default:
    printUsageAndExit(json);
}

function isCommand(value?: string) {
  return value === "map" || value === "brief" || value === "query";
}

function mapFile(file: string): RepoEntry {
  const relPath = relative(repoRoot, file);
  const text = readFileSync(file, "utf8");
  const language = normalizeLanguage(extensionLanguage(file));
  return {
    file: relPath,
    language,
    module: modulePath(relPath),
    imports: extractImports(text, language),
    symbols: extractSymbols(text, language),
    metadataSource: useAst ? "ast-grep-enabled" : "fallback-regex",
  };
}

function repoMapPayload(entries: RepoEntry[], parsed: ReturnType<typeof parseRepoMapArgs>) {
  const ranked = entries
    .slice()
    .map((entry) => ({ ...entry, score: briefScore(entry, parsed) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return {
    command: "map",
    repoRoot,
    cwd: process.cwd(),
    patterns: parsed.patterns,
    languages: parsed.languages,
    files: entries,
    summary: summarizeEntries(entries),
    metadataSource: useAst ? "ast-grep-enabled" : "fallback-regex",
    handoff: buildHandoff(ranked, "map"),
    nextSuggestedQueries: nextQueriesFor(entries.map((entry) => entry.language)),
  };
}

function repoBriefPayload(entries: RepoEntry[], parsed: ReturnType<typeof parseRepoMapArgs>) {
  const summary = summarizeEntries(entries);
  const ranked = entries
    .slice()
    .map((entry) => ({ ...entry, score: briefScore(entry, parsed) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const topEntries = ranked.slice(0, parsed.top).map((entry) => compactBriefEntry(entry, parsed));
  const likelyEntrypoints = ranked
    .filter((entry) => entrypointPatterns(parsed).some((pattern) => pattern.test(entry.file)))
    .slice(0, parsed.maxFiles);
  return {
    command: "brief",
    repoRoot,
    cwd: process.cwd(),
    patterns: parsed.patterns,
    languages: parsed.languages,
    controls: {
      top: parsed.top,
      maxFiles: parsed.maxFiles,
      entrypoints: parsed.entrypoints,
      exclude: parsed.exclude,
      includeGenerated: parsed.includeGenerated,
    },
    summary,
    topFiles: topEntries.slice(0, parsed.maxFiles),
    likelyEntrypoints: likelyEntrypoints.map((entry) => compactBriefEntry(entry, parsed)),
    handoff: buildHandoff(ranked.slice(0, parsed.maxFiles), "brief"),
    nextSuggestedQueries: nextQueriesFor(topEntries.map((entry) => entry.language)),
  };
}

function repoQueryPayload(entries: RepoEntry[], parsed: ReturnType<typeof parseRepoMapArgs>) {
  const terms = parsed.terms.map((term) => term.toLowerCase());
  const ranked = entries
    .map((entry) => {
      const scored = scoreEntry(entry, terms);
      return { ...entry, score: scored.score, reasons: scored.reasons };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, parsed.limit);
  return {
    command: "query",
    repoRoot,
    cwd: process.cwd(),
    terms: parsed.terms,
    patterns: parsed.patterns,
    languages: parsed.languages,
    ranking: {
      file: 5,
      module: 4,
      symbol: 3,
      import: 2,
    },
    matches: ranked,
    handoff: buildHandoff(ranked, "query"),
    nextSuggestedQueries:
      ranked.length === 0
        ? ["broaden terms", "drop --lang filters", "switch to repo-map brief for a wider summary"]
        : nextQueriesFor(ranked.map((entry) => entry.language)),
  };
}

async function listFiles(repoRoot: string, parsed: ReturnType<typeof parseRepoMapArgs>) {
  const excludedGlobs = ["!.git", "!node_modules", "!target", "!.overstory", "!dist", "!build", "!result"];
  if (commandExists("rg")) {
    const command = ["rg", "--files"];
    if (parsed.hidden) command.push("--hidden");
    for (const pattern of excludedGlobs) command.push("-g", pattern);
    for (const pattern of parsed.exclude) command.push("-g", `!${pattern}`);
    for (const pattern of parsed.patterns) command.push("-g", pattern);
    const result = await runCommand(command, repoRoot);
    if (result.code === 0) {
      return result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .filter((path) => !excludedByDefault(path, parsed))
        .map((path) => join(repoRoot, path));
    }
  }
  return collectFiles(repoRoot).filter((file) => {
    const relPath = relative(repoRoot, file);
    return !excludedByDefault(relPath, parsed) && matchesAny(relPath, parsed.patterns);
  });
}

function collectFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if ([".git", "node_modules", "target", ".overstory"].includes(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) collectFiles(full, results);
    else if (stat.isFile()) results.push(full);
  }
  return results;
}

function excludedByDefault(relPath: string, parsed: ReturnType<typeof parseRepoMapArgs>) {
  if (/(^|\/)(\.git|node_modules|target|\.overstory|dist|build|result)(\/|$)/.test(relPath)) return true;
  if (!parsed.includeGenerated && /(^|\/)(generated|gen|vendor)(\/|$)|\.(min\.)/.test(relPath)) return true;
  return parsed.exclude.some((pattern) => globToRegExp(pattern).test(relPath));
}

function matchesAny(path: string, patterns: string[]) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

function globToRegExp(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/(^|\/)\*\*\//g, "$1::ZERO_OR_MORE_DIRS::")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::ZERO_OR_MORE_DIRS::/g, "(?:.*/)?")
    .replace(/::DOUBLE_STAR::/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function modulePath(relPath: string) {
  return relPath.replace(/\.[^.]+$/, "").replace(/\//g, "::");
}

function extractImports(text: string, language: string) {
  const lines = text.split(/\r?\n/);
  if (language === "rust") return lines.filter((line) => /^\s*(pub\s+)?use\s+/.test(line)).map((line) => line.trim());
  if (language === "typescript") return lines.filter((line) => /^\s*import\s+/.test(line)).map((line) => line.trim());
  if (language === "javascript") return lines.filter((line) => /^\s*(import|const .* require\()/.test(line)).map((line) => line.trim());
  if (language === "python") return lines.filter((line) => /^\s*(from\s+\S+\s+import|import\s+)/.test(line)).map((line) => line.trim());
  if (language === "go") return lines.filter((line) => /^\s*(import\s+|\)|\().*/.test(line)).map((line) => line.trim()).filter(Boolean);
  return [];
}

function extractSymbols(text: string, language: string) {
  const lines = text.split(/\r?\n/);
  if (language === "rust") {
    return lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*(pub\s+)?(async\s+)?(fn|struct|enum|trait|impl|type|const|mod)\s+/.test(line))
      .map(({ line, index }) => ({ line: index + 1, signature: line.trim() }));
  }
  if (language === "typescript") {
    return lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*(export\s+)?(async\s+)?(function|class|interface|type|const)\s+/.test(line))
      .map(({ line, index }) => ({ line: index + 1, signature: line.trim() }));
  }
  if (language === "javascript") {
    return lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*(export\s+)?(async\s+)?(function|class|const)\s+/.test(line))
      .map(({ line, index }) => ({ line: index + 1, signature: line.trim() }));
  }
  if (language === "python") {
    return lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*(async\s+def|def|class)\s+/.test(line))
      .map(({ line, index }) => ({ line: index + 1, signature: line.trim() }));
  }
  if (language === "go") {
    return lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*(func|type|const|var)\s+/.test(line))
      .map(({ line, index }) => ({ line: index + 1, signature: line.trim() }));
  }
  return [];
}

function parseRepoMapArgs(args: string[]) {
  const patterns: string[] = [];
  const languages: string[] = [];
  const terms: string[] = [];
  const entrypoints: string[] = [];
  const exclude: string[] = [];
  let hidden = false;
  let limit = 20;
  let top = 12;
  let maxFiles = 12;
  let includeGenerated = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--lang") {
      const language = args[index + 1];
      if (language) languages.push(normalizeLanguage(language));
      index++;
      continue;
    }
    if (arg === "--term") {
      const term = args[index + 1];
      if (term) terms.push(term);
      index++;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(args[index + 1]);
      if (Number.isFinite(value) && value > 0) limit = value;
      index++;
      continue;
    }
    if (arg === "--top") {
      const value = Number(args[index + 1]);
      if (Number.isFinite(value) && value > 0) top = value;
      index++;
      continue;
    }
    if (arg === "--max-files") {
      const value = Number(args[index + 1]);
      if (Number.isFinite(value) && value > 0) maxFiles = value;
      index++;
      continue;
    }
    if (arg === "--entrypoint") {
      const value = args[index + 1];
      if (value) entrypoints.push(value.toLowerCase());
      index++;
      continue;
    }
    if (arg === "--exclude") {
      const value = args[index + 1];
      if (value) exclude.push(value);
      index++;
      continue;
    }
    if (arg === "--include-generated") {
      includeGenerated = true;
      continue;
    }
    if (arg === "--hidden") {
      hidden = true;
      continue;
    }
    if (arg.startsWith("--")) continue;
    if (terms.length > 0) terms.push(arg);
    else patterns.push(arg);
  }
  return {
    patterns: patterns.length > 0 ? patterns : ["**/*"],
    languages,
    terms,
    entrypoints,
    exclude,
    hidden,
    limit,
    top,
    maxFiles,
    includeGenerated,
  };
}

function normalizeLanguage(language: string) {
  switch (language.toLowerCase()) {
    case "rs":
      return "rust";
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "py":
      return "python";
    case "golang":
      return "go";
    default:
      return language.toLowerCase();
  }
}

function summarizeEntries(entries: RepoEntry[]) {
  const byLanguage = entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.language] = (acc[entry.language] ?? 0) + 1;
    return acc;
  }, {});
  return {
    totalFiles: entries.length,
    byLanguage: Object.fromEntries(Object.entries(byLanguage).sort((a, b) => b[1] - a[1])),
    totalSymbols: entries.reduce((count, entry) => count + entry.symbols.length, 0),
    totalImports: entries.reduce((count, entry) => count + entry.imports.length, 0),
  };
}

function briefScore(entry: RepoEntry, parsed: ReturnType<typeof parseRepoMapArgs>) {
  let score = entry.symbols.length * 2 + entry.imports.length;
  if (entrypointPatterns(parsed).some((pattern) => pattern.test(entry.file))) score += 10;
  return score;
}

function compactBriefEntry(entry: RepoEntry, parsed: ReturnType<typeof parseRepoMapArgs>): RepoBriefEntry {
  return {
    file: entry.file,
    language: entry.language,
    module: entry.module,
    score: entry.score ?? briefScore(entry, parsed),
    why: whyEntry(entry, parsed).slice(0, 3),
    symbolCount: entry.symbols.length,
    importCount: entry.imports.length,
    sampleSymbols: entry.symbols.slice(0, symbolSampleLimit(entry.language)).map((item) => item.signature),
    sampleImports: entry.imports.slice(0, importSampleLimit(entry.language)),
  };
}

function whyEntry(entry: RepoEntry, parsed: ReturnType<typeof parseRepoMapArgs>) {
  const reasons = briefReasons(entry);
  if (!reasons.includes("entrypoint-like filename") && entrypointPatterns(parsed).some((pattern) => pattern.test(entry.file))) {
    reasons.unshift("entrypoint-like filename");
  }
  return reasons;
}

function symbolSampleLimit(language: string) {
  switch (language) {
    case "typescript":
    case "javascript":
      return 4;
    case "rust":
      return 5;
    case "python":
    case "go":
      return 4;
    default:
      return 3;
  }
}

function importSampleLimit(language: string) {
  switch (language) {
    case "typescript":
    case "javascript":
      return 2;
    case "rust":
      return 3;
    default:
      return 2;
  }
}

function scoreEntry(entry: RepoEntry, terms: string[]) {
  let score = 0;
  const reasons: string[] = [];
  for (const term of terms) {
    const fileMatch = entry.file.toLowerCase().includes(term) ? entry.file.toLowerCase() : "";
    const moduleMatch = entry.module.toLowerCase().includes(term) ? entry.module.toLowerCase() : "";
    const symbolMatch = entry.symbols.map((item) => item.signature.toLowerCase()).find((value) => value.includes(term)) ?? "";
    const importMatch = entry.imports.map((item) => item.toLowerCase()).find((value) => value.includes(term)) ?? "";
    if (fileMatch) {
      score += 5;
      reasons.push(`file +5: ${truncate(fileMatch)}`);
    }
    if (moduleMatch) {
      score += 4;
      reasons.push(`module +4: ${truncate(moduleMatch)}`);
    }
    if (symbolMatch) {
      score += 3;
      reasons.push(`symbol +3: ${truncate(symbolMatch)}`);
    }
    if (importMatch) {
      score += 2;
      reasons.push(`import +2: ${truncate(importMatch)}`);
    }
  }
  return { score, reasons };
}

function entrypointPatterns(parsed: ReturnType<typeof parseRepoMapArgs>) {
  const names = parsed.entrypoints.length > 0 ? parsed.entrypoints : ["main", "index", "app", "server", "cli", "lib", "mod"];
  return names.map((name) => new RegExp(`(^|/)${escapeRegExp(name)}\\.`));
}

function nextQueriesFor(languages: string[]) {
  const unique = [...new Set(languages)];
  const suggestions: string[] = [];
  if (unique.includes("rust")) suggestions.push("code-intel-rust ast outline <file>");
  if (unique.includes("typescript") || unique.includes("javascript")) suggestions.push("code-intel-ts ast outline <file>");
  if (suggestions.length === 0) suggestions.push("narrow with --lang rust|ts|js|py|go");
  return suggestions;
}

function buildHandoff(entries: Array<RepoEntry | (RepoEntry & { score?: number; reasons?: string[] })>, source: "map" | "brief" | "query"): Handoff {
  const candidates = entries.slice(0, 4).map((entry) => entry.file);
  const primary = entries[0];
  if (!primary) {
    return {
      recommendedTool: null,
      recommendedMode: null,
      recommendedCommand: null,
      candidateFiles: [],
      primaryFile: null,
      secondaryFiles: [],
      handoffReason: "No clear candidate files were found for the current scope.",
      confidence: "low",
    };
  }

  const recommendedTool = recommendedToolFor(primary.language);
  const recommendedMode = recommendedTool ? "ast" : null;
  const recommendedCommand =
    recommendedTool && recommendedMode ? `${recommendedTool} ${recommendedMode} outline ${primary.file}` : null;
  const secondaryFiles = entries.slice(1, 4).map((entry) => entry.file);
  return {
    recommendedTool,
    recommendedMode,
    recommendedCommand,
    candidateFiles: candidates,
    primaryFile: primary.file,
    secondaryFiles,
    handoffReason: handoffReasonFor(primary, source, secondaryFiles.length),
    confidence: handoffConfidence(primary, source),
  };
}

function recommendedToolFor(language: string) {
  if (language === "rust") return "code-intel-rust";
  if (language === "typescript" || language === "javascript") return "code-intel-ts";
  return null;
}

function handoffReasonFor(entry: RepoEntry & { reasons?: string[] }, source: "map" | "brief" | "query", secondaryCount: number) {
  const tool = recommendedToolFor(entry.language);
  const countText = secondaryCount > 0 ? ` with ${secondaryCount} nearby fallback files` : "";
  if (!tool) {
    return `Top candidate is ${entry.file} (${entry.language}), but no language-specific code-intel tool is available yet.`;
  }
  if (source === "query" && entry.reasons && entry.reasons.length > 0) {
    return `Top query match is ${entry.file} for ${tool}${countText}; ranked by ${entry.reasons.slice(0, 2).join(", ")}.`;
  }
  if (source === "brief") {
    const reasons = briefReasons(entry);
    return `Brief selected ${entry.file} for ${tool}${countText}; likely relevant because ${reasons.slice(0, 2).join(" and ")}.`;
  }
  return `Map suggests ${entry.file} as the first ${entry.language} handoff target for ${tool}${countText}.`;
}

function handoffConfidence(entry: RepoEntry & { score?: number }, source: "map" | "brief" | "query"): "high" | "medium" | "low" {
  if (!recommendedToolFor(entry.language)) return "low";
  if (source === "query") return (entry.score ?? 0) >= 8 ? "high" : "medium";
  if (source === "brief") return (entry.score ?? 0) >= 10 ? "high" : "medium";
  return "low";
}

function briefReasons(entry: RepoEntry) {
  const reasons: string[] = [];
  if (/(^|\/)(main|index|app|server|cli|lib|mod)\./.test(entry.file)) {
    reasons.push("entrypoint-like filename");
  }
  if (entry.symbols.length > 0) reasons.push(`${entry.symbols.length} top-level symbols`);
  if (entry.imports.length > 0) reasons.push(`${entry.imports.length} imports`);
  if (reasons.length === 0) reasons.push("matched current scope filters");
  return reasons;
}

function truncate(value: string, limit = 96) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printUsageAndExit(json: boolean): never {
  const usage = [
    "Usage:",
    "  repo-map map [patterns...] [--lang <lang>] [--hidden] [--json]",
    "  repo-map brief [patterns...] [--lang <lang>] [--top <n>] [--max-files <n>] [--entrypoint <name>] [--exclude <glob>] [--include-generated] [--hidden] [--json]",
    "  repo-map query [patterns...] --term <term> [--term <term>...] [--lang <lang>] [--exclude <glob>] [--include-generated] [--limit <n>] [--json]",
  ].join("\n");
  if (json) {
    console.error(JSON.stringify({ error: "usage", message: usage }));
  } else {
    console.error(usage);
  }
  process.exit(1);
}
