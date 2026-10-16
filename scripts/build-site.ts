import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const docs = ["README.md", "docs/GUIDE.md", "docs/OPERATIONS.md", "docs/ARCHITECTURE.md", "docs/EVALS.md"];
const pageFor = (source: string) => `docs/${source.split("/").at(-1)?.replace(".md", ".html").toLowerCase()}`;
const escapeHtml = (s: string) => Bun.escapeHTML(s);
const external = (url: string) => /^[a-z][a-z\d+.-]*:|^\/\//i.test(url);

/** A fresh slugger per document; reserve suffixed ids too ("Foo", "Foo-1", "Foo"). */
export function githubSlugger() {
  const used = new Set<string>();
  return (text: string) => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, "")
      .replace(/ /g, "-");
    let slug = base;
    for (let n = 1; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    return slug;
  };
}

export async function outputFiles(dir: string): Promise<string[]> {
  return Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dir, onlyFiles: true }));
}

export function htmlReferences(html: string) {
  const ids = new Set<string>(),
    urls: string[] = [];
  new HTMLRewriter()
    .on("*", {
      element(el) {
        const id = el.getAttribute("id");
        if (id !== null) ids.add(id);
        for (const attr of ["href", "src"]) {
          const url = el.getAttribute(attr);
          if (url !== null) urls.push(url);
        }
      },
    })
    .transform(html);
  return { ids, urls };
}

export async function validateSite(outDir: string) {
  const files = await outputFiles(outDir);
  const pages = new Map(
    await Promise.all(
      files
        .filter((p) => p.endsWith(".html"))
        .map(async (p) => [p, htmlReferences(await readFile(join(outDir, p), "utf8"))] as const),
    ),
  );
  for (const file of files) {
    if (/^(?:docs\/)?(?:plan|backlog|test-performance|reasoning_effort|research)(?:[./]|$)/i.test(file))
      throw new Error(`Excluded doc emitted: ${file}`);
  }
  for (const [page, { urls }] of pages)
    for (const url of urls) {
      if (external(url)) continue;
      const parsed = new URL(url, `https://site.invalid/${page}`);
      const target = decodeURIComponent(parsed.pathname.slice(1));
      const anchor = decodeURIComponent(parsed.hash.slice(1));
      if (url.startsWith("/") || !files.includes(target) || (anchor && !pages.get(target)?.ids.has(anchor)))
        throw new Error(`${page}: broken internal target ${url}`);
    }
}

export async function buildSite(outDir: string, opts: { siteDir?: string } = {}) {
  outDir = resolve(outDir);
  const site = opts.siteDir ?? join(root, "site");
  const landing = await readFile(join(site, "index.html"), "utf8");
  // Check before copying so a missing asset is reported as a landing-page error.
  for (const url of htmlReferences(landing).urls.filter((u) => u.startsWith("screenshots/"))) {
    if (!(await Bun.file(join(site, url)).exists())) throw new Error(`index.html: missing screenshot ${url}`);
  }
  await mkdir(join(outDir, "docs"), { recursive: true });
  await mkdir(join(outDir, "screenshots"), { recursive: true });
  await Bun.write(join(outDir, "index.html"), landing);
  await copyFile(join(site, "style.css"), join(outDir, "style.css"));
  for (const name of await readdir(join(site, "screenshots")))
    if (name.endsWith(".png"))
      await copyFile(join(site, "screenshots", name), join(outDir, "screenshots", name));
  const template = await readFile(join(site, "template.html"), "utf8");
  for (const source of docs) {
    const markdown = await readFile(join(root, source), "utf8");
    const slug = githubSlugger(),
      headings: { level: number; text: string; id: string }[] = [];
    Bun.markdown.render(markdown, {
      heading(text, { level }) {
        headings.push({ level, text, id: slug(text) });
        return "";
      },
    });
    let i = 0;
    let content = Bun.markdown.html(markdown, { tagFilter: true }).replace(/<h([1-6])>/g, (tag) => {
      const heading = headings[i++];
      if (!heading) throw new Error(`${source}: inconsistent heading rendering`);
      return tag.replace(">", ` id="${escapeHtml(heading.id)}">`);
    });
    const links = new Map<string, string>();
    for (const url of htmlReferences(content).urls) {
      if (!url || url.startsWith("#") || external(url)) continue;
      const parsed = new URL(url, `https://repo.invalid/${source}`);
      const path = decodeURIComponent(parsed.pathname.slice(1));
      const doc = docs.find((d) => d === path);
      const directory = !doc && (await stat(join(root, path)).catch(() => null))?.isDirectory();
      links.set(
        url,
        doc
          ? `${relative(dirname(pageFor(source)), pageFor(doc))}${parsed.search}${parsed.hash}`
          : `https://github.com/MattFlower/limitless/${directory ? "tree" : "blob"}/main/${path}${parsed.search}${parsed.hash}`,
      );
    }
    content = new HTMLRewriter()
      .on("*", {
        element(el) {
          for (const attr of ["href", "src"]) {
            const url = el.getAttribute(attr),
              rewritten = url === null ? undefined : links.get(url);
            if (rewritten) el.setAttribute(attr, rewritten);
          }
        },
      })
      .transform(content);
    const nav = `<a href="../index.html">Limitless</a>${docs.map((d) => `<a href="${relative("docs", pageFor(d))}">${escapeHtml(d.split("/").at(-1)?.replace(".md", "") ?? d)}</a>`).join("")}`;
    const toc = headings
      .filter((h) => h.level === 2 || h.level === 3)
      .map(
        (h) => `<li class="level-${h.level}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`,
      )
      .join("");
    await Bun.write(
      join(outDir, pageFor(source)),
      template.replace(
        /\{\{(title|nav|toc|content)\}\}/g,
        (_, key: string) =>
          ({ title: escapeHtml(headings[0]?.text ?? source), nav, toc, content })[key] ?? "",
      ),
    );
  }
  await validateSite(outDir);
}

if (import.meta.main) {
  await buildSite(join(root, "site-dist"));
  console.log("Built site-dist/");
}
