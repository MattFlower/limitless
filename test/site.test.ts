import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
