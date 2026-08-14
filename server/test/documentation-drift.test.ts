import Fastify from "fastify";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { rpgV1Routes } from "../src/routes/rpg/v1/features.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const API_REFERENCE = "docs/api.md";
const INVENTORY_START = "<!-- rpg-operation-inventory:start -->";
const INVENTORY_END = "<!-- rpg-operation-inventory:end -->";

interface DocumentedOperation {
  method: string;
  route: string;
  inventoryClass: "discovery" | "operation";
}

function read(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function operationKey(operation: Pick<DocumentedOperation, "method" | "route">): string {
  return `${operation.method} ${operation.route}`;
}

function documentedOperations(): DocumentedOperation[] {
  const source = read(API_REFERENCE);
  const start = source.indexOf(INVENTORY_START);
  const end = source.indexOf(INVENTORY_END);
  expect(start, "API operation inventory start marker").toBeGreaterThanOrEqual(0);
  expect(end, "API operation inventory end marker").toBeGreaterThan(start);
  const rows: DocumentedOperation[] = [];
  const malformed: string[] = [];
  for (const line of source.slice(start + INVENTORY_START.length, end).split("\n")) {
    if (!line.trim() || line === "| Method | Route | Inventory class |" || line === "| --- | --- | --- |") continue;
    const match = /^\| `([A-Z]+)` \| `([^`]+)` \| (discovery|operation) \|$/.exec(line);
    if (!match) {
      malformed.push(line);
      continue;
    }
    rows.push({ method: match[1]!, route: match[2]!, inventoryClass: match[3]! as DocumentedOperation["inventoryClass"] });
  }
  expect(malformed, "malformed API inventory rows").toEqual([]);
  const keys = rows.map(operationKey);
  expect(new Set(keys).size, "duplicate API inventory operations").toBe(keys.length);
  expect(rows.every(({ route }) => route.startsWith("/api/rpg/v1") && !route.includes("?")), "canonical API inventory routes").toBe(true);
  return rows;
}

function markdownFiles(): string[] {
  const rootFiles = ["AGENTS.md", "README.md", "CONTRIBUTING.md", "devplan.md", "handoff.md", "todo.md", "drift-remediation-plan.md"];
  const docs = readdirSync(path.join(ROOT, "docs"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.posix.join("docs", entry.name));
  const maintainedInternal = [
    "server/src/content/mechanicsStarterCatalog.provenance.md",
    "server/src/content/originalStarterManifest.provenance.md",
  ];
  return [...rootFiles, ...docs, ...maintainedInternal].filter((relativePath) => existsSync(path.join(ROOT, relativePath)));
}

function visibleMarkdownLines(source: string): Array<string | null> {
  let fence: string | null = null;
  return source.split("\n").map((line) => {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1] ?? null;
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      return null;
    }
    return fence === null ? line : null;
  });
}

function headingSlug(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[\*_~]/g, "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

function markdownAnchors(relativePath: string): Set<string> {
  const anchors = new Set<string>();
  const duplicates = new Map<string, number>();
  for (const line of visibleMarkdownLines(read(relativePath))) {
    if (line === null) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading) {
      const base = headingSlug(heading);
      const count = duplicates.get(base) ?? 0;
      duplicates.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const match of line.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) anchors.add(match[1]!);
  }
  return anchors;
}

function inlineLinkTargets(line: string): { targets: string[]; unterminated: boolean } {
  const source = line.replace(/`[^`]*`/g, "");
  const targets: string[] = [];
  let unterminated = false;
  for (let start = source.indexOf("]("); start !== -1; start = source.indexOf("](", start + 2)) {
    let depth = 1;
    let escaped = false;
    let end = start + 2;
    for (; end < source.length; end += 1) {
      const character = source[end]!;
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (depth === 0) break;
    }
    if (depth !== 0) { unterminated = true; continue; }
    targets.push(source.slice(start + 2, end));
  }
  return { targets, unterminated };
}

function linkTargets(line: string): string[] {
  const targets = inlineLinkTargets(line).targets;
  const reference = /^\s*\[[^\]]+\]:\s*(\S+)/.exec(line)?.[1];
  if (reference) targets.push(reference);
  return targets;
}

