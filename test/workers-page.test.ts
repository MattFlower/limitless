import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import type { TestNode } from "./providers-page-support.ts";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;
const support = join(import.meta.dir, "workers-page-support.ts");
const text = (n: TestNode): string => n.text + n.children.map(text).join("");
const nodes = (n: TestNode): TestNode[] => [n, ...n.children.flatMap(nodes)];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Workers renders capabilities and jobs, refreshes with newest responses and cleans up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "workers-page-"));
  let dispose = () => {};
  try {
    const entry = join(dir, "entry.ts");
    await Bun.write(
      entry,
      `export * from ${JSON.stringify(support)};
      export {Workers} from ${JSON.stringify(join(import.meta.dir, "../ui/pages/Workers.tsx"))};
      export {NavBar} from ${JSON.stringify(join(import.meta.dir, "../ui/components/NavBar.tsx"))};
      export {getWorkers} from ${JSON.stringify(join(import.meta.dir, "../ui/api.ts"))};`,
    );
    const build = await Bun.build({
      entrypoints: [entry],
      outdir: join(dir, "build"),
      target: "bun",
      plugins: [
        {
          name: "workers-mounted",
          setup(builder) {
            builder.onResolve({ filter: /^solid-js$/ }, () => ({
              path: join(import.meta.dir, "../node_modules/solid-js/dist/solid.js"),
            }));
            builder.onResolve({ filter: /^solid-js\/store$/ }, () => ({
              path: join(import.meta.dir, "../node_modules/solid-js/store/dist/store.js"),
            }));
            builder.onLoad({ filter: /\/ui\/store\.ts$/ }, () => ({
              contents: `export * from ${JSON.stringify(support)};`,
              loader: "ts",
            }));
            builder.onLoad({ filter: /\/ui\/api\.ts$/ }, async (args) => ({
              contents:
                (await Bun.file(args.path).text()).replace("globalThis.location", "location") +
                `\nimport {fetch, location} from ${JSON.stringify(support)};`,
              loader: "ts",
            }));
            builder.onLoad({ filter: /\.tsx$/ }, async (args) => {
              let source = await Bun.file(args.path).text();
              if (args.path.endsWith("/NavBar.tsx"))
                source = source.replace(
                  'import { A, useLocation } from "@solidjs/router";',
                  'const useLocation = () => ({pathname:"/workers"}); const A = (props: import("solid-js").JSX.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />;',
                );
              if (args.path.endsWith("/Workers.tsx"))
                source += `\nimport {setInterval, clearInterval, window} from ${JSON.stringify(support)};`;
              const result = await transformAsync(source, {
                filename: args.path,
                parserOpts: { plugins: ["jsx", "typescript"] },
                presets: [
                  [solid, { generate: "universal", moduleName: support }],
                  [ts, {}],
                ],
              });
              return { contents: result?.code ?? "", loader: "js" };
            });
          },
        },
      ],
    });
    expect(build.success).toBe(true);
    const output = build.outputs[0];
    if (!output) throw new Error("missing Workers test build");
    const f = (await import(output.path)) as typeof import("./workers-page-support.ts") & {
      Workers: () => TestNode;
      NavBar: () => TestNode;
      getWorkers: () => Promise<unknown>;
    };
    const root = f.node();
    const respond = (index: number, value: unknown) => f.requests[index]?.resolve(Response.json(value));
    const unavailable = (index: number) =>
      f.requests[index]?.resolve(Response.json({ error: "not found" }, { status: 404 }));
    const refresh = () => {
      const index = f.requests.length;
      f.focus();
      expect(f.requests.slice(index).map((r) => r.path)).toEqual(["/api/workers", "/api/workers/runs"]);
      return index;
    };
    dispose = f.render(() => f.Workers(), root);
    expect(f.requests.map((r) => r.path)).toEqual(["/api/workers", "/api/workers/runs"]);
    respond(0, [{ name: "initial worker", state: "available" }]);
    await flush();
    expect(text(root)).toContain("initial worker"); // History is still pending.
    expect(text(root)).toContain("loading…");
    unavailable(1);
    await flush();
    expect(text(root)).toContain("initial worker");
    expect(text(root)).toContain("Run history unavailable");
    expect(text(root)).not.toContain("loading…");
    f.advanceTimers(9999);
    expect(f.requests).toHaveLength(2);
    f.advanceTimers(1);
    expect(f.requests).toHaveLength(4);
    const workerRows = [
      {
        name: "runner",
        state: "available",
        lastHeartbeatAt: 1000,
        capabilities: { releaseSha: "abcdef123456", privateStringsDigest: "forbidden-parity-digest" },
        agents: {
          claude: { version: "2.1.3", loggedIn: true },
          codex: { version: "0.50.0", loggedIn: false },
        },
        privateStrings: "differs",
        setupWarning: "Worker setup failed: setup",
        agentJobs: [{ id: "job-one", attempt: 2, runId: "active" }],
      },
      { name: "pending", state: "pending", code: "PAIRING", privateStrings: "unknown" },
    ];
    respond(2, workerRows);
    unavailable(3);
    await flush();
    expect(text(root)).toContain("runner");
    expect(text(root)).toContain("Run history unavailable");
    const recovery = refresh();
    respond(recovery, [...workerRows, { name: "focus worker", state: "available" }]);
    await flush();
    expect(text(root)).toContain("focus worker");
    expect(text(root)).toContain("Run history unavailable");
    respond(recovery + 1, [{ runId: "completed", title: "Finished run" }]);
    await flush();
    expect(text(root)).not.toContain("Run history unavailable");
    for (const value of [
      "runner",
      "available",
      "Last heartbeat:",
      "abcdef1",
      "claude: 2.1.3",
      "logged in",
      "codex: 0.50.0",
      "logged out",
      "Private strings: differs",
      "Worker setup failed: setup",
      "job-one",
      "Attempt 2",
      "PAIRING",
      "unknown",
      "Runs that used workers",
      "Finished run",
    ])
      expect(text(root)).toContain(value);
    expect(text(root)).not.toContain("abcdef123456");
    expect(text(root)).not.toContain("forbidden-parity-digest");
    expect(
      nodes(root)
        .filter((n) => n.tag === "a")
        .map((n) => n.props.href),
    ).toEqual(["/runs/active", "/runs/completed"]);
    const staleSuccess = refresh();
    const latestSuccess = refresh();
    respond(latestSuccess, [{ name: "legacy", state: "offline" }]);
    respond(latestSuccess + 1, [{ runId: "latest", title: "Latest run" }]);
    await flush();
    expect(text(root)).toContain("legacy");
    expect(text(root)).toContain("unavailable");
    respond(staleSuccess, []);
    respond(staleSuccess + 1, []);
    await flush();
    expect(text(root)).toContain("legacy");
    expect(text(root)).toContain("Latest run");

    const staleFailure = refresh();
    const empty = refresh();
    respond(empty, []);
    respond(empty + 1, []);
    await flush();
    expect(text(root)).toContain("No paired workers");
    f.requests[staleFailure]?.reject(new Error("stale workers failure"));
    f.requests[staleFailure + 1]?.reject(new Error("stale history failure"));
    await flush();
    expect(text(root)).not.toContain("stale");
    expect(text(root)).not.toContain("Run history unavailable");

    const staleRecovery = refresh();
    const failure = refresh();
    f.requests[failure]?.reject(new Error("Workers request failed"));
    unavailable(failure + 1);
    await flush();
    expect(text(root)).toContain("Workers request failed");
    expect(text(root)).toContain("Run history unavailable");
    respond(staleRecovery, [{ name: "stale worker", state: "available" }]);
    respond(staleRecovery + 1, [{ runId: "stale", title: "Stale run" }]);
    await flush();
    expect(text(root)).not.toContain("stale worker");
    expect(text(root)).not.toContain("Stale run");
    expect(text(root)).toContain("Workers request failed");
    expect(text(root)).toContain("Run history unavailable");

    const independent = refresh();
    respond(independent + 1, [{ runId: "recovered", title: "Recovered history" }]);
    await flush();
    expect(text(root)).toContain("Recovered history"); // Workers is still pending.
    expect(nodes(root).some((n) => n.tag === "a" && n.props.href === "/runs/recovered")).toBe(true);
    expect(text(root)).not.toContain("Run history unavailable");
    f.requests[independent]?.reject(new Error("Workers still unavailable"));
    await flush();
    expect(text(root)).toContain("Workers still unavailable");
    expect(text(root)).toContain("Recovered history");
    const hideHistory = refresh();
    respond(hideHistory, [{ name: "returned worker", state: "available" }]);
    unavailable(hideHistory + 1);
    await flush();
    expect(text(root)).toContain("returned worker");
    expect(text(root)).not.toContain("Workers still unavailable");
    expect(text(root)).not.toContain("Recovered history");
    expect(text(root)).toContain("Run history unavailable");

    const disposedSuccess = refresh();
    const disposedFailure = refresh();
    dispose();
    expect(f.timerCount()).toBe(0);
    expect(f.focusListeners()).toBe(0);
    respond(disposedSuccess, [{ name: "disposed worker" }]);
    respond(disposedSuccess + 1, [{ runId: "disposed", title: "Disposed history" }]);
    f.requests[disposedFailure]?.reject(new Error("disposed workers failure"));
    f.requests[disposedFailure + 1]?.reject(new Error("disposed history failure"));
    await flush();
    expect(text(root)).not.toContain("disposed");
    expect(text(root)).not.toContain("Disposed history");
    f.advanceTimers(10_000);
    f.focus();
    expect(f.requests).toHaveLength(disposedFailure + 2);
    const pending = f.getWorkers();
    f.requests[disposedFailure + 2]?.resolve(new Response("unauthorized", { status: 401 }));
    await expect(pending).rejects.toThrow("unauthorized");
    expect(f.redirects).toEqual(["/login?next=%2Fworkers"]);
    const nav = f.node();
    dispose = f.render(() => f.NavBar(), nav);
    expect(
      nodes(nav).some((n) => n.tag === "a" && n.props.href === "/workers" && text(n) === "Workers"),
    ).toBe(true);
    respond(disposedFailure + 3, { session: null });
    await flush();
  } finally {
    dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
