import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import {
  API,
  type Checker,
  type Symbol as CompilerSymbol,
  SymbolFlags,
  type Type,
  TypeFlags,
} from "typescript/unstable/async";

// Covers symbol/type-resolvable values. Laundering through unknown, any, casts or
// untyped containers remains a review responsibility, not a reachability proof.
type Site = { file: string; fn: string; root: string; count: number };
type Entry = Site & { category: string; reason: string; owner?: string };
const roots: Record<string, string[]> = {
  "src/integrations/github-identity.ts": ["githubSh"],
  "src/integrations/github.ts": ["runGh", "GhRunner"],
  "src/git/repos.ts": [
    "remoteSh",
    "pushBranch",
    "pushExistingBranch",
    "createPullRequest",
    "mergePullRequest",
    "disableAutoMerge",
  ],
  "src/git/command.ts": ["cacheGit"],
  "src/integrations/github-poller.ts": ["ghClient", "GitHubClient", "call"],
  "src/integrations/ci-classifier.ts": ["ciDecision", "Call"],
  "src/integrations/issue-lifecycle.ts": ["reconcileIssueLifecycle"],
  "src/integrations/defect-github.ts": ["createDefectGitHub"],
  "src/integrations/shared-store.ts": ["createSharedStore", "createCompanionIO", "call"],
  "src/integrations/claim-ref.ts": ["createClaimClient"],
  "src/integrations/mcp.ts": ["Fetch"],
  "src/util/proc.ts": ["sh", "runProcess"],
};
const canonical: Record<string, string> = { GhRunner: "runGh", GitHubClient: "ghClient", Fetch: "fetch" };
const key = (s: Site) => `${s.file} | ${s.fn} | ${s.root}`;
const children = (n: ts.Node) => {
  const out: ts.Node[] = [];
  n.forEachChild((c) => {
    out.push(c);
  });
  return out;
};
const text = (n: ts.Node | undefined): string | undefined =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;
const unwrap = (n: ts.Node): ts.Node => (ts.isParenthesizedExpression(n) ? unwrap(n.expression) : n);

