import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildSite, githubSlugger, outputFiles, validateSite } from "../scripts/build-site.ts";
import { guardScreenshotTarget } from "../scripts/site-screenshots.ts";
import { isInertMedia } from "../src/gates/media.ts";

const root = resolve(import.meta.dir, "..");
let scratch: string, out: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "site-test-"));
  out = join(scratch, "output");
  await buildSite(out);
});
afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});
const html = (page: string) => readFile(join(out, page), "utf8");
async function fixture(markdown: string) {
  const sourceRoot = await mkdtemp(join(scratch, "source-"));
  await mkdir(join(sourceRoot, "docs/research"), { recursive: true });
  await mkdir(join(sourceRoot, "src"));
  const siteDir = join(sourceRoot, "site");
  await mkdir(join(siteDir, "screenshots"), { recursive: true });
  await writeFile(join(siteDir, "index.html"), '<a href="docs/readme.html">Docs</a>');
  await writeFile(join(siteDir, "style.css"), "");
  await cp(join(root, "site/template.html"), join(siteDir, "template.html"));
  await writeFile(join(sourceRoot, "README.md"), `# Fixture\n\n${markdown}`);
  for (const name of ["GUIDE", "OPERATIONS", "ARCHITECTURE", "EVALS", "PLAN"])
    await writeFile(join(sourceRoot, `docs/${name}.md`), `# ${name}\n\n## Target\n`);
  await writeFile(join(sourceRoot, "src/example.ts"), "export {};\n");
  const output = join(sourceRoot, "output");
  return { sourceRoot, output, build: () => buildSite(output, { sourceRoot, siteDir }) };
}
// Independently inspect rendered HTML, including same-page anchors and image sources.
function inspect(source: string) {
  const ids: string[] = [],
    urls: string[] = [],
    images: string[] = [];
  new HTMLRewriter()
    .on("*", {
      element(el) {
        const id = el.getAttribute("id");
        if (id !== null) ids.push(id);
        for (const key of ["href", "src"]) {
          const url = el.getAttribute(key);
          if (url !== null) urls.push(url);
        }
        if (el.tagName === "img") images.push(el.getAttribute("src") ?? "");
      },
    })
    .transform(source);
  return { ids, urls, images };
}

