// Manual demo capture. Importing this module only exposes the safety guard.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function guardScreenshotTarget(
  env: Record<string, string | undefined>,
  port = Number(env.LIMITLESS_PORT ?? 0),
) {
  const home = homedir();
  const defaults = [join(home, ".limitless"), join(home, ".config/limitless")];
  const canonical = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      const parent = dirname(path);
      return parent === path ? path : join(canonical(parent), path.slice(parent.length));
    }
  };
  for (const key of ["LIMITLESS_HOME", "LIMITLESS_CONFIG_DIR"]) {
    const value = env[key];
    if (!value) continue;
    const path = resolve(value.replace(/^~(?=\/|$)/, home));
    // Reject lexical defaults before inspecting any filesystem path.
    if (defaults.includes(path) || defaults.includes(canonical(path)))
      throw new Error(`Refusing screenshot capture: ${key} points to the default installation`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535 || port === 7400)
    throw new Error("Refusing screenshot capture: use a non-default demo port (0 selects a free port)");
}

async function capture() {
  const port = Number(process.env.LIMITLESS_PORT ?? 0);
  guardScreenshotTarget(process.env, port);
  const scratch = mkdtempSync(join(tmpdir(), "limitless-site-"));
  // Only toolchain and scratch locations survive; no inherited credentials or endpoints.
  const keep = new Set(["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot"]);
  for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
  Object.assign(process.env, {
    HOME: scratch,
    XDG_CONFIG_HOME: join(scratch, "config"),
    LIMITLESS_HOME: join(scratch, "home"),
    LIMITLESS_CONFIG_DIR: join(scratch, "config"),
    LIMITLESS_NO_SCHEDULER: "1",
  });
  let factory: import("../src/app.ts").Factory | undefined;
  let server: Awaited<ReturnType<typeof import("../src/server/http.ts").startHttp>> | undefined;
  let browser: import("playwright").Browser | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      try {
        await Promise.allSettled([browser?.close(), server?.stop(true), factory?.stop()]);
      } finally {
        factory?.store.close();
        rmSync(scratch, { recursive: true, force: true });
      }
    })());
  const interrupted = () => {
    void cleanup().finally(() => process.exit(1));
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    const { Factory } = await import("../src/app.ts");
    const { loadConfig } = await import("../src/config.ts");
    const { fakeHarness } = await import("../src/harness/fake.ts");
    const { MODELS, PROVIDERS } = await import("../src/router/catalog.ts");
    const { startHttp } = await import("../src/server/http.ts");
    const { buildUi } = await import("../src/server/ui.ts");
    const { chromium } = await import("playwright");
    const cfg = loadConfig({
      home: join(scratch, "home"),
      configDir: join(scratch, "config"),
      port,
      raw: { server: { host: "127.0.0.1" } },
    });
    const fake = fakeHarness(() => ({ text: "Demo response" }));
    factory = new Factory(cfg, { harnesses: Object.fromEntries(PROVIDERS.map((p) => [p.harness, fake])) });
    const { store } = factory,
      now = Date.now();
    const repo = store.upsertRepo({
      slug: "example/demo",
      kind: "github",
      url: "https://example.com/demo",
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const model = MODELS.find((m) => m.provider === "claude");
    if (!model) throw new Error("Demo model missing from catalog");
    const run = store.createRun(repo, {
      repo: repo.slug,
      prompt: "Add CSV export with tests for quoting and empty input.",
      title: "Add CSV export",
      profile: "standard",
      source: "ui",
    });
    store.updateRun(run.id, {
      status: "succeeded",
      resolvedProfile: "standard",
      stage: "deliver",
      startedAt: now - 300000,
      finishedAt: now,
    });
    const names = [
      "prepare",
      "triage",
      "spec",
      "holdout",
      "implement",
      "gates",
      "audit",
      "review",
      "verify",
      "deliver",
    ] as const;
    for (const [i, name] of names.entries()) {
      const stage = store.startStage(run.id, name);
      store.finishStage(stage.id, "succeeded", `${name}: complete`);
      store.db
        .query("UPDATE stages SET started_at = ?, finished_at = ? WHERE id = ?")
        .run(now - 300000 + i * 30000, now - 270000 + i * 30000, stage.id);
      if (name === "spec" || name === "implement" || name === "review" || name === "verify") {
        store.db
          .query(`INSERT INTO invocations
          (run_id, stage_id, role, harness, provider, model, model_id, status, cost_equiv_usd,
           input_tokens, output_tokens, num_turns, started_at, finished_at, effort)
          VALUES (?, ?, ?, 'claude', ?, ?, ?, 'ok', 0.18, 4200, 850, 3, ?, ?, ?)`)
          .run(
            run.id,
            stage.id,
            name,
            model.provider,
            model.model,
            model.id,
            now - 300000 + i * 30000,
            now - 270000 + i * 30000,
            model.effort ?? "default",
          );
      }
    }
    store.db
      .query(
        "UPDATE runs SET cost_usd = 0, cost_equiv_usd = 0.72, tokens_in = 16800, tokens_out = 3400 WHERE id = ?",
      )
      .run(run.id);
    store.putArtifact(
      run.id,
      "gates-0.json",
      "gates",
      JSON.stringify(
        ["lint", "typecheck", "test"].map((name) => ({
          name,
          verdict: "pass",
          blocking: false,
          result: {
            name,
            command: `bun run ${name}`,
            ok: true,
            exitCode: 0,
            durationMs: 2400,
            output: "Checks passed",
          },
        })),
      ),
    );
    store.putArtifact(
      run.id,
      "review-0.json",
      "review",
      JSON.stringify({
        verdict: "approve",
        summary: "CSV quoting and empty input are covered by tests.",
        findings: [],
        model: model.id,
      }),
    );
    for (const title of ["Improve search filters", "Document the export API"]) {
      const item = store.createRun(repo, { repo: repo.slug, prompt: title, title, source: "ui" });
      if (title.startsWith("Document"))
        store.updateRun(item.id, { status: "succeeded", finishedAt: now - 3600000 });
    }
    const evaluation = store.createEvalRun({ role: "triage", models: [model.id], k: 1, maxUsd: 1 }, []);
    store.db
      .query(`INSERT INTO eval_trials
      (eval_run_id, case_id, model_id, trial, cache_key, harness, status, pass, score,
       details_json, cost_equiv_usd, tokens_in, tokens_out, duration_ms, created_at, effort)
      VALUES (?, 'demo-export', ?, 0, 'demo', 'claude', 'ok', 1, 1, '{}', 0.01, 100, 50, 1200, ?, ?)`)
      .run(evaluation.id, model.id, now, model.effort ?? "default");
    store.updateEvalRun(evaluation.id, "completed");
    for (const provider of ["claude", "codex"])
      factory.tracker.observeWindows(provider, {
        five_hour: { utilization: 0.28, resetsAt: now + 7200000 },
        seven_day: { utilization: 0.42, resetsAt: now + 259200000 },
      });
    factory.start();
    server = await startHttp(factory, { ui: await buildUi() });
    const origin = server.url.origin;
    const binaries = new Bun.Glob("chromium_headless_shell-*/**/chrome-headless-shell{,.exe}").scan({
      cwd: join(import.meta.dir, "../node_modules/playwright-core/.local-browsers"),
      absolute: true,
    });
    const executablePath = (await binaries.next()).value;
    if (!executablePath) throw new Error("Headless browser missing; run bun install first.");
    browser = await chromium.launch({
      executablePath,
      args: ["--single-process", "--no-zygote", "--disable-gpu"],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const targets = [
      ["dashboard", "/", "h1"],
      ["run-detail", `/runs/${run.id}`, ".timeline"],
      ["new-run", "/new", "textarea"],
      ["models", "/models", ".table"],
      ["providers", "/providers", ".provider-card"],
      ["evals", "/evals", ".table"],
      ["setup", "/setup", ".setup-grid"],
    ] as const;
    const destination = join(import.meta.dir, "../site/screenshots");
    for (const [name, path, ready] of targets) {
      await page.setViewportSize({ width: 1440, height: name === "run-detail" ? 1900 : 1000 });
      await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
      await page.locator(ready).first().waitFor();
      if (name === "new-run") {
        await page.getByLabel("Repo", { exact: true }).fill(repo.slug);
        await page.getByLabel("Prompt", { exact: true }).fill(run.prompt);
      }
      if (name === "models")
        await page.getByText("Model catalog", { exact: true }).evaluate((el) => {
          el.style.scrollMarginTop = "80px";
          el.scrollIntoView({ block: "start" });
        });
      await page.screenshot({ path: join(destination, `${name}.png`), fullPage: false });
      if (name === "run-detail") {
        await page.getByRole("button", { name: "review-0.json", exact: true }).click();
        await page.getByText("CSV quoting and empty input are covered by tests.", { exact: true }).waitFor();
        await page.screenshot({ path: join(destination, "run-review.png"), fullPage: false });
      }
    }
    console.log("Captured demo screenshots in site/screenshots/");
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    await cleanup();
  }
}

if (import.meta.main) await capture();