// Unknown properties/spreads may override even an earlier literal property.
function property(n: ts.Node | undefined, name: string): ts.Node | undefined | null {
  if (!n || !ts.isObjectLiteralExpression(n)) return null;
  let value: ts.Node | undefined;
  for (const p of n.properties) {
    if (ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name))) return null;
    if (ts.isShorthandPropertyAssignment(p)) {
      if (p.name.text === name) return null;
      else continue;
    }
    if (!ts.isPropertyAssignment(p)) {
      if (p.name && (ts.isIdentifier(p.name) ? p.name.text : text(p.name)) === name) return null;
      else continue;
    }
    if ((ts.isIdentifier(p.name) ? p.name.text : text(p.name)) === name) value = p.initializer;
  }
  return value;
}
function nonGitHub(n: ts.Node | undefined): boolean {
  const prefix = n && ts.isTemplateExpression(n) ? n.head.text : text(n);
  // Require the entire authority and its delimiter before any interpolation.
  const origin = prefix?.match(/^https?:\/\/[^/?#]+(?=[/?#]|$)/)?.[0];
  if (!origin || (n && ts.isTemplateExpression(n) && origin === prefix)) return false;
  try {
    const host = new URL(origin).hostname.replace(/\.$/, "");
    return host !== "github.com" && !host.endsWith(".github.com");
  } catch {
    return false;
  }
}
async function fetchRead(args: readonly ts.Node[], checker: Checker) {
  if (nonGitHub(args[0])) return true;
  const method = args.length < 2 ? undefined : property(args[1], "method");
  if (method !== undefined) return text(method ?? undefined) === "GET";
  // Without an init override, Request inputs carry their own (unknown) method.
  async function urlInput(t: Type | undefined): Promise<boolean> {
    if (!t) return false;
    if (t.isUnionType()) {
      for (const part of await t.getTypes()) if (!(await urlInput(part))) return false;
      return true;
    }
    if (t.flags & TypeFlags.StringLike) return true;
    const url = await checker.resolveName("URL", SymbolFlags.Type);
    return url !== undefined && (await t.getSymbol())?.id === url.id;
  }
  return args[0] !== undefined && urlInput(await checker.getTypeAtLocation(args[0]));
}
function argv(n: ts.Node | undefined): (string | undefined)[] | undefined {
  if (!n || !ts.isArrayLiteralExpression(n)) return undefined;
  return n.elements.map((e) => text(e));
}
function commandRead(args: (string | undefined)[] | undefined, credential = false): boolean {
  if (!args || args.some((a) => a === undefined)) return false;
  if (args[0] === "git") return ["fetch", "ls-remote"].includes(args[1] ?? "");
  if (args[0] !== "gh") return false;
  if (
    (args[1] === "pr" && ["view", "list"].includes(args[2] ?? "")) ||
    (args[1] === "repo" && args[2] === "view")
  )
    return true;
  if (args[1] === "auth" && args[2] === "token") return !credential;
  if (args[1] !== "api") return false;
  // Inspect both sides of the endpoint. Only explicitly supported options can
  // prove a read; gh also accepts short-option clusters that may supply a body.
  const queries: string[] = [];
  const endpoints: string[] = [];
  let explicitMethod: string | undefined;
  for (let i = 2; i < args.length; i++) {
    const flag = args[i] ?? "";
    if (!flag.startsWith("-")) {
      endpoints.push(flag);
      continue;
    }
    const option = flag.match(/^(--[a-z-]+)(?:=(.*))?$|^(-[qHtXfF])(.*)$/s);
    const name = option?.[1] ?? option?.[3] ?? flag;
    let value = option?.[2] ?? (option?.[4] || undefined);
    if (["--paginate", "--slurp", "--silent", "--include", "-i", "--verbose"].includes(name)) {
      if (value !== undefined) return false;
      continue;
    }
    if (
      ![
        "--jq",
        "-q",
        "--template",
        "-t",
        "--header",
        "-H",
        "--hostname",
        "--cache",
        "--method",
        "-X",
        "--field",
        "-F",
        "--raw-field",
        "-f",
      ].includes(name)
    )
      return false;
    if (value === undefined) value = args[++i];
    if (!value || value.startsWith("-")) return false;
    if (["--method", "-X"].includes(name)) {
      if (explicitMethod || !["GET", "POST"].includes(value)) return false;
      explicitMethod = value;
    } else if (["--field", "-F", "--raw-field", "-f"].includes(name)) {
      // Only one literal query field is supported, with no other payload.
      if (!value.startsWith("query=")) return false;
      queries.push(value.slice("query=".length));
    }
  }
  if (endpoints.length !== 1 || !endpoints[0]) return false;
  if (!queries.length) return explicitMethod === undefined;
  return (
    endpoints[0] === "graphql" &&
    queries.length === 1 &&
    /^\s*query\b/.test(queries[0] ?? "") &&
    !/\bmutation\b/.test(queries[0] ?? "")
  );
}
async function include(
  root: string,
  args: readonly ts.Node[] | null,
  file: string,
  checker: Checker,
): Promise<boolean> {
  if (!args) return true;
  if (root === "fetch" && nonGitHub(args[0])) return false;
  if (args.some(ts.isSpreadElement)) return true;
  if (root === "fetch") return !(await fetchRead(args, checker));
  if (["ghClient", "Call", "pollerCall", "companionCall"].includes(root)) {
    const body = args[root === "Call" || root === "pollerCall" ? 2 : 1];
    if (!body) return false;
    const symbol = ts.isIdentifier(body) ? await checker.getSymbolAtLocation(body) : undefined;
    return !symbol || !(await checker.isUndefinedSymbol(symbol));
  }
  if (!["sh", "runProcess", "githubSh", "remoteSh", "cacheGit", "runGh"].includes(root)) return true;
  const cmd = root === "runProcess" ? property(args[0], "cmd") : args[0];
  let values = argv(cmd ?? undefined);
  if (root === "runGh" && values) values = ["gh", ...values];
  if ((root === "sh" || root === "runProcess") && values && values[0] !== undefined) {
    if (values[0] !== "gh" && values[0] !== "git") return false;
    if (
      values[0] === "git" &&
      values[1] !== undefined &&
      !values[1].startsWith("-") &&
      !["push", "fetch", "ls-remote", "clone", "pull"].includes(values[1])
    )
      return false;
  }
  return !commandRead(values, file === "src/integrations/github-token.ts" || root === "runProcess");
}

async function analyze(
  config: string,
  base: string,
  select = (file: string) => file.startsWith("src/") && file.endsWith(".ts") && !file.startsWith("src/ui/"),
): Promise<Site[]> {
  const api = new API({ cwd: base });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [config] });
    const project = snapshot.getProject(config);
    if (!project) throw new Error(`Compiler did not load ${config}`);
    const { program, checker } = project;
    const rootIds = new Map<number, string>();
    for (const [file, names] of Object.entries(roots)) {
      const source = await program.getSourceFile(resolve(repository, file));
      if (!source) throw new Error(`Missing root module ${file}`);
      const found = new Set<string>();
      const walk = async (n: ts.Node, owner?: string): Promise<void> => {
        if (
          (ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n) || ts.isTypeAliasDeclaration(n)) &&
          n.name &&
          names.includes(n.name.getText()) &&
          owner ===
            (n.name.getText() === "call"
              ? file.includes("shared-store")
                ? "createCompanionIO"
                : "startGitHubPoller"
              : undefined)
        ) {
          found.add(n.name.getText());
          const s = await checker.getSymbolAtLocation(n.name);
          if (!s) throw new Error(`Unresolved root ${file}:${n.name.getText()}`);
          rootIds.set(
            s.id,
            s.name === "call"
              ? file.includes("shared-store")
                ? "companionCall"
                : "pollerCall"
              : (canonical[s.name] ?? s.name),
          );
        }
        const nextOwner = ts.isFunctionLikeDeclaration(n)
          ? (("name" in n ? n.name?.getText() : undefined) ?? "<anonymous>")
          : owner;
        for (const c of children(n)) await walk(c, nextOwner);
      };
      await walk(source);
      for (const name of names) if (!found.has(name)) throw new Error(`Missing root ${name}`);
    }
    const globalFetch = await checker.resolveName("fetch", SymbolFlags.Value);
    if (!globalFetch) throw new Error("Missing global fetch");
    rootIds.set(globalFetch.id, "fetch");
    type Transport = { root: string; bound: readonly ts.Node[] | null };
    const symbolCache = new Map<number, Promise<Transport | undefined>>();
    const typeCache = new Map<number, Promise<Transport | undefined>>();
    async function fromSymbol(
      s: CompilerSymbol | undefined,
      seen = new Set<number>(),
    ): Promise<Transport | undefined> {
      if (!s || seen.has(s.id)) return undefined;
      const root = rootIds.get(s.id);
      if (root) return { root, bound: [] };
      if (symbolCache.has(s.id)) return symbolCache.get(s.id);
      const next = new Set([...seen, s.id]);
      const work = async () => {
        if (s.flags & SymbolFlags.Alias) return fromSymbol(await checker.getAliasedSymbol(s), next);
        for (const handle of s.declarations) {
          const d = await handle.resolve();
          if (d && ts.isFunctionTypeNode(d) && ts.isTypeAliasDeclaration(d.parent)) {
            const owner = await checker.getSymbolAtLocation(d.parent.name);
            const root = owner && rootIds.get(owner.id);
            if (root) return { root, bound: [] };
          }
          if (d && ts.isShorthandPropertyAssignment(d)) {
            const root = await fromSymbol(await checker.getShorthandAssignmentValueSymbol(d), next);
            if (root) return root;
          }
          if (
            d &&
            (ts.isVariableDeclaration(d) ||
              ts.isParameterDeclaration(d) ||
              ts.isBindingElement(d) ||
              ts.isPropertyAssignment(d) ||
              ts.isPropertyDeclaration(d)) &&
            d.initializer
          ) {
            const n = unwrap(d.initializer);
            if (
              ts.isIdentifier(n) ||
              ts.isPropertyAccessExpression(n) ||
              ts.isBinaryExpression(n) ||
              ts.isConditionalExpression(n) ||
              ts.isCallExpression(n)
            ) {
              const root = await fromExpression(n, next);
              if (root) return root;
            }
          }
        }
        return undefined;
      };
      const result = work();
      symbolCache.set(s.id, result);
      return result;
    }
    async function fromType(t: Type | undefined): Promise<Transport | undefined> {
      if (!t) return undefined;
      if (typeCache.has(t.id)) return typeCache.get(t.id);
      const work = async () => {
        for (const s of [await t.getAliasSymbol(), await t.getSymbol()]) {
          const root = await fromSymbol(s);
          if (root) return root;
        }
        for (const part of t.isUnionType() || t.isIntersectionType() ? await t.getTypes() : []) {
          const root = await fromType(part);
          if (root) return root;
        }
        return undefined;
      };
      const result = work();
      typeCache.set(t.id, result);
      return result;
    }
    async function fromExpression(
      node: ts.Node,
      seen = new Set<number>(),
      resolved?: { symbol: CompilerSymbol | undefined; type: Type | undefined },
    ): Promise<Transport | undefined> {
      const n = unwrap(node);
      // Resolution supplied for a parenthesized node does not describe its contents.
      if (n !== node) resolved = undefined;
      if (ts.isCallExpression(n)) {
        const method = await indirect(n.expression);
        if (method?.name === "bind") {
          const receiver = await fromExpression(method.receiver, seen);
          if (receiver)
            return {
              root: receiver.root,
              bound: prepend(
                receiver.bound,
                n.arguments.some(ts.isSpreadElement) ? null : n.arguments.slice(1),
              ),
            };
        }
        return fromType(resolved ? resolved.type : await checker.getTypeAtLocation(n));
      }
      if (
        ts.isBinaryExpression(n) &&
        [
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
        ].includes(n.operatorToken.kind)
      )
        return alternatives(n.left, n.right, seen);
      if (ts.isConditionalExpression(n)) return alternatives(n.whenTrue, n.whenFalse, seen);
      return (
        (await fromSymbol(resolved ? resolved.symbol : await checker.getSymbolAtLocation(n), seen)) ??
        (await fromType(resolved ? resolved.type : await checker.getTypeAtLocation(n)))
      );
    }
    async function alternatives(left: ts.Node, right: ts.Node, seen: Set<number>) {
      const a = await fromExpression(left, seen);
      const b = await fromExpression(right, seen);
      if (!a || !b) return a ?? b;
      // Branches may capture different arguments even when their callable types match.
      return { root: a.root, bound: a.bound?.length === 0 && b.bound?.length === 0 ? [] : null };
    }
    const methodCache = new Map<number, Promise<boolean>>();
    async function indirect(node: ts.Node) {
      const n = unwrap(node);
      if (!ts.isPropertyAccessExpression(n) && !ts.isElementAccessExpression(n)) return undefined;
      const member = ts.isElementAccessExpression(n) ? text(n.argumentExpression) : undefined;
      const receiverType = member ? await checker.getTypeAtLocation(n.expression) : undefined;
      const symbol =
        member && receiverType
          ? await checker.getPropertyOfType(receiverType, member)
          : await checker.getSymbolAtLocation(n);
      if (!symbol || !["call", "apply", "bind"].includes(symbol.name)) return undefined;
      // Confirm Function.prototype membership, rather than matching arbitrary methods.
      let intrinsic = methodCache.get(symbol.id);
      if (!intrinsic) {
        intrinsic = (async () => {
          for (const handle of symbol.declarations) {
            const d = await handle.resolve();
            if (
              d &&
              ts.isInterfaceDeclaration(d.parent) &&
              ["Function", "CallableFunction"].includes(d.parent.name.text) &&
              /(?:^|[/\\])lib\.es5\.d\.ts$/.test(d.getSourceFile().fileName)
            )
              return true;
          }
          return false;
        })();
        methodCache.set(symbol.id, intrinsic);
      }
      return (await intrinsic) ? { name: symbol.name, receiver: n.expression } : undefined;
    }
    function prepend(prefix: readonly ts.Node[] | null, args: readonly ts.Node[] | null) {
      return prefix && args ? [...prefix, ...args] : null;
    }
    async function ownerName(name: ts.DeclarationName | undefined): Promise<string | undefined> {
      if (!name) return undefined;
      if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isNumericLiteral(name))
        return name.text;
      if (!ts.isComputedPropertyName(name)) return text(name);
      const type = await checker.getTypeAtLocation(name.expression);
      if (type?.isStringLiteralType() || type?.isNumberLiteralType()) return String(type.value);
      // Without a constant value or semantic property name, use a stable bucket.
      const symbol = await checker.getSymbolAtLocation(name);
      return symbol && !symbol.name.startsWith("__") ? symbol.name : "<computed>";
    }
    const sites = new Map<string, Site>();
    for (const name of (await program.getSourceFileNames()).slice().sort()) {
      const file = relative(base, name).replaceAll("\\", "/");
      if (!select(file)) continue;
      const source = await program.getSourceFile(name);
      if (!source) throw new Error(`Missing program source ${name}`);
      const calls: { call: ts.CallExpression; fn: string }[] = [];
      const walk = async (n: ts.Node, scope: string): Promise<void> => {
        const nest = (label: string) => (scope === "<module>" ? label : `${scope}/${label}`);
        if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
          const label = await ownerName(
            n.name ?? (ts.isVariableDeclaration(n.parent) ? n.parent.name : undefined),
          );
          if (label) scope = nest(label);
        }
        if (
          ts.isFunctionLikeDeclaration(n) &&
          !ts.isCallSignatureDeclaration(n) &&
          !ts.isFunctionTypeNode(n)
        ) {
          const bound =
            ("name" in n ? n.name : undefined) ??
            (ts.isVariableDeclaration(n.parent) || ts.isPropertyAssignment(n.parent)
              ? n.parent.name
              : undefined);
          const label = ts.isConstructorDeclaration(n) ? "constructor" : await ownerName(bound);
          if (label) scope = nest(label);
        }
        if (ts.isCallExpression(n)) calls.push({ call: n, fn: scope });
        for (const c of children(n)) await walk(c, scope);
      };
      await walk(source, "<module>");
      if (!calls.length) continue;
      const nodes = calls.map((c) => c.call.expression);
      const symbols = await checker.getSymbolAtLocation(nodes);
      const types = await checker.getTypeAtLocation(nodes);
      for (const [i, { call, fn }] of calls.entries()) {
        const method = await indirect(call.expression);
        // Binding captures arguments but executes no transport.
        if (method?.name === "bind") continue;
        const target = method
          ? await fromExpression(method.receiver)
          : await fromExpression(call.expression, new Set(), { symbol: symbols[i], type: types[i] });
        if (!target) continue;
        let args: readonly ts.Node[] | null = call.arguments;
        if (method?.name === "call") args = args.some(ts.isSpreadElement) ? null : args.slice(1);
        if (method?.name === "apply") {
          const applied = args?.[1] && unwrap(args[1]);
          args =
            !args?.some(ts.isSpreadElement) && applied && ts.isArrayLiteralExpression(applied)
              ? applied.elements
              : null;
        }
        args = prepend(target.bound, args);
        if (!(await include(target.root, args, file, checker))) continue;
        const site = { file, fn, root: target.root, count: 0 };
        const id = key(site);
        const existing = sites.get(id) ?? site;
        existing.count++;
        sites.set(id, existing);
      }
    }
    return [...sites.values()].sort((a, b) => key(a).localeCompare(key(b)));
  } finally {
    await api.close();
  }
}
const repository = resolve(import.meta.dir, "..");
const owners = new Set([
  "C11",
  "C16",
  "C17",
  "C23",
  "credential",
  "local",
  "unwired",
  "not-github",
  "out-of-scope",
]);
function validate(entries: Entry[]) {
  const categories = new Set([
    "run-scope",
    "observer",
    "transport",
    "maintenance",
    "guarded-control",
    "read",
    "helper",
    "exempt",
  ]);
  const keys = new Set<string>();
  for (const e of entries) {
    if (
      keys.has(key(e)) ||
      !categories.has(e.category) ||
      !e.reason.trim() ||
      !Number.isInteger(e.count) ||
      e.count <= 0 ||
      (e.category === "exempt" ? !owners.has(e.owner ?? "") : e.owner !== undefined) ||
      (e.category === "helper" && e.reason !== "categorized at callers")
    )
      throw new Error(`Invalid manifest entry ${key(e)}`);
    keys.add(key(e));
  }
}
function compare(actual: Site[], expected: Entry[]) {
  validate(expected);
  const a = new Map(actual.map((s) => [key(s), s.count]));
  const e = new Map(expected.map((s) => [key(s), s.count]));
  const errors = [...new Set([...a.keys(), ...e.keys()])]
    .sort()
    .flatMap((k) =>
      a.get(k) === e.get(k)
        ? []
        : [
            `${k}: expected ${e.get(k) ?? 0}, actual ${a.get(k) ?? 0} (${!e.has(k) ? "unknown" : !a.has(k) ? "stale" : "count"})`,
          ],
    );
  if (errors.length) throw new Error(errors.join("\n"));
}
// file | enclosing function | canonical root | count | category | owner | reason
const manifest: Entry[] = `
src/cli/deploy-wait.ts | localDeployClient/request | fetch | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/cli/gate-slot.ts | localLeaseClient | fetch | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/cli/local.ts | manageLocal/run | sh | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/cli/main.ts | api | fetch | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/cli/service.ts | ensureRelease | sh | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/cli/service.ts | gates/gate | sh | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/cli/service.ts | serviceControl/run | sh | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/cli/setup.ts | setupDeps/fetch | fetch | 1 | exempt | credential | Setup identity verification plus model and daemon probes
src/cli/setup.ts | setupDeps/run | sh | 1 | exempt | credential | Setup GitHub authentication and environment checks
src/gates/github-actions.ts | githubActionsExecutor/api | runGh | 1 | exempt | unwired | No src caller constructs githubActionsExecutor
src/gates/github-actions.ts | githubActionsExecutor/attach | runGh | 1 | exempt | unwired | No src caller constructs githubActionsExecutor
src/gates/github-actions.ts | githubActionsExecutor/attach/poll | runGh | 1 | exempt | unwired | No src caller constructs githubActionsExecutor
src/gates/github-actions.ts | githubActionsExecutor/jobLog | runGh | 1 | exempt | unwired | No src caller constructs githubActionsExecutor
src/gc.ts | collectGarbage | cacheGit | 5 | exempt | not-github | Local worktree metadata cleanup; no remote commands
src/git/command.ts | recordWorktree | sh | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/git/command.ts | refusePopulatedRepositories | sh | 2 | exempt | not-github | Local command or daemon request; no GitHub transport
src/git/command.ts | runGit | sh | 1 | helper |  | categorized at callers
src/git/command.ts | runGit/run | sh | 2 | helper |  | categorized at callers
src/git/confinement.ts | bwrapGit/wrap | sh | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/git/confinement.ts | gitSh | sh | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/git/confinement.ts | seatbeltGit/wrap/check | sh | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/git/hardening.ts | list | sh | 2 | exempt | not-github | Local command or daemon request; no GitHub transport
src/git/repos.ts | addDetachedWorktree | cacheGit | 1 | read |  | Repository observation, clone/fetch or local cache administration
src/git/repos.ts | createPullRequest | githubSh | 1 | helper |  | categorized at callers
src/git/repos.ts | createPullRequest | remoteSh | 1 | helper |  | categorized at callers
src/git/repos.ts | createPullRequest/find | githubSh | 1 | helper |  | categorized at callers
src/git/repos.ts | createWorktree | cacheGit | 1 | read |  | Repository observation, clone/fetch or local cache administration
src/git/repos.ts | createWorktree | remoteSh | 1 | read |  | Repository observation, clone/fetch or local cache administration
src/git/repos.ts | createWorktree | runGh | 1 | read |  | Repository observation, clone/fetch or local cache administration
src/git/repos.ts | deliveryPublicationRange | remoteSh | 2 | read |  | Repository observation, clone/fetch or local cache administration
src/git/repos.ts | disableAutoMerge | githubSh | 1 | helper |  | categorized at callers
src/git/repos.ts | exportGateSnapshot | cacheGit | 1 | read |  | Repository observation, clone/fetch or local cache administration
src/git/repos.ts | fetchBase | remoteSh | 1 | read |  | Repository observation, clone/fetch or local cache administration
src/git/repos.ts | findPullRequest | githubSh | 1 | read |  | Repository observation, clone/fetch or local cache administration
src/git/repos.ts | lookupIdentityPr | githubSh | 2 | read |  | Repository observation, clone/fetch or local cache administration
src/git/repos.ts | mergePullRequest/landed | githubSh | 1 | helper |  | categorized at callers
src/git/repos.ts | mergePullRequest/merge | githubSh | 2 | helper |  | categorized at callers
src/git/repos.ts | pinnedTree | sh | 1 | exempt | local | Local eval repository fetch, snapshot or push
src/git/repos.ts | probePushAccess | cacheGit | 2 | read |  | Repository observation, clone/fetch or local cache administration
src/git/repos.ts | probePushAccess/probe | remoteSh | 1 | read |  | Dry-run permission probe never updates the remote ref
src/git/repos.ts | pushBranch | remoteSh | 1 | helper |  | categorized at callers
src/git/repos.ts | pushExistingBranch | remoteSh | 2 | helper |  | categorized at callers
src/git/repos.ts | pushSnapshot | sh | 1 | exempt | local | Local eval repository fetch, snapshot or push
src/git/repos.ts | pushSnapshot/commit | sh | 1 | exempt | local | Local eval repository fetch, snapshot or push
src/git/repos.ts | refreshCache | cacheGit | 9 | read |  | Repository observation, clone/fetch or local cache administration
src/git/repos.ts | removeWorktree | cacheGit | 1 | exempt | not-github | Local worktree metadata cleanup; no remote commands
src/git/repos.ts | remoteBranchSha | remoteSh | 1 | read |  | Repository observation, clone/fetch or local cache administration
src/git/repos.ts | remoteSh | cacheGit | 1 | helper |  | categorized at callers
src/git/repos.ts | remoteSh | githubSh | 1 | helper |  | categorized at callers
src/git/repos.ts | resolveRepo | remoteSh | 1 | read |  | Repository observation, clone/fetch or local cache administration
src/git/repos.ts | stagePinnedEvalRepo | sh | 2 | exempt | local | Local eval repository fetch, snapshot or push
src/git/repos.ts | withTransportRepo | cacheGit | 3 | read |  | Repository observation, clone/fetch or local cache administration
src/harness/browser-mcp.ts | provisionBrowserMcp/recordRuntime | runProcess | 1 | exempt | not-github | Local harness process or model endpoint; no GitHub transport
src/harness/browser-mcp.ts | provisionBrowserMcp/run | runProcess | 1 | exempt | not-github | Local harness process or model endpoint; no GitHub transport
src/harness/claude.ts | runClaude | runProcess | 1 | exempt | not-github | Local harness process or model endpoint; no GitHub transport
src/harness/claude.ts | runClaude/runner | runProcess | 1 | exempt | not-github | Local harness process or model endpoint; no GitHub transport
src/harness/codex.ts | codexVersion | runProcess | 1 | exempt | not-github | Local harness process or model endpoint; no GitHub transport
src/harness/codex.ts | runCodex | runProcess | 1 | exempt | not-github | Local harness process or model endpoint; no GitHub transport
src/harness/codex.ts | sandboxProbe/attempt | runProcess | 1 | exempt | not-github | Local harness process or model endpoint; no GitHub transport
src/harness/codex.ts | sandboxProbe/probeReads | runProcess | 1 | exempt | not-github | Local harness process or model endpoint; no GitHub transport
src/harness/decisions.ts | runDecisions | fetch | 1 | exempt | not-github | Local harness process or model endpoint; no GitHub transport
src/harness/llm.ts | runLlm | fetch | 1 | exempt | not-github | Local harness process or model endpoint; no GitHub transport
src/harness/sandbox-linux.ts | verifyLinux/step | runProcess | 1 | exempt | not-github | Local harness process or model endpoint; no GitHub transport
src/harness/sandbox.ts | probeSeatbelt/step | runProcess | 1 | exempt | not-github | Local harness process or model endpoint; no GitHub transport
src/harness/sandbox.ts | runSandboxed | runProcess | 1 | exempt | not-github | Local harness process or model endpoint; no GitHub transport
src/integrations/ci-classifier.ts | inspectCiInner/requestRerun | Call | 2 | helper |  | categorized at callers
src/integrations/claim-ref.ts | createClaimClient/call | runGh | 1 | maintenance |  | Claim IO executes through claimScope.exit
src/integrations/control-discovery.ts | createControlDirectory | createCompanionIO | 1 | helper |  | categorized at callers
src/integrations/control-discovery.ts | createControlDirectory/listReceiptCandidates | companionCall | 1 | read |  | Receipt directory GraphQL query over POST
src/integrations/control-ref.ts | createControlRefClient | createCompanionIO | 1 | helper |  | categorized at callers
src/integrations/control-ref.ts | createControlRefClient/write | companionCall | 4 | guarded-control |  | Control write checks claimGuard before each write
src/integrations/defect-github.ts | createDefectGitHub/request | fetch | 1 | exempt | out-of-scope | Defect-report publication and dedupe filed separately (D10)
src/integrations/defect-service.ts | startDefectService | createDefectGitHub | 1 | exempt | out-of-scope | Defect-report publication and dedupe filed separately (D10)
src/integrations/github-identity.ts | createGitHubIdentity/request | fetch | 1 | exempt | credential | GitHub App credential exchange
src/integrations/github-identity.ts | githubSh | sh | 1 | helper |  | categorized at callers
src/integrations/github-notifier.ts | getGitHubCiRuns | runGh | 1 | read |  | PR state or workflow-run observation with variable identifiers
src/integrations/github-notifier.ts | getGitHubPr | githubSh | 1 | read |  | PR state or workflow-run observation with variable identifiers
src/integrations/github-notifier.ts | startGitHubNotifier | runGh | 1 | observer |  | Terminal lifecycle observer guard; shared mode disables legacy notifier
src/integrations/github-poller.ts | ghClient | fetch | 1 | transport |  | Authenticated GitHub client transport checks claimGuard
src/integrations/github-poller.ts | guardGitHubClient | ghClient | 1 | helper |  | categorized at callers
src/integrations/github-poller.ts | startGitHubPoller/call | ghClient | 1 | helper |  | categorized at callers
src/integrations/github-poller.ts | startGitHubPoller/observe | pollerCall | 1 | read |  | Observation GraphQL query over POST
src/integrations/github-poller.ts | startGitHubPoller/record | ciDecision | 1 | observer |  | C08b observer authority guards CI reruns
src/integrations/github-poller.ts | startGitHubPoller/record/ciCall | pollerCall | 1 | helper |  | categorized at callers
src/integrations/github-token.ts | githubToken | runProcess | 1 | exempt | credential | Raw auth token lookup retained despite the literal-read rule
src/integrations/github.ts | githubWebhook | runGh | 1 | read |  | Dependabot observation GraphQL query over POST
src/integrations/github.ts | runGh | githubSh | 1 | helper |  | categorized at callers
src/integrations/issue-lifecycle.ts | reconcileIssueLifecycle/call | runGh | 1 | observer |  | C08a lifecycle authority guards terminal issue reporting
src/integrations/issue-queue.ts | startIssueQueue/query | runGh | 1 | read |  | Issue discovery GraphQL query over POST
src/integrations/issue-queue.ts | startIssueQueue/tick | reconcileIssueLifecycle | 1 | observer |  | C08a lifecycle authority guards terminal issue reporting
src/integrations/mcp.ts | httpBackend/api | fetch | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/integrations/member-capabilities.ts | probeCapabilities/run | sh | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/integrations/shared-store.ts | createCompanionIO/call | fetch | 1 | helper |  | categorized at callers
src/integrations/shared-store.ts | createCompanionIO/repository | companionCall | 1 | read |  | Companion repository metadata GraphQL query over POST
src/integrations/shared-store.ts | createSharedStore | createCompanionIO | 1 | helper |  | categorized at callers
src/integrations/shared-store.ts | createSharedStore/put | companionCall | 4 | exempt | C11 | D10 shared-store writes guarded by C11 callers
src/land/deploy-process.ts | deployProcess | sh | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/land/deploy-process.ts | launchctlJob | sh | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/land/queue.ts | LandQueue/approvalEvidence | ghClient | 1 | read |  | Approval-evidence GraphQL query over POST
src/land/queue.ts | LandQueue/approvalEvidence/client | ghClient | 1 | helper |  | categorized at callers
src/land/queue.ts | LandQueue/awaitCi | ciDecision | 1 | exempt | C17 | Land queue publication and CI-rerun authority belongs to C17
src/land/queue.ts | LandQueue/awaitCi | ghClient | 1 | exempt | C17 | Land queue publication and CI-rerun authority belongs to C17
src/land/queue.ts | LandQueue/checkout | cacheGit | 1 | read |  | Base fetch or base-branch PR observation
src/land/queue.ts | LandQueue/land | runGh | 1 | exempt | C17 | Land queue publication and CI-rerun authority belongs to C17
src/land/queue.ts | LandQueue/merge | disableAutoMerge | 1 | exempt | C17 | Land queue publication and CI-rerun authority belongs to C17
src/land/queue.ts | LandQueue/merge | mergePullRequest | 1 | exempt | C17 | Land queue publication and CI-rerun authority belongs to C17
src/land/queue.ts | LandQueue/pushApproved | pushExistingBranch | 1 | exempt | C17 | Land queue publication and CI-rerun authority belongs to C17
src/land/queue.ts | LandQueue/requestUnowned | runGh | 1 | exempt | C17 | Land queue publication and CI-rerun authority belongs to C17
src/land/queue.ts | LandQueue/resolveBase | runGh | 1 | read |  | Base fetch or base-branch PR observation
src/pipeline/shared-admission.ts | admitRun | cacheGit | 1 | exempt | C11 | Admission checks PR base and head commits in the local cache
src/pipeline/acceptance-follow-ups.ts | fileFollowUps/api | runGh | 1 | run-scope |  | Engine stage execution inside claimScope.run through guarded transports
src/pipeline/engine.ts | deliver/deliverStage | createPullRequest | 1 | run-scope |  | Engine stage execution inside claimScope.run through guarded transports
src/pipeline/engine.ts | deliver/deliverStage | mergePullRequest | 1 | run-scope |  | Engine stage execution inside claimScope.run through guarded transports
src/pipeline/engine.ts | deliver/deliverStage | pushBranch | 2 | run-scope |  | Engine stage execution inside claimScope.run through guarded transports
src/pipeline/engine.ts | deliver/deliverStage | pushExistingBranch | 1 | run-scope |  | Engine stage execution inside claimScope.run through guarded transports
src/pipeline/engine.ts | deliver/deliverStage | runGh | 4 | run-scope |  | Engine stage execution inside claimScope.run through guarded transports
src/pipeline/engine.ts | deliver/deliverStage/gh | runGh | 1 | run-scope |  | Engine stage execution inside claimScope.run through guarded transports
src/pipeline/engine.ts | deliverReviewRound | pushExistingBranch | 1 | run-scope |  | Engine stage execution inside claimScope.run through guarded transports
src/pipeline/engine.ts | deliverReviewRound | runGh | 4 | run-scope |  | Engine stage execution inside claimScope.run through guarded transports
src/pipeline/engine.ts | deliverVerifiedDraft | createPullRequest | 1 | run-scope |  | Engine stage execution inside claimScope.run through guarded transports
src/pipeline/engine.ts | deliverVerifiedDraft | pushBranch | 1 | run-scope |  | Engine stage execution inside claimScope.run through guarded transports
src/pipeline/network-wait.ts | head | fetch | 1 | read |  | Coordinator reachability probe sends HEAD without credentials or a body
src/pipeline/review-round.ts | readPrHead | runGh | 1 | read |  | Review head observation
src/pipeline/review-round.ts | submitReview | runGh | 1 | exempt | C16 | Review submission authority belongs to C16
src/pipeline/run-object-export.ts | createRunObjectExporter/git | cacheGit | 1 | exempt | not-github | Local committed-object bundle export; no remote commands
src/pipeline/run-object-quarantine.ts | createRunObjectValidator/git | cacheGit | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/pipeline/run-object-quarantine.ts | createRunObjectValidator/readObject | runProcess | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
src/pipeline/shadow-report.ts | ghPrHistory/json | runGh | 1 | read |  | Read-only GitHub history or issue metadata query
src/pipeline/shadow-report.ts | ghPrHistory/view | runGh | 2 | read |  | Read-only GitHub history or issue metadata query
src/server/http.ts | createHttpRoutes | runGh | 1 | read |  | Read-only GitHub history or issue metadata query
src/util/proc.ts | sh | runProcess | 1 | helper |  | categorized at callers
src/workers/publication.ts | publishAgentChanges | cacheGit | 1 | exempt | C23 | Worker publication authority belongs to C23
src/workers/update.ts | updateWorker/run | sh | 1 | exempt | not-github | Local command or daemon request; no GitHub transport
`
  .trim()
  .split("\n")
  .map((line) => {
    const [file = "", fn = "", root = "", count, category = "", owner, reason = ""] = line.split(" | ");
    return { file, fn, root, count: Number(count), category, reason, ...(owner ? { owner } : {}) };
  });

