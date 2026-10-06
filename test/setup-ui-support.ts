import { expect } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { type PresetTarget, types as t, transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import { renderToString } from "solid-js/web";
import type { StreamMessage } from "../src/core/types.ts";

const solid = createRequire(import.meta.url)("babel-preset-solid") as PresetTarget<object>;
export type Ui = {
  mount: (props?: object) => void;
  render: () => string;
  invoke: (
    html: string,
    tag: string,
    text: string,
    event?: string,
    value?: string,
    checked?: boolean,
  ) => Promise<void>;
  emit: (msg: StreamMessage | { kind: "reconnected" }) => void;
  navigated: string[];
  dispose: () => void;
};

/** SSR events exercise the real component handlers; cached render closures retain client signals. */
export async function buildSetupUi(
  dir: string,
  name: "Setup" | "NewRun" | "CatalogForm" | "RetryModels",
): Promise<Ui> {
  const runtime = `
    export const handlers = new Map(), components = new Map(), cleanups = [], listeners = new Set();
    export const navigated = [];
    let sequence = 0, root;
    export const capture = (event, fn) => { const id = String(sequence++); handlers.set(id, fn); return { ['data-ui-' + event.toLowerCase()]: id }; };
    export const onMount = fn => fn();
    export const onCleanup = fn => cleanups.push(fn);
    export function cached(name, props, impl) {
      const key = name + ':' + (props.backend ?? props.run?.id ?? 'root');
      let item = components.get(key);
      if (!item) {
        item = { props }; components.set(key, item);
        item.render = impl(new Proxy({}, { get: (_, key) => item.props[key] }));
      }
      item.props = props;
      return item.render();
    }
    export const emit = msg => { for (const fn of listeners) fn(msg); };
    export const dispose = () => { for (const fn of cleanups.splice(0)) fn(); components.clear(); listeners.clear(); };
    export const mountRoot = (component, props) => { dispose(); root = () => component(props); root(); };
    export const renderRoot = () => { handlers.clear(); sequence = 0; return root(); };
  `;
  const entry = join(
    import.meta.dir,
    `../ui/${name === "Setup" || name === "NewRun" ? "pages" : "components"}/${name}.tsx`,
  );
  const build = await Bun.build({
    entrypoints: [entry],
    outdir: dir,
    target: "bun",
    plugins: [
      {
        name: "setup-ssr-events",
        setup(builder) {
          builder.onResolve({ filter: /^ui-test-runtime$/ }, () => ({
            path: "runtime",
            namespace: "ui-test",
          }));
          builder.onLoad({ filter: /.*/, namespace: "ui-test" }, () => ({ contents: runtime, loader: "js" }));
          builder.onLoad({ filter: /\/ui\/store\.ts$/ }, () => ({
            contents: `import { listeners } from "ui-test-runtime"; export const ensureLiveStore = () => {}; export const subscribeLiveUpdates = fn => { listeners.add(fn); return () => listeners.delete(fn); };`,
            loader: "js",
          }));
          builder.onLoad({ filter: /\.tsx$/ }, async (args) => {
            let source = await Bun.file(args.path).text();
            source = source.replace(/import \{([^}]+)\} from "solid-js";/g, (_line, names: string) => {
              const list = names
                .split(",")
                .map((n) => n.trim())
                .filter((n) => n !== "onMount" && n !== "onCleanup");
              return `import { ${list.filter((n) => /^[A-Z]/.test(n)).join(", ")} } from "solid-js"; import { ${list.filter((n) => !/^[A-Z]/.test(n)).join(", ")} } from ${JSON.stringify(join(import.meta.dir, "../node_modules/solid-js/dist/solid.js"))};`;
            });
            source = source.replace(
              'import { useNavigate } from "@solidjs/router";',
              "const useNavigate = () => path => navigated.push(path);",
            );
            const component = args.path.match(
              /\/(Setup|NewRun|CatalogForm|RetryModels|RunModelPicker)\.tsx$/,
            )?.[1];
            if (component) {
              source = source.replace(
                new RegExp(`export const ${component}(?:: Component)? =`),
                `const ${component}Impl =`,
              );
              const start = source.lastIndexOf("\n  return (");
              source = `${source.slice(0, start)}${source.slice(start).replace("\n  return (", "\n  const render = () => (")}`;
              const end = source.lastIndexOf("\n};");
              source = `${source.slice(0, end)}\n  return render;${source.slice(end)}\nexport const ${component} = props => cached(${JSON.stringify(component)}, props, ${component}Impl);`;
            }
            source = `import { capture, cached, onMount, onCleanup, navigated } from "ui-test-runtime";\n${source}`;
            if (args.path === entry)
              source += `\nexport { mountRoot, renderRoot, handlers, emit, dispose, navigated } from "ui-test-runtime";`;
            const result = await transformAsync(source, {
              filename: args.path,
              parserOpts: { plugins: ["jsx", "typescript"] },
              plugins: [
                () => ({
                  visitor: {
                    JSXElement(path) {
                      const captureAttribute = (attr: t.JSXAttribute | t.JSXSpreadAttribute) => {
                        if (
                          t.isJSXAttribute(attr) &&
                          t.isJSXIdentifier(attr.name) &&
                          /^on(Click|Change|Input|Submit)$/.test(attr.name.name) &&
                          t.isJSXExpressionContainer(attr.value) &&
                          !t.isJSXEmptyExpression(attr.value.expression)
                        )
                          return t.jsxSpreadAttribute(
                            t.callExpression(t.identifier("capture"), [
                              t.stringLiteral(attr.name.name),
                              attr.value.expression,
                            ]),
                          );
                        return attr;
                      };
                      if (
                        t.isJSXIdentifier(path.node.openingElement.name) &&
                        /^[a-z]/.test(path.node.openingElement.name.name)
                      )
                        path.node.openingElement.attributes =
                          path.node.openingElement.attributes.map(captureAttribute);
                      path.traverse({
                        JSXAttribute(child) {
                          const opening = child.parent;
                          if (
                            t.isJSXOpeningElement(opening) &&
                            t.isJSXIdentifier(opening.name) &&
                            /^[a-z]/.test(opening.name.name)
                          )
                            child.replaceWith(captureAttribute(child.node));
                        },
                      });
                    },
                  },
                }),
              ],
              presets: [
                [solid, { generate: "ssr" }],
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
  type Component = (props: object) => string;
  const module = (await import(join(dir, `${name}.js`))) as Record<typeof name, Component> & {
    mountRoot: (component: Component, props: object) => void;
    renderRoot: () => string;
    emit: Ui["emit"];
    dispose: () => void;
    navigated: string[];
    handlers: Map<
      string,
      (event: { currentTarget: { value: string; checked: boolean }; preventDefault: () => void }) => unknown
    >;
  };
  return {
    mount: (props = {}) => module.mountRoot(module[name], props),
    render: () => renderToString(() => module.renderRoot()),
    emit: module.emit,
    dispose: module.dispose,
    navigated: module.navigated,
    invoke: async (html, tag, text, event = "click", value = "", checked = true) => {
      const elements = html.match(new RegExp(`<${tag}\\b[^>]*>(?:[\\s\\S]*?<\\/${tag}>)?`, "g")) ?? [];
      const element = elements.find((e) => e.includes(text));
      const id = element?.match(new RegExp(`data-ui-on${event}="(\\d+)"`))?.[1];
      if (id === undefined) throw new Error(`Missing ${tag} ${text} ${event} in ${html}`);
      const handler = module.handlers.get(id);
      if (!handler) throw new Error(`Missing handler ${id}`);
      await handler({ currentTarget: { value, checked }, preventDefault() {} });
      await settle();
    },
  };
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 15; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
