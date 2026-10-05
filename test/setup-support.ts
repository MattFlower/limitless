import { expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupDeps } from "../src/cli/setup.ts";
import { loadConfig } from "../src/config.ts";
import { assertReadOnlyCommand } from "./fixtures/setup-commands.ts";

export { assertReadOnlyCommand } from "./fixtures/setup-commands.ts";

export function setupFixture(text?: string) {
  const root = mkdtempSync(join(tmpdir(), "limitless-setup-")),
    configDir = join(root, "config"),
    home = join(root, "data");
  mkdirSync(configDir);
  const file = join(configDir, "config.toml"),
    smokeFile = join(home, "smoke-last.json");
  if (text !== undefined) writeFileSync(file, text);
  const output: string[] = [],
    commands: string[] = [],
    effects: string[] = [],
    requests: { url: string; method: string }[] = [];
  const state = { daemon: true, sha: "installed", auth: true, local: true, mcp: false };
  const d = setupDeps({ configDir, home, userHome: join(root, "user"), appDir: join(root, "app") });
  d.url = "http://daemon.invalid";
  d.tty = false;
  d.print = (s) => output.push(s);
  d.run = async (args) => {
    commands.push(args.join(" "));
    assertReadOnlyCommand(args);
    return {
      exitCode: args.join(" ") === "gh auth status" && !state.auth ? 1 : 0,
      stdout:
        args.join(" ") === "git --version"
          ? "git version 2.45.1"
          : args[1] === "rev-parse"
            ? "installed\n"
            : "",
      stderr: "",
    };
  };
  d.fetch = async (url, init) => {
    requests.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/api/health")) {
      if (!state.daemon) throw new Error("unreachable");
      return Response.json({ ok: true, sha: state.sha });
    }
    if (url.endsWith("/api/github/access")) return Response.json([]);
    if (url === "http://127.0.0.1:1234/v1/models" && state.local)
      return Response.json({ data: [{ id: "local-model" }] });
    return new Response("", { status: 503 });
  };
  d.install = async () => {
    effects.push("service");
    state.daemon = true;
    state.sha = "installed";
  };
  d.sleep = async () => {
    effects.push("wait");
  };
  d.smoke = async () => {
    effects.push("smoke");
    return [{ name: "live", status: "pass", durationMs: 1 }];
  };
  d.ask = async () => {
    throw new Error("unexpected prompt");
  };
  d.mcp = async (write) => {
    if (write && !state.mcp) {
      effects.push("mcp");
      state.mcp = true;
    }
    return write ? "already set or registered" : "run limitless integrations install";
  };
  const reload = () => {
    d.config = loadConfig({ configDir, home, readOnly: true });
  };
  const snapshot = () => {
    const scan = (dir: string): unknown[] =>
      existsSync(dir)
        ? readdirSync(dir)
            .sort()
            .map((name): unknown => {
              const path = join(dir, name),
                stat = statSync(path);
              return [path, stat.mtimeMs, stat.isDirectory() ? scan(path) : readFileSync(path, "utf8")];
            })
        : [];
    return scan(root);
  };
  return {
    root,
    configDir,
    home,
    file,
    smokeFile,
    d,
    state,
    output,
    commands,
    requests,
    effects,
    reload,
    snapshot,
    close: () => {
      rmSync(root, { recursive: true, force: true });
      // Doctor catches failed commands; assert here so forbidden calls cannot be swallowed.
      for (const command of commands) expect(() => assertReadOnlyCommand(command.split(" "))).not.toThrow();
    },
  };
}