test("production GitHub transport manifest", async () => {
  compare(await analyze(join(repository, "tsconfig.json"), repository), manifest);
}, 60_000);

async function fixture(files: Record<string, string>, check: (config: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "github-inventory-"));
  try {
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: join(repository, "tsconfig.json"),
        compilerOptions: {
          paths: { "@roots/*": [join(repository, "src/*")] },
          typeRoots: [join(repository, "node_modules/@types")],
        },
        include: ["*.ts", ...Object.keys(roots).map((file) => join(repository, file))],
      }),
    );
    for (const [name, source] of Object.entries(files)) await writeFile(join(dir, name), source);
    await check(join(dir, "tsconfig.json"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const synthetic = (file: string) => !file.startsWith("../") && file.endsWith(".ts");
const imports = `
import { ghClient as client, type GitHubClient } from '@roots/integrations/github-poller.ts';
import { runGh, type GhRunner } from '@roots/integrations/github.ts';
import { sh, runProcess } from '@roots/util/proc.ts';
import type { Fetch } from '@roots/integrations/mcp.ts';
declare const body: unknown, method: string, url: string, cmd: string[], part: string;
`;

test("symbols, aliases, defaults and every declared transport type close the named holes", async () => {
  await fixture(
    {
      "holes.ts": `${imports}
export function alias() { client('/path', body); }
export function variableMethod() { runGh(['api', '/path', '--method', method]); }
export function runner(gh: GhRunner) { gh(['issue', 'comment', '1']); }
export function github(gh: GitHubClient) { gh('/path', body); }
export function classifier(call: Parameters<typeof import('@roots/integrations/ci-classifier.ts').ciDecision>[3]) { call('repo', '/path', body); }
export function fetchType(request: typeof fetch) { request(url, {method: 'POST'}); }
export function fetchAlias(request: Fetch) { request(url, {method: 'POST'}); }
type Alias = Fetch;
export function nestedAlias(request: Alias) { request(url, {method: 'POST'}); }
export function processType(run: typeof runProcess) { run({cmd: ['gh', 'issue', 'comment']}); }
export function properties(deps: { gh: GhRunner; github: GitHubClient; request: Fetch }) {
 deps.gh(['issue', 'comment']); deps.github('/path', body); deps.request(url, {method: 'POST'});
}
export function defaultFetch(request = fetch) { request(url, {method: 'POST'}); }
export function defaultProcess(run = runProcess) { run({cmd: ['gh', 'auth', 'token']}); }
export function raw() { sh(['gh', 'issue', 'comment']); }
const BRANCH_PUSH = ['git', 'push', '--no-follow-tags'];
export function spread() { sh([...BRANCH_PUSH, part]); }
export function variable() { sh(cmd); }
export function computed() { sh([part, 'comment']); }
export function bindings() { const execute = sh; const again = execute; again(cmd); }
export function conditional() { (Math.random() ? fetch : fetch)(url, {method: 'POST'}); }
`,
      "decision.ts": `import {ciDecision} from '@roots/integrations/ci-classifier.ts'; export function decide(...args: Parameters<typeof ciDecision>) { ciDecision(...args); }`,
      "callers.ts": `import {pushExistingBranch} from '@roots/git/repos.ts';
export function first(...args: Parameters<typeof pushExistingBranch>) { pushExistingBranch(...args); }
export function second(...args: Parameters<typeof pushExistingBranch>) { pushExistingBranch(...args); }`,
      "factories.ts": `
import {createDefectGitHub} from '@roots/integrations/defect-github.ts';
import {createSharedStore} from '@roots/integrations/shared-store.ts';
import {createClaimClient} from '@roots/integrations/claim-ref.ts';
export function defect(...args: Parameters<typeof createDefectGitHub>) { createDefectGitHub(...args); }
export function shared(...args: Parameters<typeof createSharedStore>) { createSharedStore(...args); }
export function claim(...args: Parameters<typeof createClaimClient>) { createClaimClient(...args); }`,
      "unrelated.ts": `export {}; function runGh(args: string[]) {} function fetch(url: string) {};
runGh(['issue', 'comment']); fetch('url'); const req = {method: 'POST'}; req.method === 'POST';`,
      "anonymous.ts": `${imports} client('/path', body); [1].map(() => client('/path', body)); [2].map(() => client('/path', body));`,
    },
    async (config, dir) => {
      const found = await analyze(config, dir, synthetic);
      const expected: [string, string, string][] = [
        ["holes.ts", "alias", "ghClient"],
        ["holes.ts", "variableMethod", "runGh"],
        ["holes.ts", "runner", "runGh"],
        ["holes.ts", "github", "ghClient"],
        ["holes.ts", "classifier", "Call"],
        ["holes.ts", "fetchType", "fetch"],
        ["holes.ts", "fetchAlias", "fetch"],
        ["holes.ts", "nestedAlias", "fetch"],
        ["holes.ts", "processType", "runProcess"],
        ["holes.ts", "properties", "runGh"],
        ["holes.ts", "properties", "ghClient"],
        ["holes.ts", "properties", "fetch"],
        ["holes.ts", "defaultFetch", "fetch"],
        ["holes.ts", "defaultProcess", "runProcess"],
        ["holes.ts", "raw", "sh"],
        ["holes.ts", "spread", "sh"],
        ["holes.ts", "variable", "sh"],
        ["holes.ts", "computed", "sh"],
        ["holes.ts", "bindings", "sh"],
        ["holes.ts", "conditional", "fetch"],
        ["decision.ts", "decide", "ciDecision"],
        ["factories.ts", "defect", "createDefectGitHub"],
        ["factories.ts", "shared", "createSharedStore"],
        ["factories.ts", "claim", "createClaimClient"],
        ["callers.ts", "first", "pushExistingBranch"],
        ["callers.ts", "second", "pushExistingBranch"],
        ["anonymous.ts", "<module>", "ghClient"],
      ];
      expect(found).toEqual(
        expected
          .map(([file, fn, root]) => ({ file, fn, root, count: file === "anonymous.ts" ? 3 : 1 }))
          .sort((a, b) => key(a).localeCompare(key(b))),
      );
    },
  );
}, 30_000);

test("read classification keeps uncertain dispatch and excludes only proven reads and local commands", async () => {
  const cases: [string, string, string | null][] = [
    ["prView", `runGh(['pr', 'view', '1'])`, null],
    ["prList", `runGh(['pr', 'list'])`, null],
    ["repoView", `sh(['gh', 'repo', 'view', 'owner/repo'])`, null],
    ["auth", `sh(['gh', 'auth', 'token'])`, null],
    ["clusterIF", `runGh(['api', 'repos/example/repo/issues', '-if', 'title=hello'])`, "runGh"],
    ["clusterFI", `runGh(['api', 'repos/example/repo/issues', '-fi', 'title=hello'])`, "runGh"],
    ["compactPayload", `runGh(['api', 'user', '-Ffoo=bar'])`, "runGh"],
    ["unknownOption", `runGh(['api', 'user', '--future-option'])`, "runGh"],
    ["missingOption", `runGh(['api', 'user', '--jq'])`, "runGh"],
    ["missingEndpoint", `runGh(['api', '--paginate'])`, "runGh"],
    ["missingValueBeforeEndpoint", `runGh(['api', '--jq', '--paginate', 'user'])`, "runGh"],
    [
      "readOptions",
      `runGh(['api', 'user', '--jq', '.login', '--paginate', '-H', 'Accept: application/json'])`,
      null,
    ],
    [
      "readOptionsBeforeEndpoint",
      `runGh(['api', '-q', '.login', '--header', 'Accept: application/json', '--paginate', 'user'])`,
      null,
    ],
    ["compactReadOptions", `runGh(['api', '--jq=.login', '-HAccept: application/json', 'user'])`, null],
    ["variableReadOption", `runGh(['api', 'user', '--jq', part])`, "runGh"],
    [
      "duplicateQuery",
      `runGh(['api', 'graphql', '-fquery=query { viewer { login } }', '-fquery=query { viewer { id } }'])`,
      "runGh",
    ],
    [
      "queryPayload",
      `runGh(['api', 'graphql', '-fquery=query { viewer { login } }', '-fowner=example'])`,
      "runGh",
    ],
    ["queryExplicitPost", `runGh(['api', '-XPOST', 'graphql', '-fquery=query { viewer { login } }'])`, null],
    ["api", `runGh(['api', 'user'])`, null],
    ["query", `runGh(['api', 'graphql', '-f', 'query=query { viewer { login } }'])`, null],
    ["compactQuery", `runGh(['api', 'graphql', '-fquery=query { viewer { login } }'])`, null],
    ["longQuery", `runGh(['api', 'graphql', '--raw-field=query=query { viewer { login } }'])`, null],
    ["typedQuery", `runGh(['api', 'graphql', '-F', 'query=query { viewer { login } }'])`, null],
    ["mutation", `runGh(['api', 'graphql', '-f', 'query=mutation { update { id } }'])`, "runGh"],
    [
      "compactMutationOverride",
      `runGh(['api', 'graphql', '-f', 'query=query { viewer { login } }', '-fquery=mutation { update { id } }'])`,
      "runGh",
    ],
    [
      "typedMutationOverride",
      `runGh(['api', 'graphql', '-f', 'query=query { viewer { login } }', '-Fquery=mutation { update { id } }'])`,
      "runGh",
    ],
    [
      "longMutationOverride",
      `runGh(['api', 'graphql', '-f', 'query=query { viewer { login } }', '--field=query=mutation { update { id } }'])`,
      "runGh",
    ],
    [
      "formattedMutation",
      `runGh(['api', 'graphql', '--template', 'query=query { viewer { login } }', '-fquery=mutation { update { id } }'])`,
      "runGh",
    ],
    [
      "templateOnly",
      `runGh(['api', 'graphql', '--template', 'query=query { viewer { login } }', '-f', 'owner=example'])`,
      "runGh",
    ],
    [
      "queryFromInput",
      `runGh(['api', 'graphql', '-f', 'query=query { viewer { login } }', '--input', '-'])`,
      "runGh",
    ],
    ["variableQuery", `runGh(['api', 'graphql', '-f', part])`, "runGh"],
    ["explicitGet", `runGh(['api', 'user', '-X', 'GET'])`, "runGh"],
    ["post", `runGh(['api', 'user', '-X', 'POST'])`, "runGh"],
    ["method", `runGh(['api', 'user', '--method', method])`, "runGh"],
    ["field", `runGh(['api', 'user', '-f', 'x=y'])`, "runGh"],
    ["typedField", `runGh(['api', 'user', '-F', 'x=1'])`, "runGh"],
    ["input", `runGh(['api', 'user', '--input', '-'])`, "runGh"],
    ["flagsBeforeEndpoint", `runGh(['api', '-XPOST', 'repos/example/repo/issues'])`, "runGh"],
    ["methodBeforeEndpoint", `runGh(['api', '--method', 'POST', 'repos/example/repo/issues'])`, "runGh"],
    ["fieldBeforeEndpoint", `runGh(['api', '-f', 'title=x', 'repos/example/repo/issues'])`, "runGh"],
    ["queryBeforeEndpoint", `runGh(['api', '-f', 'query=query { viewer { login } }', 'graphql'])`, null],
    ["mutationBeforeEndpoint", `runGh(['api', '-fquery=mutation { update { id } }', 'graphql'])`, "runGh"],
    ["queryNonGraphql", `runGh(['api', '-f', 'query=query { x }', 'repos/example/repo/issues'])`, "runGh"],
    ["argsSpread", `runGh(['pr', 'view', ...cmd])`, "runGh"],
    ["gitFetch", `sh(['git', 'fetch', 'origin'])`, null],
    ["gitRemote", `sh(['git', 'ls-remote', 'origin'])`, null],
    ["gitPush", `sh(['git', 'push', 'origin'])`, "sh"],
    ["gitClone", `sh(['git', 'clone', part])`, "sh"],
    ["gitPull", `sh(['git', 'pull'])`, "sh"],
    ["local", `sh(['git', 'rev-parse', part])`, null],
    ["echo", `sh(['echo', 'gh'])`, null],
    ["unknownArgv", `runProcess({cmd})`, "runProcess"],
    ["computedArgv", `runProcess({cmd: [part]})`, "runProcess"],
    ["clientRead", `client('/path')`, null],
    ["clientAbsent", `client('/path', undefined)`, null],
    ["clientBody", `client('/path', body)`, "ghClient"],
    ["fetchRead", `fetch(url)`, null],
    ["fetchOptions", `fetch(url, {headers: {}})`, null],
    ["fetchGet", `fetch(url, {method: 'GET'})`, null],
    ["fetchUrlObject", `fetch(new URL(url))`, null],
    ["requestPost", `fetch(new Request(url, {method: 'POST'}))`, "fetch"],
    ["requestOptions", `fetch(new Request(url, {method: 'POST'}), {headers: {}})`, "fetch"],
    ["requestGetOverride", `fetch(new Request(url, {method: 'POST'}), {method: 'GET'})`, null],
    ["requestPostOverride", `fetch(new Request(url), {method: 'POST'})`, "fetch"],
    ["requestVariable", `const request: Request = new Request(url); fetch(request)`, "fetch"],
    [
      "requestUnion",
      `const request: string | Request = Math.random() ? url : new Request(url); fetch(request)`,
      "fetch",
    ],
    ["quotedGetter", `fetch(url, {get 'method'() { return 'POST'; }})`, "fetch"],
    ["quotedSetter", `fetch(url, {set 'method'(value: string) {}})`, "fetch"],
    ["quotedMethod", `fetch(url, {'method': 'POST'})`, "fetch"],
    ["fetchPost", `fetch(url, {method: 'POST'})`, "fetch"],
    ["fetchUnknownMethod", `fetch(url, {method})`, "fetch"],
    ["fetchUnknownOptions", `fetch(url, body)`, "fetch"],
    ["fetchSpread", `fetch(url, {...body})`, "fetch"],
    ["clientSpread", `client(...cmd)`, "ghClient"],
    ["fetchArgsSpread", `fetch(...cmd)`, "fetch"],
    ["localUrl", `fetch('http://127.0.0.1/path', {method: 'POST'})`, null],
    ["localUrlSpread", `fetch('https://example.com/', ...cmd)`, null],
    ["localTemplate", `fetch(\`https://example.com/path/\${part}\`, {method: "POST"})`, null],
    ["uncertainOrigin", `fetch(\`https://\${part}/path\`, {method: "POST"})`, "fetch"],
    ["githubTemplate", `fetch(\`https://api.github.com/\${part}\`, {method: "POST"})`, "fetch"],
    ["githubDnsDot", `fetch('https://api.github.com./path', {method: 'POST'})`, "fetch"],
    ["githubDnsDotTemplate", `fetch(\`https://api.github.com./\${part}\`, {method: 'POST'})`, "fetch"],
    ["githubRootDnsDot", `fetch('https://github.com./path', {method: 'POST'})`, "fetch"],
    ["localDnsDot", `fetch('https://example.com./path', {method: 'POST'})`, null],
    ["variableUrl", `fetch(url, {method: 'POST'})`, "fetch"],
  ];
  await fixture(
    {
      "matrix.ts": imports + cases.map(([fn, source]) => `export function ${fn}() { ${source}; }`).join("\n"),
    },
    async (config, dir) => {
      expect(await analyze(config, dir, synthetic)).toEqual(
        cases
          .flatMap(([fn, , root]) => (root ? [{ file: "matrix.ts", fn, root, count: 1 }] : []))
          .sort((a, b) => key(a).localeCompare(key(b))),
      );
    },
  );
}, 30_000);

test("call, apply and bound invocations preserve roots and effective arguments", async () => {
  const cases: [string, string, string | null][] = [
    ["called", `runGh.call(undefined, ['issue', 'comment', '1'])`, "runGh"],
    ["applied", `runGh.apply(undefined, [['issue', 'comment', '1']])`, "runGh"],
    ["fetchCalled", `fetch.call(globalThis, 'https://api.github.com/path', {method: 'POST'})`, "fetch"],
    ["partial", `const write = client.bind(undefined, '/path'); write(body)`, "ghClient"],
    ["immediate", `client.bind(undefined, '/path', body)()`, "ghClient"],
    ["bracketCalled", `runGh['call'](undefined, ['issue', 'comment', '1'])`, "runGh"],
    ["bracketApplied", `runGh['apply'](undefined, [['issue', 'comment', '1']])`, "runGh"],
    ["bracketBound", `const write = client['bind'](undefined, '/path'); write(body)`, "ghClient"],
    [
      "conditionalImmediate",
      `(Math.random() ? client : client.bind(undefined, '/path', body, undefined, undefined, undefined))('/other')`,
      "ghClient",
    ],
    ["typedCalled", `const gh: GhRunner = runGh; gh.call(undefined, ['issue', 'comment'])`, "runGh"],
    [
      "typedBound",
      `const gh: GitHubClient = client; const write = gh.bind(undefined, '/path'); write(body)`,
      "ghClient",
    ],
    [
      "aliasedBound",
      `const first = client.bind(undefined, '/path'); const second = first; second(body)`,
      "ghClient",
    ],
    ["parenthesizedBound", `const write = client.bind(undefined, '/path'); (write)(body)`, "ghClient"],
    ["parenthesizedClient", `(client)('/path', body)`, "ghClient"],
    ["rebound", `const first = client.bind(undefined, '/path'); first.bind(undefined, body)()`, "ghClient"],
    ["boundCalled", `const write = client.bind(undefined, '/path'); write.call(undefined, body)`, "ghClient"],
    [
      "boundApplied",
      `const write = client.bind(undefined, '/path'); write.apply(undefined, [body])`,
      "ghClient",
    ],
    [
      "uncertainApplied",
      `const args: Parameters<typeof client> = ['/path', body]; client.apply(undefined, args)`,
      "ghClient",
    ],
    [
      "spreadApplied",
      `const args: [string, unknown] = ['/path', body]; client.apply(undefined, [...args])`,
      "ghClient",
    ],
    [
      "uncertainBound",
      `const write = Math.random() ? client.bind(undefined, '/path') : client.bind(undefined, '/path', body); write()`,
      "ghClient",
    ],
    [
      "uncertainAppliedRead",
      `const args: Parameters<typeof client> = ['/path']; client.apply(undefined, args)`,
      "ghClient",
    ],
    [
      "spreadBound",
      `const args: Parameters<typeof client> = ['/path', body]; client.bind(undefined, ...args)()`,
      "ghClient",
    ],
    ["calledRead", `runGh.call(undefined, ['api', 'user', '-q', '.login'])`, null],
    ["bracketCalledRead", `runGh['call'](undefined, ['api', 'user'])`, null],
    ["bracketAppliedRead", `runGh['apply'](undefined, [['pr', 'view', '1']])`, null],
    ["bracketBoundRead", `client['bind'](undefined, '/path')()`, null],
    ["appliedRead", `runGh.apply(undefined, [['pr', 'view', '1']])`, null],
    ["fetchCalledRead", `fetch.call(globalThis, 'https://api.github.com/path', {method: 'GET'})`, null],
    ["boundRead", `const read = client.bind(undefined, '/path'); read()`, null],
    ["immediateRead", `runGh.bind(undefined, ['api', 'user'])()`, null],
    ["boundFetchRead", `fetch.bind(globalThis, 'https://api.github.com/path')({method: 'GET'})`, null],
    ["bindOnly", `client.bind(undefined, '/path', body)`, null],
    [
      "unrelated",
      `const obj = {call() {}, apply() {}, bind() { return () => {}; }}; obj.call(); obj.apply(); obj.bind()(); obj['call'](); obj['apply'](); obj['bind']()()`,
      null,
    ],
  ];
  await fixture(
    {
      "indirect.ts":
        imports +
        cases.map(([fn, source]) => `export function ${fn}() { ${source}; }`).join("\n") +
        `export function parameterBound(gh: GitHubClient) { const write = gh.bind(undefined, '/path'); write(body); }
        export function defaultBound(gh: GhRunner, write = gh.bind(undefined, ['issue', 'comment'])) { write(); }
        export class Sender {
          write = client.bind(undefined, '/path');
          send() { this.write(body); }
        }`,
    },
    async (config, dir) => {
      const api = new API({ cwd: dir });
      try {
        const snapshot = await api.updateSnapshot({ openProjects: [config] });
        const project = snapshot.getProject(config);
        if (!project) throw new Error("Missing fixture project");
        expect(await project.program.getSemanticDiagnostics(join(dir, "indirect.ts"))).toEqual([]);
      } finally {
        await api.close();
      }
      expect(await analyze(config, dir, synthetic)).toEqual(
        [
          ...cases,
          ["parameterBound", "", "ghClient"],
          ["defaultBound", "", "runGh"],
          ["Sender/send", "", "ghClient"],
        ]
          .flatMap(([fn, , root]) => (root ? [{ file: "indirect.ts", fn, root, count: 1 }] : []))
          .sort((a, b) => key(a).localeCompare(key(b))),
      );
    },
  );
}, 30_000);

test("caller identities survive unrelated closures, comments and constant renames", async () => {
  const source = (constant: string, comment = "", extra = "", second = "") => `${imports}
const ${constant} = 'send';
export class Sender {
  [${comment} ${constant}]() {
    ${extra}
    [1].map(() => client('/path', body));
    ${second}
  }
}
`;
  const variants = [
    source("key"),
    source("key", "", "[2].map(() => 0);"),
    source("key", "/* unrelated comment */"),
    source("renamed"),
    source("key", "", "", "[2].map(() => client('/other', body));"),
  ];
  const results: Site[][] = [];
  await fixture({ "stable.ts": variants[0] ?? "" }, async (config, dir) => {
    for (const variant of variants) {
      await writeFile(join(dir, "stable.ts"), variant);
      results.push(await analyze(config, dir, synthetic));
    }
  });
  const site = { file: "stable.ts", fn: "Sender/send", root: "ghClient", count: 1 };
  const baseline = [site];
  for (const result of results.slice(0, 4)) expect(result).toEqual(baseline);
  expect(results[4]).toEqual([{ ...site, count: 2 }]);
  expect(() =>
    compare(
      results[4] ?? [],
      baseline.map((s) => ({
        ...s,
        category: "helper",
        reason: "categorized at callers",
      })),
    ),
  ).toThrow("stable.ts | Sender/send | ghClient: expected 1, actual 2 (count)");
}, 30_000);

test("manifest comparator independently rejects unknown, changed and stale sites", () => {
  const site = { file: "src/example.ts", fn: "send", root: "ghClient", count: 1 };
  const entry = { ...site, category: "helper", reason: "categorized at callers" };
  expect(() => compare([site], [])).toThrow(
    "src/example.ts | send | ghClient: expected 0, actual 1 (unknown)",
  );
  expect(() => compare([{ ...site, count: 2 }], [entry])).toThrow(
    "src/example.ts | send | ghClient: expected 1, actual 2 (count)",
  );
  expect(() => compare([], [entry])).toThrow(
    "src/example.ts | send | ghClient: expected 1, actual 0 (stale)",
  );
});

test("manifest hygiene rejects invalid reasons, categories and missing, multiple or unknown owners", () => {
  const entry = {
    file: "src/example.ts",
    fn: "send",
    root: "fetch",
    count: 1,
    category: "exempt",
    reason: "credential exchange",
    owner: "credential",
  };
  validate([entry]);
  for (const patch of [
    { reason: " " },
    { category: "open" },
    { owner: undefined },
    { owner: "C11,C17" },
    { owner: "open" },
    { count: 0 },
  ])
    expect(() => validate([{ ...entry, ...patch }])).toThrow(
      "Invalid manifest entry src/example.ts | send | fetch",
    );
});

test("shared rerun dispatch retains separate observer and land caller categories", () => {
  expect(
    manifest.find((e) => e.root === "ciDecision" && e.file === "src/integrations/github-poller.ts"),
  ).toMatchObject({ category: "observer" });
  expect(manifest.find((e) => e.root === "ciDecision" && e.file === "src/land/queue.ts")).toMatchObject({
    category: "exempt",
    owner: "C17",
  });
  expect(manifest.find((e) => e.root === "Call" && e.fn === "inspectCiInner/requestRerun")).toMatchObject({
    category: "helper",
    reason: "categorized at callers",
    count: 2,
  });
});

test("real async compiler closes on success and analysis failure", async () => {
  const close = spyOn(API.prototype, "close");
  try {
    await fixture({ "empty.ts": imports }, async (config, dir) => {
      expect(await analyze(config, dir, synthetic)).toEqual([]);
    });
    await fixture({ "failure.ts": imports }, async (config, dir) => {
      let failure: unknown;
      try {
        await analyze(config, dir, () => {
          throw new Error("selection failed");
        });
      } catch (error) {
        failure = error;
      }
      expect(failure instanceof Error ? failure.message : failure).toBe("selection failed");
      expect(close).toHaveBeenCalledTimes(2);
    });
  } finally {
    close.mockRestore();
  }
}, 30_000);