test("complete site: relative URLs and anchors resolve; only five docs; inert screenshots", async () => {
  const files = await outputFiles(out);
  expect(files.filter((p) => p.endsWith(".html")).sort()).toEqual([
    "docs/architecture.html",
    "docs/evals.html",
    "docs/guide.html",
    "docs/operations.html",
    "docs/readme.html",
    "index.html",
  ]);
  expect(files.some((p) => /plan|backlog|test-performance|reasoning|research/i.test(p))).toBe(false);
  for (const page of files.filter((p) => p.endsWith(".html"))) {
    const source = await html(page);
    expect(source).not.toMatch(/<script\b|<link[^>]+href=["']https?:/i);
    for (const url of inspect(source).urls) {
      expect(url.startsWith("/")).toBe(false);
      if (/^[a-z][a-z\d+.-]*:/i.test(url)) continue;
      expect(url).not.toMatch(/\.md(?:#|$)|\/limitless\//i);
      const target = new URL(url, `https://example.com/${page}`);
      const path = decodeURIComponent(target.pathname.slice(1));
      expect(files, `${page} → ${url}`).toContain(path);
      if (target.hash)
        expect(inspect(await html(path)).ids, `${page} → ${url}`).toContain(
          decodeURIComponent(target.hash.slice(1)),
        );
    }
    if (page.startsWith("docs/")) {
      expect(source).toContain('aria-label="Documentation"');
      expect(source).toContain("On this page");
    }
  }
  for (const [page, id] of [
    ["guide", "1-what-limitless-is"],
    ["guide", "providers-1"],
    ["architecture", "landing-the-land-queue"],
    ["readme", "configuration"],
  ] as const)
    expect(inspect(await html(`docs/${page}.html`)).ids).toContain(id);
  const images = inspect(await html("index.html")).images;
  expect(images.length).toBeGreaterThanOrEqual(7);
  for (const image of images) {
    const bytes = await readFile(join(root, "site", image));
    expect(await readFile(join(out, image))).toEqual(bytes);
    expect(isInertMedia(image, bytes)).toBe(true);
  }
  for (const png of (await outputFiles(join(root, "site/screenshots"))).filter((p) => p.endsWith(".png")))
    expect(isInertMedia(png, await readFile(join(root, "site/screenshots", png)))).toBe(true);
  expect(await readFile(join(out, "style.css"), "utf8")).not.toMatch(/@import|url\(["']?https?:/i);
});

test("doc and source-tree links resolve relative to Markdown location", async () => {
  const guide = inspect(await html("docs/guide.html")).urls;
  expect(guide).toContain("readme.html#configuration");
  expect(guide).toContain("evals.html#policy-generation-and-review");
  expect(guide).toContain("https://github.com/MattFlower/limitless/blob/main/docs/PLAN.md");
  const readme = inspect(await html("docs/readme.html")).urls;
  expect(readme).toContain("guide.html");
  expect(
    readme.some((u) =>
      /^https:\/\/github.com\/MattFlower\/limitless\/tree\/main\/docs\/research\/?$/.test(u),
    ),
  ).toBe(true);
  // The current guide links directly to queue.ts; architecture links into that guide section.
  expect(guide).toContain("https://github.com/MattFlower/limitless/blob/main/src/land/queue.ts");
});

test("raw HTML becomes text while Markdown and fenced HTML remain intact", async () => {
  const raw =
    '<img src="https://example.com/missing.png" onerror="alert(document.domain)"><a href="javascript:alert(1)">unsafe</a>';
  const source = await fixture(`${raw}\n\n**Bold** and *italic*.\n\n\`\`\`html\n${raw}\n\`\`\``);
  await source.build();
  const rendered = await readFile(join(source.output, "docs/readme.html"), "utf8");
  const active: string[] = [];
  new HTMLRewriter()
    .on("img, [onerror], a[href^='javascript:']", {
      element(el) {
        active.push(el.tagName);
      },
    })
    .transform(rendered);
  expect(active).toEqual([]);
  expect(rendered).toContain(`<p>${Bun.escapeHTML(raw)}</p>`);
  expect(rendered).toContain(`<pre><code class="language-html">${Bun.escapeHTML(raw)}\n</code></pre>`);
  expect(rendered).toContain("<strong>Bold</strong> and <em>italic</em>");
});

test.each([
  "javascript:alert(1)",
  "data:text/html,unsafe",
  "vbscript:unsafe",
  "ftp://example.com/file",
  "jav&#x61;script&colon;alert(1)",
  "&#106;avascript&#58;alert(1)",
  "java&Tab;script:alert(1)",
  "java&#10;script:alert(1)",
  "javascript\\:alert(1)",
])("rejects unsafe link and image destination %s with document diagnostics", async (url) => {
  for (const prefix of ["", "!"]) {
    const source = await fixture(`${prefix}[unsafe](${url})`);
    await expect(source.build()).rejects.toThrow(`README.md: unsafe destination ${url.replace("\\:", ":")}`);
  }
});

test("safe destinations and existing repository targets preserve queries and fragments", async () => {
  const source = await fixture(`
[http](http://example.com/)
[https](https://example.com/?a=1&b=2)
[mail](mailto:demo@example.com)
![safe image](https://example.com/image.png)
[guide](docs/GUIDE.md?mode=print&view=all#target)
[literal entity in query](docs/GUIDE.md?name=one&amp;copy;two#target)
[source](src/example.ts?plain=1#L1)
[directory](docs/research/?view=all#readme)
[excluded](docs/PLAN.md#target)
[self](#fixture)
`);
  await source.build();
  const rendered = await readFile(join(source.output, "docs/readme.html"), "utf8");
  // HTMLRewriter exposes encoded attributes; the browser decodes the ampersand once.
  expect(inspect(rendered).urls).toEqual(
    expect.arrayContaining([
      "http://example.com/",
      "https://example.com/?a=1&amp;b=2",
      "mailto:demo@example.com",
      "https://example.com/image.png",
      "guide.html?mode=print&amp;view=all#target",
      "guide.html?name=one&amp;copy;two#target",
      "https://github.com/MattFlower/limitless/blob/main/src/example.ts?plain=1#L1",
      "https://github.com/MattFlower/limitless/tree/main/docs/research/?view=all#readme",
      "https://github.com/MattFlower/limitless/blob/main/docs/PLAN.md#target",
      "#fixture",
    ]),
  );
});

test.each(["docs/OPERATI0NS.md", "src/missing.ts?plain=1#L2", "src/missing.ts?a=1&amp;b=2"])(
  "missing repository reference %s fails before becoming an external URL",
  async (url) => {
    for (const prefix of ["", "!"]) {
      const source = await fixture(`${prefix}[missing](${url})`);
      await expect(source.build()).rejects.toThrow(`README.md: missing repository target ${url}`);
    }
  },
);

test("a rendered-doc target must exist before its URL is rewritten", async () => {
  const source = await fixture("[operations](docs/OPERATIONS.md#target)");
  await rm(join(source.sourceRoot, "docs/OPERATIONS.md"));
  await expect(source.build()).rejects.toThrow(
    "README.md: missing repository target docs/OPERATIONS.md#target",
  );
});

test("Mermaid links to its enclosing GitHub section and keeps escaped, collapsed source", async () => {
  const guide = await html("docs/guide.html");
  expect(inspect(guide).urls).toContain(
    "https://github.com/MattFlower/limitless/blob/main/docs/GUIDE.md#the-pipeline",
  );
  expect(guide).toContain(
    '<details><summary>Mermaid source</summary><pre><code class="language-mermaid">flowchart LR',
  );
  expect(guide).toContain("prepare[&quot;prepare&lt;br/&gt;worktree + baseline checks&quot;]");
  const source = await fixture('## Stage\n\n## Stage\n\n```mermaid\nA --> B["<img onerror=alert(1)>"]\n```');
  await source.build();
  const rendered = await readFile(join(source.output, "docs/readme.html"), "utf8");
  expect(inspect(rendered).urls).toContain(
    "https://github.com/MattFlower/limitless/blob/main/README.md#stage-1",
  );
  let details = 0;
  for (const page of [guide, rendered])
    new HTMLRewriter()
      .on("main details", {
        element(el) {
          details++;
          expect(el.hasAttribute("open")).toBe(false);
        },
      })
      .transform(page);
  expect(details).toBe(2);
  expect(inspect(rendered).images).toEqual([]);
  expect(rendered).toContain("&lt;img onerror=alert(1)&gt;");
});

test("GitHub slugs preserve adjacent hyphens and reserve duplicate suffixes", () => {
  const slug = githubSlugger();
  expect(slug("Foo Bar: `baz` & co.")).toBe("foo-bar-baz--co");
  expect(slug("Foo Bar: `baz` & co.")).toBe("foo-bar-baz--co-1");
  expect(slug("Foo Bar: `baz` & co.")).toBe("foo-bar-baz--co-2");
  expect(slug("8. Troubleshooting / FAQ")).toBe("8-troubleshooting--faq");
  expect(slug("foo")).toBe("foo");
  expect(slug("foo-1")).toBe("foo-1");
  expect(slug("foo")).toBe("foo-2");
});

test("build names missing screenshots; validation names missing files and anchors", async () => {
  const site = join(scratch, "missing-site");
  await cp(join(root, "site"), site, { recursive: true });
  await rm(join(site, "screenshots/dashboard.png"));
  await expect(buildSite(join(scratch, "missing-output"), { siteDir: site })).rejects.toThrow(
    "index.html: missing screenshot screenshots/dashboard.png",
  );
  const broken = join(scratch, "broken");
  await cp(out, broken, { recursive: true });
  for (const target of ["docs/missing.html", "docs/guide.html#missing-heading"]) {
    await writeFile(join(broken, "index.html"), `<a href="${target}">Broken</a>`);
    await expect(validateSite(broken)).rejects.toThrow(`index.html: broken internal target ${target}`);
  }
  await writeFile(join(broken, "docs/plan.html"), "excluded");
  await expect(validateSite(broken)).rejects.toThrow("Excluded doc emitted: docs/plan.html");
});

test("screenshot guard rejects default paths and port before side effects", async () => {
  for (const [key, path] of [
    ["LIMITLESS_HOME", ".limitless"],
    ["LIMITLESS_CONFIG_DIR", ".config/limitless"],
  ])
    for (const value of [join(homedir(), path ?? ""), `${join(homedir(), path ?? "")}/`, `~/${path}`])
      expect(() => guardScreenshotTarget({ [key ?? ""]: value })).toThrow("Refusing screenshot capture");
  expect(() =>
    guardScreenshotTarget({ LIMITLESS_HOME: scratch, LIMITLESS_CONFIG_DIR: dirname(scratch) }),
  ).not.toThrow();
  expect(() => guardScreenshotTarget({}, 7400)).toThrow("non-default demo port");
  const child = Bun.spawn([process.execPath, join(root, "scripts/site-screenshots.ts")], {
    env: { ...process.env, LIMITLESS_HOME: join(homedir(), ".limitless") },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  try {
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain("Refusing screenshot capture");
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test("Pages deployment pins actions, Bun, triggers and least-privilege permissions", async () => {
  const workflow = await readFile(join(root, ".github/workflows/pages.yml"), "utf8");
  const ci = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
  expect(workflow.match(/bun-version: (\S+)/)?.[1]).toBe(ci.match(/bun-version: (\S+)/)?.[1]);
  for (const line of workflow.split("\n").filter((l) => l.includes("uses:")))
    expect(line).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  for (const path of [
    "site/**",
    "README.md",
    ...["GUIDE", "OPERATIONS", "ARCHITECTURE", "EVALS"].map((d) => `docs/${d}.md`),
    "scripts/build-site.ts",
    ".github/workflows/pages.yml",
  ])
    expect(workflow).toContain(`- '${path}'`);
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("branches: [main]");
  expect(workflow).toContain("concurrency:\n  group: pages");
  expect(workflow.match(/^permissions:\n( {2}.+\n)+/m)?.[0]).toBe("permissions:\n  contents: read\n");
  for (const permission of ["pages: write", "id-token: write"]) {
    expect(workflow.split(permission)).toHaveLength(2);
    expect(workflow.split("  deploy:\n")[1]).toContain(permission);
  }
  for (const action of ["configure-pages", "upload-pages-artifact", "deploy-pages"])
    expect(workflow).toContain(`actions/${action}@`);
  expect(workflow).toContain("name: github-pages");
  expect(workflow).toContain("path: site-dist");
});
