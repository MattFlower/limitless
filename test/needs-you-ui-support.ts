import { expect } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { type PresetTarget, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import type { renderToString } from "solid-js/web";
import type { RunDetail } from "../src/core/types.ts";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;
// Server-rendered signals and memos never track reads, so the page's own reactive state comes from
// Solid's client build; components still render on the server.
const clientSolid = join(import.meta.dir, "../node_modules/solid-js/dist/solid.js");
const clientStore = join(import.meta.dir, "../node_modules/solid-js/store/dist/store.js");
type Handler = (event?: { currentTarget: { value: string } }) => void | Promise<void>;
export type NeedsYouUi = {
  mount: (detail: RunDetail, initiallyEmpty?: boolean) => void;
  start: () => void;
  dispose: () => void;
  setTimers: (timer: { set: typeof setTimeout; clear: typeof clearTimeout }) => void;
  render: () => ReturnType<typeof renderToString>;
  handlers: Map<string, Handler>;
  navigated: string[];
};
export async function buildNeedsYouUi(dir: string): Promise<NeedsYouUi> {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../ui/pages/RunDetail.tsx")],
    outdir: dir,
    target: "bun",
    plugins: [
      {
        name: "needs-you-ssr-events",
        setup(builder) {
          builder.onResolve({ filter: /^solid-js$/ }, (args) =>
            args.importer === clientStore ? { path: clientSolid } : undefined,
          );
          builder.onLoad({ filter: /\.tsx$/ }, async (args) => {
            let source = await Bun.file(args.path).text();
            if (args.path.endsWith("/RunDetail.tsx")) {
              source = source.replace("onCleanup, onMount, ", "");
              source = source.replace(/import \{ ([^}]+) \} from "solid-js";/, (_line, names: string) => {
                const list = names.split(",").map((name) => name.trim());
                const components = list.filter((name) => /^[A-Z]/.test(name));
                const reactive = list.filter((name) => !/^[A-Z]/.test(name));
                return `import { ${components.join(", ")} } from "solid-js"; import { ${reactive.join(", ")} } from ${JSON.stringify(clientSolid)};`;
              });
              source = source.replace('from "solid-js/store";', `from ${JSON.stringify(clientStore)};`);
              source = source.replace(
                'import { useNavigate, useParams } from "@solidjs/router";',
                "const useNavigate = () => (path: string) => navigated.push(path); const useParams = <T,>(): T => ({ id: fixture.run.id }) as T;",
              );
              source = source.replace(
                "createSignal<Run | null>(null)",
                "createSignal<Run | null>(empty ? null : fixture.run)",
              );
              source = source.replace(
                "createSignal<Detail | null>(null)",
                "createSignal<Detail | null>(empty ? null : fixture)",
              );
              // Keep a render closure so interaction handlers and the next render share the same signals.
              source = source.replace(
                '  return (\n    <div class="page stack">',
                '  const render = () => (\n    <div class="page stack">',
              );
              source = source.replace(
                /\n {2}\);\n};\s*$/,
                "\n  );\n  activeRender = render; return render();\n};",
              );
              for (const action of ["retry", "resolve", "copy"]) {
                source = source.replace(
                  `onClick={() => doAction("${action}")}`,
                  `{...capture("${action}", () => doAction("${action}"))}`,
                );
              }
              source = source.replace(
                "onClick={() => setRetryModelsOpen(true)}",
                '{...capture("retry-models", () => setRetryModelsOpen(true))}',
              );
              source = source.replace(
                "onChange={(e) => setKind(e.currentTarget.value as Kind)}",
                '{...capture("kind", (e: { currentTarget: { value: Kind } }) => setKind(e.currentTarget.value))}',
              );
              for (const field of ["ref", "note"]) {
                const setter = field === "ref" ? "setRef" : "setNote";
                source = source.replace(
                  `onInput={(e) => ${setter}(e.currentTarget.value)}`,
                  `{...capture("${field}", (e: { currentTarget: { value: string } }) => ${setter}(e.currentTarget.value))}`,
                );
              }
              source += `
              let fixture: Detail;
              let empty = false;
              let mounts: (() => void)[] = [], cleanups: (() => void)[] = [];
              const onMount = (fn: () => void) => mounts.push(fn);
              const onCleanup = (fn: () => void) => cleanups.push(fn);
              let timers = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
              const setTimeout = (fn: () => void, ms: number) => timers.set(fn, ms);
              const clearTimeout = (id: ReturnType<typeof globalThis.setTimeout> | undefined) => { if (id !== undefined) timers.clear(id); };
              export const setTimers = (value: typeof timers) => { timers = value; };
              export const start = () => { for (const fn of mounts.splice(0)) fn(); };
              export const dispose = () => { for (const fn of cleanups.splice(0)) fn(); mounts = []; };
              let activeRender: () => ReturnType<typeof RunDetail>;
              export const handlers = new Map();
              export const navigated: string[] = [];
              const capture = (key: string, handler: unknown) => { handlers.set(key, handler); return {}; };
              export const mount = (detail: Detail, initiallyEmpty = false) => { dispose(); empty = initiallyEmpty; fixture = detail; navigated.length = 0; RunDetail({}); };
              export const render = () => { handlers.clear(); return activeRender(); };
            `;
            }
            const transformed = await transformAsync(source, {
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
  return (await import(join(dir, "RunDetail.js"))) as NeedsYouUi;
}
