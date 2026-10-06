import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateRunRequest } from "../src/core/types.ts";
import { MODELS } from "../src/router/catalog.ts";
import { buildSetupUi, settle } from "./setup-ui-support.ts";

test("New Run renders six optional model pickers, sends ordered groups and displays API errors inline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-new-run-ui-"));
  const previousFetch = globalThis.fetch;
  const ui = await buildSetupUi(dir, "NewRun");
  const sent: CreateRunRequest[] = [];
  let fail = true;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/repos")) return Response.json([{ slug: "owner/repo" }]);
      if (String(input) === "/api/catalog") return Response.json({ models: MODELS, providers: [] });
      sent.push(JSON.parse(String(init?.body)) as CreateRunRequest);
      return fail
        ? Response.json(
            { error: 'models.implement entry "unknown": unknown model ID "unknown"' },
            { status: 400 },
          )
        : Response.json({ id: "created" });
    },
    { preconnect() {} },
  );
  try {
    ui.mount();
    await settle();
    const initial = ui.render();
    expect(initial).toContain("Models (optional)");
    expect(initial).not.toContain("<details open");
    for (const role of ["triage", "spec", "holdout", "implement", "review", "verify"])
      expect(initial).toContain(`${role} override`);
    await ui.invoke(ui.render(), "input", 'id="repo"', "input", "owner/repo");
    await ui.invoke(ui.render(), "textarea", 'id="prompt"', "input", "Try a model");
    const section = (role: string) =>
      ui.render().match(new RegExp(`<section[^>]*aria-label="${role} models"[\\s\\S]*?<\\/section>`))?.[0] ??
      "";
    await ui.invoke(section("implement"), "label", "implement override", "change");
    await ui.invoke(section("implement"), "select", "Group 1 alternative 1 model", "change", "unknown");
    await ui.invoke(section("review"), "label", "review override", "change");
    await ui.invoke(section("review"), "select", "Group 1 alternative 1 model", "change", "claude/opus");
    await ui.invoke(section("review"), "select", "Group 1 alternative 1 effort", "change", "high");
    await ui.invoke(section("review"), "button", "Add alternative");
    await ui.invoke(section("review"), "select", "Group 1 alternative 2 model", "change", "codex/sol");
    await ui.invoke(section("review"), "button", "Add group");
    await ui.invoke(section("review"), "select", "Group 2 alternative 1 model", "change", "codex/luna");
    await ui.invoke(ui.render(), "form", "on", "submit");
    expect(sent[0]?.models).toEqual({
      implement: ["unknown"],
      review: ["claude/opus@high|codex/sol", "codex/luna"],
    });
    const invalid = ui.render();
    expect(invalid).toContain('role="alert"');
    expect(invalid.match(/role="alert"/g)).toHaveLength(1);
    expect(invalid).toContain("unknown model ID");
    expect(invalid).toContain("<details open");
    await ui.invoke(section("implement"), "select", "Group 1 alternative 1 model", "change", "codex/sol");
    fail = false;
    await ui.invoke(ui.render(), "form", "on", "submit");
    expect(sent[1]?.models?.implement).toEqual(["codex/sol"]);
    expect(sent[1]?.models?.triage).toBeUndefined();
    expect(ui.navigated).toEqual(["/runs/created"]);
  } finally {
    ui.dispose();
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
