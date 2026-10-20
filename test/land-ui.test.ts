import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import { renderToString } from "solid-js/web";
import type { LandEntry } from "../src/core/types.ts";
import { createLandController, type LandListState } from "../ui/lib/land.ts";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;
function entry(id: number, state: LandEntry["state"] = "landed", createdAt = id): LandEntry {
  return {
    id,
    state,
    createdAt,
    repo: "test/repo",
    runId: null,
    title: `PR title ${id}`,
    prUrl: `https://github.com/test/repo/pull/${id}`,
    approvedSha: "abcdef12".repeat(5),
    baseBranch: "main",
    headBranch: "feature",
    pushedSha: null,
    ciRerun: null,
    logPath: "checks.log",
    attempts: 1,
    reason: `reason ${id}`,
    updatedAt: 1,
    finishedAt: null,
  };
}

test("Land renders newest first, PRs, SHA tooltips, reasons, logs and only active cancels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-land-ui-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "../ui/pages/Land.tsx")],
      outdir: dir,
      target: "bun",
      plugins: [
        {
          name: "solid-ssr-test",
          setup(builder) {
            builder.onLoad({ filter: /\.tsx$/ }, async (args) => {
              const transformed = await transformAsync(await Bun.file(args.path).text(), {
                filename: args.path,
                parserOpts: { plugins: ["jsx", "typescript"] },
                presets: [
                  [solid, { generate: "ssr" }],
                  [ts, {}],
                ],
              });
              return { contents: transformed?.code ?? "", loader: "js" };
            });
          },
        },
      ],
    });
    expect(build.success).toBe(true);
    const output = build.outputs[0];
    if (!output) throw new Error("Land build produced no output");
    const { LandList } = (await import(output.path)) as typeof import("../ui/pages/Land.tsx");
    const entries = [
      entry(1),
      entry(2, "checking", 3),
      entry(3, "queued", 3),
      { ...entry(4, "cancelled", 0), logPath: null },
    ];
    const html = renderToString(() => LandList({ entries, cancel: () => {}, error: "load failed" }));
    expect(html.indexOf("PR title 3")).toBeLessThan(html.indexOf("PR title 2"));
    expect(html.indexOf("PR title 2")).toBeLessThan(html.indexOf("PR title 1"));
    expect(html.indexOf("PR title 1")).toBeLessThan(html.indexOf("PR title 4"));
    for (const row of entries) {
      expect(html).toContain(row.state);
      expect(html).toContain(`href="${row.prUrl}"`);
      expect(html).toContain(row.reason ?? "");
    }
    expect(html).toContain(`title="${entries[0]?.approvedSha}"`);
    expect(html).toContain(">abcdef12</code>");
    expect(html).toContain('href="/api/land/3/log"');
    expect(html).not.toContain('href="/api/land/4/log"');
    expect(html.match(/>Cancel<\/button>/g)).toHaveLength(2);
    expect(html).toContain('role="alert"');
    expect(html).toContain("load failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controller ignores stale successes and errors, and rereads after successful and failed cancellation", async () => {
  let state: LandListState | undefined;
  const requests: ReturnType<typeof Promise.withResolvers<LandEntry[]>>[] = [];
  const cancels: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const controller = createLandController(
    {
      list: () => {
        const request = Promise.withResolvers<LandEntry[]>();
        requests.push(request);
        return request.promise;
      },
      cancel: () => {
        const request = Promise.withResolvers<void>();
        cancels.push(request);
        return request.promise;
      },
    },
    (next) => {
      state = next;
    },
  );
  const older = controller.load();
  const newer = controller.load();
  requests[1]?.resolve([entry(2), entry(3)]);
  await newer;
  requests[0]?.resolve([entry(1)]);
  await older;
  expect(state?.entries.map((row) => row.id)).toEqual([3, 2]);
  const staleError = controller.load();
  const latest = controller.load();
  requests[3]?.resolve([entry(4, "checking")]);
  await latest;
  requests[2]?.reject(new Error("stale error"));
  await staleError;
  expect(state?.error).toBe("");
  for (const fail of [false, true]) {
    const cancelling = controller.cancel(4);
    expect(state?.cancelling).toEqual([4]);
    const before = requests.length;
    const pending = cancels.at(-1);
    if (fail) pending?.reject(new Error("cancel failed"));
    else pending?.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requests).toHaveLength(before + 1);
    requests.at(-1)?.resolve([entry(4, "cancelled")]);
    await cancelling;
    expect(state?.entries[0]?.state).toBe("cancelled");
    expect(state?.cancelling).toEqual([]);
    expect(state?.error).toBe(fail ? "Error: cancel failed" : "");
  }
  controller.dispose();
});

test("reconnect refreshes coalesce during loads and disposing unsubscribes", async () => {
  const requests: ReturnType<typeof Promise.withResolvers<LandEntry[]>>[] = [];
  let listener: Parameters<NonNullable<Parameters<typeof createLandController>[2]>>[0] = () => {};
  let unsubscribed = false;
  let state: LandListState | undefined;
  const controller = createLandController(
    {
      list: () => {
        const request = Promise.withResolvers<LandEntry[]>();
        requests.push(request);
        return request.promise;
      },
      cancel: async () => {},
    },
    (next) => {
      state = next;
    },
    (callback) => {
      listener = callback;
      return () => {
        unsubscribed = true;
      };
    },
  );
  listener({ kind: "catalog" });
  expect(requests).toHaveLength(0);
  listener({ kind: "reconnected" });
  listener({ kind: "reconnected" });
  listener({ kind: "reconnected" });
  expect(requests).toHaveLength(1);
  requests[0]?.resolve([entry(1)]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(requests).toHaveLength(2);
  requests[1]?.resolve([entry(3), entry(2)]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(requests).toHaveLength(2);
  expect(state?.entries.map((row) => row.id)).toEqual([3, 2]);
  listener({ kind: "reconnected" });
  expect(requests).toHaveLength(3);
  controller.dispose();
  expect(unsubscribed).toBe(true);
  requests[2]?.resolve([entry(4)]);
  listener({ kind: "reconnected" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(requests).toHaveLength(3);
  expect(state?.entries.map((row) => row.id)).toEqual([3, 2]);
});