function referenceLinkTargets(line: string, definitions: ReadonlyMap<string, string>): { targets: string[]; undefinedLabels: string[] } {
  const targets: string[] = [];
  const undefinedLabels: string[] = [];
  for (const reference of line.matchAll(/(?<!!)\[([^\]]+)\]\[([^\]]*)\]/g)) {
    const label = (reference[2] || reference[1])!.trim().toLocaleLowerCase("en-US");
    const target = definitions.get(label);
    if (target) targets.push(target);
    else undefinedLabels.push(label);
  }
  const withoutFullReferences = line.replace(/(?<!!)\[[^\]]+\]\[[^\]]*\]/g, "");
  for (const shortcut of withoutFullReferences.matchAll(/(?<!!)\[([^\]]+)\](?![([])/g)) {
    const target = definitions.get(shortcut[1]!.trim().toLocaleLowerCase("en-US"));
    if (target) targets.push(target);
  }
  return { targets, undefinedLabels };
}

function walkFiles(directory: string, extensions: ReadonlySet<string>): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolute, extensions));
    else if (extensions.has(path.extname(entry.name))) files.push(absolute);
  }
  return files.sort();
}

function environmentUsageInSource(source: string, relativePath: string): { keys: Set<string>; dynamic: string[] } {
  const scriptKind = /\.[cm]?js$/.test(relativePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const keys = new Set<string>();
  const dynamic: string[] = [];
  const unwrap = (value: ts.Node): ts.Node => {
    let node = value;
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
      || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
    return node;
  };
  const staticMember = (value: ts.Node): { expression: ts.Expression; name: string } | null => {
    const node = unwrap(value);
    if (ts.isPropertyAccessExpression(node)) return { expression: node.expression, name: node.name.text };
    if (ts.isElementAccessExpression(node) && node.argumentExpression
      && (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
      return { expression: node.expression, name: node.argumentExpression.text };
    }
    return null;
  };
  const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  type Scope = Map<string, boolean>;
  const resolveBinding = (name: string, scopes: readonly Scope[]): boolean | undefined => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const value = scopes[index]!.get(name);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const isProcessEnv = (value: ts.Node, scopes: readonly Scope[]): boolean => {
    const member = staticMember(value);
    const expression = member ? unwrap(member.expression) : null;
    return member?.name === "env" && expression !== null && ts.isIdentifier(expression) && expression.text === "process"
      && resolveBinding("process", scopes) === undefined;
  };
  const isImportMetaEnv = (value: ts.Node): boolean => {
    const member = staticMember(value);
    const expression = member ? unwrap(member.expression) : null;
    return member?.name === "env" && expression !== null && ts.isMetaProperty(expression)
      && expression.keywordToken === ts.SyntaxKind.ImportKeyword;
  };
  const isEnvironment = (value: ts.Node | undefined, scopes: readonly Scope[]): boolean => {
    if (!value) return false;
    const node = unwrap(value);
    return isProcessEnv(node, scopes) || isImportMetaEnv(node) || (ts.isIdentifier(node) && resolveBinding(node.text, scopes) === true);
  };
  const environmentTypes = new Set(["ProcessEnv", "NodeJS.ProcessEnv"]);
  let discoveredType = true;
  while (discoveredType) {
    discoveredType = false;
    for (const statement of sourceFile.statements) {
      if (!ts.isTypeAliasDeclaration(statement) || environmentTypes.has(statement.name.text)) continue;
      const definition = statement.type.getText(sourceFile);
      if ([...environmentTypes].some((name) => new RegExp(`(^|\\W)${name.replace(".", "\\.")}(?:$|\\W)`).test(definition))) {
        environmentTypes.add(statement.name.text);
        discoveredType = true;
      }
    }
  }
  const isEnvironmentType = (type: ts.TypeNode | undefined): boolean => Boolean(type
    && [...environmentTypes].some((name) => new RegExp(`(^|\\W)${name.replace(".", "\\.")}(?:$|\\W)`).test(type.getText(sourceFile))));
  const recordEnvironmentBinding = (name: ts.BindingName): void => {
    if (!ts.isObjectBindingPattern(name)) return;
    for (const element of name.elements) {
      const key = element.propertyName ?? element.name;
      if (ts.isIdentifier(key) || ts.isStringLiteral(key)) keys.add(key.text);
      else dynamic.push(`${relativePath}:${lineOf(element)}`);
    }
  };
  const declareBinding = (name: ts.BindingName, environment: boolean, scope: Scope): void => {
    if (ts.isIdentifier(name)) { scope.set(name.text, environment); return; }
    for (const element of name.elements) if (!ts.isOmittedExpression(element)) declareBinding(element.name, false, scope);
  };
  const visit = (node: ts.Node, scopes: Scope[]): void => {
    if (ts.isFunctionLike(node)) {
      const functionScope: Scope = new Map();
      for (const parameter of node.parameters) {
        const environment = isEnvironmentType(parameter.type);
        if (environment) recordEnvironmentBinding(parameter.name);
        declareBinding(parameter.name, environment, functionScope);
        if (parameter.initializer) visit(parameter.initializer, scopes);
      }
      if ("body" in node && node.body) visit(node.body, [...scopes, functionScope]);
      return;
    }
    if (ts.isBlock(node)) {
      const blockScopes = [...scopes, new Map<string, boolean>()];
      for (const statement of node.statements) visit(statement, blockScopes);
      return;
    }
    if (ts.isCatchClause(node)) {
      const catchScope: Scope = new Map();
      if (node.variableDeclaration) declareBinding(node.variableDeclaration.name, false, catchScope);
      visit(node.block, [...scopes, catchScope]);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const environment = isEnvironment(node.initializer, scopes);
      if (environment) recordEnvironmentBinding(node.name);
      declareBinding(node.name, environment, scopes.at(-1)!);
      if (node.initializer) visit(node.initializer, scopes);
      return;
    }
    if (ts.isPropertyAccessExpression(node) && isEnvironment(node.expression, scopes)) keys.add(node.name.text);
    if (ts.isElementAccessExpression(node) && isEnvironment(node.expression, scopes)) {
      if (node.argumentExpression && (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
        keys.add(node.argumentExpression.text);
      } else dynamic.push(`${relativePath}:${lineOf(node)}`);
    }
    ts.forEachChild(node, (child) => visit(child, scopes));
  };
  const rootScope: Scope = new Map();
  for (const statement of sourceFile.statements) visit(statement, [rootScope]);
  return { keys, dynamic };
}

function explicitHeadRegistrations(source: string, relativePath: string): string[] {
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: string[] = [];
  const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const memberName = (node: ts.Node): string | null => ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && node.argumentExpression
      && (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
      ? node.argumentExpression.text : null;
  const visit = (node: ts.Node): void => {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && memberName(node) === "head"
      && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
      findings.push(`${relativePath}:${lineOf(node)} explicit .head reference`);
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)
      && node.name.elements.some((element) => {
        const key = element.propertyName ?? element.name;
        return (ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === "head";
      })) {
      findings.push(`${relativePath}:${lineOf(node)} explicit .head binding`);
    }
    if (ts.isCallExpression(node)) {
      const member = node.expression;
      const method = memberName(member);
      if (method === "head") findings.push(`${relativePath}:${lineOf(node)} explicit .head registration`);
      if (method === "route") {
        const options = node.arguments[0];
        const method = options && ts.isObjectLiteralExpression(options)
          ? options.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property)
            && ((ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === "method"))
          : undefined;
        if (!method) findings.push(`${relativePath}:${lineOf(node)} dynamic route options`);
        else if (ts.isStringLiteral(method.initializer)) {
          if (method.initializer.text.toUpperCase() === "HEAD") findings.push(`${relativePath}:${lineOf(method)} explicit HEAD method`);
        } else if (ts.isArrayLiteralExpression(method.initializer)) {
          if (method.initializer.elements.some((element) => ts.isStringLiteral(element) && element.text.toUpperCase() === "HEAD")) {
            findings.push(`${relativePath}:${lineOf(method)} explicit HEAD method array`);
          }
          if (method.initializer.elements.some((element) => !ts.isStringLiteral(element))) findings.push(`${relativePath}:${lineOf(method)} dynamic route method array`);
        } else findings.push(`${relativePath}:${lineOf(method)} dynamic route method`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function serializedCaughtErrors(source: string, relativePath: string): string[] {
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: string[] = [];
  const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const loggerCall = (node: ts.CallExpression): boolean => {
    const member = node.expression;
    const method = ts.isPropertyAccessExpression(member) ? member.name.text
      : ts.isElementAccessExpression(member) && member.argumentExpression
        && (ts.isStringLiteral(member.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(member.argumentExpression))
        ? member.argumentExpression.text : null;
    if (!method || !["fatal", "error", "warn", "info", "debug", "trace"].includes(method)) return false;
    const receiver = ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member) ? member.expression : null;
    if (!receiver) return false;
    return (ts.isIdentifier(receiver) && receiver.text === "log")
      || ((ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver))
        && (ts.isPropertyAccessExpression(receiver) ? receiver.name.text
          : receiver.argumentExpression && (ts.isStringLiteral(receiver.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(receiver.argumentExpression))
            ? receiver.argumentExpression.text : null) === "log");
  };
  const containsIdentifier = (node: ts.Node, names: ReadonlySet<string>): boolean => {
    if (ts.isIdentifier(node) && names.has(node.text)) return true;
    let found = false;
    ts.forEachChild(node, (child) => { if (!found && containsIdentifier(child, names)) found = true; });
    return found;
  };
  const visit = (node: ts.Node, tainted: Set<string>): void => {
    if (ts.isCatchClause(node)) {
      const nested = new Set(tainted);
      if (node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) nested.add(node.variableDeclaration.name.text);
      visit(node.block, nested);
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && containsIdentifier(node.initializer, tainted)) {
      tainted.add(node.name.text);
    }
    if (ts.isCallExpression(node) && loggerCall(node) && node.arguments.some((argument) => containsIdentifier(argument, tainted))) {
      findings.push(`${relativePath}:${lineOf(node)} serializes a caught error`);
    }
    ts.forEachChild(node, (child) => visit(child, tainted));
  };
  visit(sourceFile, new Set());
  return findings;
}

function directEnvironmentUsage(): { keys: Set<string>; dynamic: string[] } {
  const files = [
    ...walkFiles(path.join(ROOT, "server/src"), new Set([".ts", ".js", ".mjs", ".cjs"])),
    ...walkFiles(path.join(ROOT, "client/src"), new Set([".ts", ".tsx", ".js", ".jsx"])),
    path.join(ROOT, "client/vite.config.ts"),
    ...walkFiles(path.join(ROOT, "e2e"), new Set([".ts", ".js", ".mjs"])),
    ...walkFiles(path.join(ROOT, "planning-board"), new Set([".js", ".mjs", ".cjs"])),
    path.join(ROOT, "playwright.config.ts"),
    path.join(ROOT, "playwright.live.config.ts"),
  ];
  const keys = new Set<string>();
  const dynamic: string[] = [];
  for (const absolute of files) {
    const source = readFileSync(absolute, "utf8");
    const relativePath = path.relative(ROOT, absolute).split(path.sep).join(path.posix.sep);
    const usage = environmentUsageInSource(source, relativePath);
    for (const key of usage.keys) {
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) keys.add(key);
      else dynamic.push(`${relativePath}: unsupported static environment key ${key}`);
    }
    dynamic.push(...usage.dynamic);
  }
  return { keys, dynamic };
}

function documentedEnvironment(): Map<string, string> {
  const source = read("docs/operations.md");
  const section = source.slice(source.indexOf("## Environment"), source.indexOf("## Data directory and current schema"));
  const inventory = new Map<string, string>();
  for (const match of section.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \| ([a-z-]+) \|/gm)) {
    expect(inventory.has(match[1]!), `duplicate environment inventory key ${match[1]}`).toBe(false);
    inventory.set(match[1]!, match[2]!);
  }
  return inventory;
}

describe("documentation drift guards", () => {
  it("keeps designated disposable-schema and operation claims aligned", () => {
    const schemaClaims: Array<[string, string]> = [
      ["README.md", "Development databases are disposable: schema changes require deleting and recreating `velvet.sqlite`"],
      ["docs/api.md", "Development databases use one current schema and are disposable"],
      ["docs/operations.md", "Development databases are disposable: schema changes require deleting and recreating `velvet.sqlite`"],
      ["docs/repo-architecture.md", "Development databases are disposable: schema changes require deleting and recreating `velvet.sqlite`"],
      ["docs/ROADMAP.md", "Development persistence uses one current disposable schema with no startup upgrades"],
      ["devplan.md", "Development persistence uses one current disposable schema with no startup upgrades"],
      ["handoff.md", "Persistence: one current disposable development schema"],
      ["docs/roleplay-architecture-2026.md", "one disposable schema with no startup upgrades"],
      ["docs/rpg-integration-plan.md", "one disposable schema with no startup upgrades"],
    ];
    for (const [relativePath, claim] of schemaClaims) expect(read(relativePath), relativePath).toContain(claim);

    const operations = documentedOperations();
    const count = operations.filter((operation) => operation.inventoryClass === "operation").length;
    expect(count).toBe(111);
    const countClaims = ["README.md", "docs/api.md", "docs/operations.md", "docs/ROADMAP.md", "devplan.md", "handoff.md"];
    for (const relativePath of countClaims) expect(read(relativePath), relativePath).toContain(`${count} counted`);
  });

  it("matches explicit Fastify RPG registration without runtime side effects", async () => {
    const factory = vi.fn(() => { throw new Error("route collection opened the repository"); });
    const registered: Array<{ method: string; route: string }> = [];
    const app = Fastify({ logger: false });
    app.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) registered.push({ method: String(method).toUpperCase(), route: route.url });
    });
    try {
      await app.register(rpgV1Routes, {
        prefix: "/api/rpg/v1",
        campaignRepositoryFactory: factory,
        diceCommandIds: { nextId: () => "unused-route-collection-id" },
      });
      await app.ready();
      expect(app.server.listening).toBe(false);
      expect(factory).not.toHaveBeenCalled();

      const implicitHeads = registered.filter(({ method }) => method === "HEAD");
      const explicit = registered.filter(({ method, route }) => method !== "HEAD" && route.startsWith("/api/rpg/v1"));
      const explicitHeadSources = walkFiles(path.join(ROOT, "server/src/routes/rpg/v1"), new Set([".ts"]))
        .flatMap((absolute) => explicitHeadRegistrations(readFileSync(absolute, "utf8"), path.relative(ROOT, absolute)));
      expect(explicitHeadSources, "explicit RPG HEAD registrations must be documented rather than filtered as aliases").toEqual([]);
      for (const head of implicitHeads) expect(explicit.map(operationKey), `implicit HEAD without GET ${head.route}`).toContain(`GET ${head.route}`);
      const runtimeKeys = explicit.map(operationKey).sort();
      expect(new Set(runtimeKeys).size, "duplicate runtime RPG operations").toBe(runtimeKeys.length);
      const documented = documentedOperations();
      const documentedKeys = documented.map(operationKey).sort();
      const missingFromDocs = runtimeKeys.filter((key) => !documentedKeys.includes(key));
      const notRegistered = documentedKeys.filter((key) => !runtimeKeys.includes(key));
      expect({ missingFromDocs, notRegistered }).toEqual({ missingFromDocs: [], notRegistered: [] });
      expect(documented.filter(({ inventoryClass }) => inventoryClass === "discovery").map(operationKey)).toEqual([
        "GET /api/rpg/v1/features",
      ]);
    } finally {
      await app.close();
    }
  });

  it("indexes every maintained docs guide", () => {
    const docsDirectory = path.join(ROOT, "docs");
    const maintained = readdirSync(docsDirectory)
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .sort();
    const indexed = new Set<string>();
    for (const line of visibleMarkdownLines(read("docs/README.md"))) {
      if (line === null) continue;
      for (const target of linkTargets(line)) {
        const localPath = target.split("#", 1)[0]!.split("?", 1)[0]!;
        if (!localPath || localPath.startsWith("..") || path.posix.dirname(localPath) !== ".") continue;
        if (localPath.endsWith(".md")) indexed.add(path.posix.basename(localPath));
      }
    }
    expect({ unlisted: maintained.filter((name) => !indexed.has(name)), missing: [...indexed].filter((name) => !maintained.includes(name)).sort() })
      .toEqual({ unlisted: [], missing: [] });
  });

  it("resolves maintained local Markdown links and anchors offline", () => {
    const failures: string[] = [];
    const anchorCache = new Map<string, Set<string>>();
    for (const sourcePath of markdownFiles()) {
      const lines = visibleMarkdownLines(read(sourcePath));
      const definitions = new Map<string, string>();
      for (const line of lines) {
        if (line === null) continue;
        const definition = /^\s*\[([^\]]+)\]:\s*(\S+)/.exec(line);
        if (definition) definitions.set(definition[1]!.trim().toLocaleLowerCase("en-US"), definition[2]!);
      }
      lines.forEach((line, index) => {
        if (line === null) return;
        const inline = inlineLinkTargets(line);
        if (inline.unterminated) failures.push(`${sourcePath}:${index + 1} unterminated inline link destination`);
        const targets = linkTargets(line);
        const references = referenceLinkTargets(line, definitions);
        targets.push(...references.targets);
        for (const label of references.undefinedLabels) failures.push(`${sourcePath}:${index + 1} undefined reference link ${label}`);
        for (const rawTarget of targets) {
          const target = rawTarget.trim().replace(/^<|>$/g, "").split(/\s+["']/)[0]!;
          if (/^(?:https?:|mailto:|\/\/)/i.test(target)) continue;
          const hash = target.indexOf("#");
          const rawPath = (hash === -1 ? target : target.slice(0, hash)).split("?", 1)[0]!;
          const rawFragment = hash === -1 ? "" : target.slice(hash + 1);
          let decodedPath: string;
          let fragment: string;
          try {
            decodedPath = decodeURIComponent(rawPath);
            fragment = decodeURIComponent(rawFragment).toLocaleLowerCase("en-US");
          } catch {
            failures.push(`${sourcePath}:${index + 1} invalid encoding in ${rawTarget}`);
            continue;
          }
          const resolved = decodedPath
            ? path.resolve(decodedPath.startsWith("/") ? ROOT : path.dirname(path.join(ROOT, sourcePath)), decodedPath.replace(/^\//, ""))
            : path.join(ROOT, sourcePath);
          const repositoryRelative = path.relative(ROOT, resolved);
          if (repositoryRelative === ".." || repositoryRelative.startsWith(`..${path.sep}`) || path.isAbsolute(repositoryRelative)) {
            failures.push(`${sourcePath}:${index + 1} target escapes repository ${rawTarget}`);
            continue;
          }
          if (!existsSync(resolved)) {
            failures.push(`${sourcePath}:${index + 1} missing target ${rawTarget}`);
            continue;
          }
          if (fragment && statSync(resolved).isFile() && path.extname(resolved).toLowerCase() === ".md") {
            const relativeTarget = path.relative(ROOT, resolved).split(path.sep).join(path.posix.sep);
            const anchors = anchorCache.get(relativeTarget) ?? markdownAnchors(relativeTarget);
            anchorCache.set(relativeTarget, anchors);
            if (!anchors.has(fragment)) failures.push(`${sourcePath}:${index + 1} missing anchor ${rawTarget} in ${relativeTarget}`);
          }
        }
      });
    }
    expect(failures).toEqual([]);
  });

  it("classifies direct environment use and covers user keys in the root example", () => {
    const usage = directEnvironmentUsage();
    const documented = documentedEnvironment();
    const used = [...usage.keys].sort();
    const documentedKeys = [...documented.keys()].sort();
    expect(usage.dynamic, "unclassified dynamic process.env access").toEqual([]);
    expect({ undocumented: used.filter((key) => !documented.has(key)), unused: documentedKeys.filter((key) => !usage.keys.has(key)) })
      .toEqual({ undocumented: [], unused: [] });

    const rootAssignments = new Map([...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)]
      .map((match) => [match[1]!, match[2]!] as const));
    const userKeys = [...documented]
      .filter(([, category]) => category === "server-runtime" || category === "client-development")
      .map(([key]) => key)
      .sort();
    expect(userKeys.filter((key) => !rootAssignments.has(key)), "user-facing keys missing from root .env.example").toEqual([]);
    for (const secret of ["OPENROUTER_API_KEY", "OPENAI_API_KEY"]) expect(rootAssignments.get(secret), `${secret} must stay empty`).toBe("");

    const serverAssignments = new Map([...read("server/.env.example").matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)]
      .map((match) => [match[1]!, match[2]!] as const));
    expect([...serverAssignments.keys()].filter((key) => !rootAssignments.has(key))).toEqual([]);
    expect(serverAssignments.get("OPENAI_API_KEY"), "server example secret must stay empty").toBe("");
  });

  it("parses supported Markdown links and environment access forms", () => {
    expect(inlineLinkTargets("[nested](guide_(local).md#section)")).toEqual({ targets: ["guide_(local).md#section"], unterminated: false });
    expect(inlineLinkTargets("[broken](guide.md").unterminated).toBe(true);
    const references = new Map([["operations", "operations.md#environment"]]);
    expect(referenceLinkTargets("[Operations][operations] and [Operations][]", references)).toEqual({
      targets: ["operations.md#environment", "operations.md#environment"], undefinedLabels: [],
    });
    expect(referenceLinkTargets("[Missing][missing]", references)).toEqual({ targets: [], undefinedLabels: ["missing"] });
    const source = `
      const runtimeEnv = process.env;
      const { ALIASED, RENAMED: renamed } = runtimeEnv;
      runtimeEnv?.OPTIONAL;
      runtimeEnv["BRACKET"];
      import.meta.env.CLIENT_VALUE;
      function read(env: NodeJS.ProcessEnv) { return env.INJECTED; }
      function destructure({ PARAMETER_KEY }: NodeJS.ProcessEnv) { return PARAMETER_KEY; }
      function shadow(runtimeEnv: Record<string, string>) { return runtimeEnv.NOT_ENVIRONMENT; }
      const asserted = process.env as NodeJS.ProcessEnv;
      asserted.ASSERTED;
      runtimeEnv[dynamicKey];
    `;
    const usage = environmentUsageInSource(source, "synthetic.ts");
    expect([...usage.keys].sort()).toEqual(["ALIASED", "ASSERTED", "BRACKET", "CLIENT_VALUE", "INJECTED", "OPTIONAL", "PARAMETER_KEY", "RENAMED"].sort());
    expect(usage.dynamic).toEqual(["synthetic.ts:12"]);
    const advancedUsage = environmentUsageInSource(`
      type RuntimeEnvironment = NodeJS.ProcessEnv;
      process["env"].PROCESS_ELEMENT;
      import.meta["env"].META_ELEMENT;
      function injected({ TYPE_ALIAS_KEY }: RuntimeEnvironment) { return TYPE_ALIAS_KEY; }
      function shadow(process: { env: { LOCAL: string } }) { return process.env.LOCAL; }
    `, "advanced.ts");
    expect([...advancedUsage.keys].sort()).toEqual(["META_ELEMENT", "PROCESS_ELEMENT", "TYPE_ALIAS_KEY"]);
    expect(explicitHeadRegistrations("app.route({\n method:\n 'HEAD', url: '/x', handler });", "synthetic.ts")).toEqual([
      "synthetic.ts:2 explicit HEAD method",
    ]);
    expect(explicitHeadRegistrations("app.route({ method: dynamicMethod, url: '/x', handler });", "synthetic.ts")).toEqual([
      "synthetic.ts:1 dynamic route method",
    ]);
    expect(explicitHeadRegistrations("app['head']('/x', handler);", "synthetic.ts")).toEqual([
      "synthetic.ts:1 explicit .head registration",
    ]);
    expect(explicitHeadRegistrations("const registerHead = app.head.bind(app);", "synthetic.ts")).toEqual([
      "synthetic.ts:1 explicit .head reference",
    ]);
    expect(explicitHeadRegistrations("const { head: registerHead } = app;", "synthetic.ts")).toEqual([
      "synthetic.ts:1 explicit .head binding",
    ]);
    expect(serializedCaughtErrors("try { work(); } catch (error) { request.log.warn({ operation: 'x', error }, 'failed'); }", "synthetic.ts"))
      .toEqual(["synthetic.ts:1 serializes a caught error"]);
    expect(serializedCaughtErrors("try { work(); } catch (error) { const details = { error }; request['log'].warn(details, 'failed'); }", "synthetic.ts"))
      .toEqual(["synthetic.ts:1 serializes a caught error"]);
  });

  it("does not serialize caught provider errors in roleplay logs", () => {
    for (const relativePath of ["server/src/routes/roleplay/generationService.ts", "server/src/routes/roleplay/interactions.ts"]) {
      expect(serializedCaughtErrors(read(relativePath), relativePath), relativePath).toEqual([]);
    }
  });
});
