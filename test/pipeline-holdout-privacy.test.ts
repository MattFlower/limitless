import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import { ownerDiagnostics } from "../src/db/owner-diagnostics.ts";
import { RunContext, type RunState } from "../src/pipeline/context.ts";
import { renderReport } from "../src/pipeline/report.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
import {
  approve,
  type Handler,
  holdout,
  pass,
  pipelineSetup,
  roleOf,
  spec,
  triage,
  waitFor,
} from "./pipeline-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start } = pipelineSetup({
  get home() {
    return home;
  },
  set home(value) {
    home = value;
  },
  get repoDir() {
    return repoDir;
  },
  set repoDir(value) {
    repoDir = value;
  },
  get factory() {
    return factory;
  },
  set factory(value) {
    factory = value;
  },
});

describe("pipeline (fake agents, real git + gates)", () => {
  test("ordinary verify diagnostics need no owner copy", async () => {
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify")
        return { structured: pass, text: "ordinary verifier diagnostic", error: "ordinary error" };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(ownerDiagnostics(f.store.db, run.id)).toEqual([]);
  });
  test("unmet holdout feedback omits private inputs and publishes scenarios only after delivery", async () => {
    const secret = "PRIVATE_HOLDOUT_TOKEN_729";
    // These values are observed at runtime, not spelled out by the holdout author.
    const observed = '/api/v2/widgets --force 48231 "negative-quantity" ERR_RETRY_EXHAUSTED';
    const observedLiterals = [
      "/api/v2/widgets",
      "--force",
      "48231",
      "negative-quantity",
      "ERR_RETRY_EXHAUSTED",
    ];
    writeFileSync(join(repoDir, "identifiers.ts"), "export const sharedIdentifier = true;\n");
    await sh(["git", "add", "identifiers.ts"], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add identifier"], {
      cwd: repoDir,
    });
    const privateHoldout = {
      scenarios: holdout.scenarios.map((s) =>
        s.id === "H-2"
          ? {
              ...s,
              steps: `run ${secret} with sharedIdentifier and retryIdentifier`,
              description: `secret ${secret} check`,
              expected: `result ${secret}`,
            }
          : s,
      ),
    };
    let implementCalls = 0;
    let verifies = 0;
    let retryFeedbackChecked = false;
    const redactedOutputs: (string | undefined)[] = [];
    let runId = "";
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: privateHoldout };
      if (role === "review") return { structured: approve };
      if (role === "verify") {
        expect(s.prompt).toContain(secret);
        verifies++;
        redactedOutputs.push(s.redactOutput?.(`retryIdentifier ${secret}`));
        const transcript = s.redactOutput?.(observed);
        expect(transcript).toContain("5 private details withheld");
        for (const literal of observedLiterals) expect(transcript).not.toContain(literal);
        return verifies <= 2
          ? {
              text: `ordinary verifier diagnostic; retryIdentifier; private input ${secret}; ${observed}`,
              error: `verifier diagnostic included ${secret}; ${observed}`,
              events: [
                {
                  type: "tool_call",
                  name: "Bash",
                  id: "private-tool",
                  input: { command: `echo ${secret}; ${observed}` },
                },
              ],
              structured: {
                ...pass,
                criteria: pass.criteria.map((c) =>
                  c.id === "H-2"
                    ? {
                        ...c,
                        status: verifies === 1 ? "unmet" : "unclear",
                        evidence: `Observed failure: ${secret} returned an empty response; ${observed}`,
                        publicSummary: `${verifies === 1 ? "sharedIdentifier" : "retryIdentifier"} returns an empty response for an invalid request; ${observed}`,
                      }
                    : c,
                ),
              },
            }
          : { structured: pass };
      }
      implementCalls++;
      if (implementCalls > 1) {
        for (const literal of observedLiterals) {
          expect(s.prompt).not.toContain(literal);
          expect(JSON.stringify(f.store.listEvents(runId))).not.toContain(literal);
          for (const artifact of f.store.listArtifacts(runId))
            expect(f.store.getArtifact(runId, artifact.name)).not.toContain(literal);
        }
        expect(s.prompt).toContain("5 private details withheld");
      }
      if (implementCalls === 2) {
        expect(s.prompt).toContain(
          "private scenario (unmet): sharedIdentifier returns an empty response for an invalid request",
        );
        expect(s.prompt).not.toContain("Observed failure");
        expect(s.prompt).not.toContain(secret);
        expect(s.prompt).not.toContain(privateHoldout.scenarios[1]?.steps);
        expect(f.store.getRunState<RunState>(runId)?.feedback).not.toContain(secret);
        expect(f.store.listArtifacts(runId).map((a) => a.name)).not.toContain("holdout-scenarios.json");
        expect(f.store.getArtifact(runId, "verify-0.json")).toContain("Observed failure");
        expect(f.store.getArtifact(runId, "verify-0.json")).not.toContain(secret);
        expect(JSON.stringify(f.store.listEvents(runId))).not.toContain("retryIdentifier");
        expect(existsSync(join(s.cwd, "holdout-scenarios.json"))).toBe(false);
        for (const artifact of f.store.listArtifacts(runId))
          expect(f.store.getArtifact(runId, artifact.name)).not.toContain(secret);
      }
      if (implementCalls === 3) {
        const summary = "retryIdentifier returns an empty response for an invalid request";
        expect(s.prompt).toContain(`private scenario (unclear): ${summary}`);
        expect(s.prompt).not.toContain("Observed failure");
        expect(s.prompt).not.toContain(secret);
        expect(s.prompt).not.toContain(privateHoldout.scenarios[1]?.steps);
        expect(f.store.getRunState<RunState>(runId)?.feedback).toContain(summary);
        expect(f.store.getArtifact(runId, "holdout-scenarios.json")).toBeNull();
        expect(f.store.getArtifact(runId, "verify-1.json")).toContain(summary);
        expect(f.store.getArtifact(runId, "verify-1.json")).not.toContain(secret);
        expect(JSON.stringify(f.store.listEvents(runId))).toContain(
          "ordinary verifier diagnostic; retryIdentifier; private input [private detail]",
        );
        retryFeedbackChecked = true;
      }
      return {
        files: {
          "farewell.txt": "goodbye\n",
          ...(implementCalls === 2 ? { "retry.ts": "export const retryIdentifier = true;\n" } : {}),
        },
      };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    runId = run.id;
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(implementCalls).toBe(3);
    expect(retryFeedbackChecked).toBe(true);
    expect(redactedOutputs[0]).toBe("[private detail] [private detail] [2 private details withheld]");
    expect(redactedOutputs[1]).toBe("retryIdentifier [private detail] [1 private details withheld]");
    expect(f.store.getArtifact(run.id, "holdout-scenarios.json")).toContain(secret);
    expect(f.store.getArtifact(run.id, "verify-0.json")).toContain("ERR_RETRY_EXHAUSTED");
    const report = f.store.getArtifact(run.id, "report.md") ?? "";
    expect(report).toContain("## Holdout scenarios");
    expect(report).toContain("H-3");
    expect(
      renderReport({
        success: false,
        runId: run.id,
        prompt: run.prompt,
        state: f.store.getRunState<RunState>(run.id) as RunState,
        invocations: [],
        totals: { costUsd: 0, costEquivUsd: 0 },
        runUrl: "u",
      }),
    ).toContain("## Holdout scenarios");
    expect(JSON.stringify(f.store.listEvents(run.id))).not.toContain(secret);
    expect(JSON.stringify(f.store.listEvents(run.id))).toContain("ordinary verifier diagnostic");
    const firstVerify = f.store.listInvocations(run.id).find((inv) => inv.role === "verify");
    expect(firstVerify?.error).toContain("verifier diagnostic included");
    expect(firstVerify?.error).not.toContain(secret);
    const diagnostics = ownerDiagnostics(f.store.db, run.id).filter(
      (d) => d.invocationId === firstVerify?.id,
    );
    expect(diagnostics.find((d) => d.kind === "error")?.text).toBe(
      `verifier diagnostic included ${secret}; ${observed}`,
    );
    expect(diagnostics.find((d) => d.kind === "result")?.text).toContain(
      `private input ${secret}; ${observed}`,
    );
    const event = diagnostics.find((d) => d.eventId !== null && d.text.includes("echo"));
    expect(JSON.parse(event?.text ?? "{}").data.input.command).toBe(`echo ${secret}; ${observed}`);
    expect(f.store.listEvents(run.id).find((e) => e.id === event?.eventId)?.data).toEqual({
      id: "private-tool",
      input: {
        command:
          'echo [private detail]; [private detail] [private detail] [private detail] "[private detail]" [private detail] [6 private details withheld]',
      },
    });
  });

  test("withheld holdout failures keep credential-redacted owner diagnostics, never provider reasons", async () => {
    const marker = "OWNER_HOLDOUT_FAILURE_423";
    const credential = "owner-diagnostic-credential-423";
    registerCredential("OWNER_DIAGNOSTIC_TEST", credential);
    let calls = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      if (role === "holdout") {
        if (++calls === 1)
          return {
            status: "error",
            error: `${marker} ${credential}`,
            text: `${marker} result ${credential}`,
            events: [{ type: "stderr", text: `${marker} event ${credential}` }],
          };
        return { structured: holdout };
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const diagnosticText = JSON.stringify(ownerDiagnostics(f.store.db, run.id));
    for (const suffix of ["", " result", " event"])
      expect(diagnosticText).toContain(`${marker}${suffix} [redacted]`);
    expect(diagnosticText).not.toContain(credential);
    expect(f.store.listInvocations(run.id).find((i) => i.role === "holdout")?.error).toBe(
      "private invocation failed",
    );
    for (const record of [
      f.store.getRunDetail(run.id),
      f.store.getRunState(run.id),
      f.store.listEvents(run.id),
      f.store.db.query("SELECT * FROM provider_state").all(),
    ])
      expect(JSON.stringify(record)).not.toContain(marker);
  });

  describe("unmet holdout classification", () => {
    const secret = "PRIVATE_SCENARIO_INPUT_314";
    const privateHoldout = {
      scenarios: holdout.scenarios.map((s) => (s.id === "H-2" ? { ...s, steps: `run ${secret}` } : s)),
    };
    const unmetH2 = (extra: Record<string, unknown>) => ({
      ...pass,
      criteria: pass.criteria.map((c) =>
        c.id === "H-2"
          ? {
              ...c,
              status: "unmet",
              evidence: `ran ${secret}: the file keeps a stale greeting line, violating "${extra.requirementCitation ?? ""}"`,
              publicSummary: "the file keeps a stale greeting line",
              ...extra,
            }
          : c,
      ),
    });
    const drive = (
      firstVerify: Record<string, unknown>,
      onImplement: (prompt: string, call: number) => void,
      publicSpec = spec,
    ) => {
      let verifies = 0;
      let implementCalls = 0;
      const handler: Handler = (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec")
          return { structured: { ...publicSpec, out_of_scope: ["Delete the old parser"] } };
        if (role === "holdout") return { structured: privateHoldout };
        if (role === "review") return { structured: approve };
        if (role === "verify") {
          expect(s.prompt).toContain(
            "A citation must be either at least three consecutive words quoted exactly, or one whole line of the request (a sentence or bullet) or one whole acceptance criterion, exactly as shown",
          );
          return { structured: ++verifies === 1 ? firstVerify : pass };
        }
        onImplement(s.prompt, ++implementCalls);
        return { files: { "farewell.txt": "goodbye\n" } };
      };
      return { f: start(handler), handler, implementCalls: () => implementCalls, verifies: () => verifies };
    };

    test("a not_required holdout passes verify without another round and is a report follow-up", async () => {
      const { f, implementCalls, verifies } = drive(
        unmetH2({ requirement: "not_required", requirementCitation: "" }),
        () => {},
      );
      const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(implementCalls()).toBe(1);
      expect(verifies()).toBe(1);
      const report = f.store.getArtifact(run.id, "report.md") ?? "";
      expect(report).toContain("Holdouts not met: 0 blocking, 1 not required.");
      expect(report).toContain("**Holdout follow-ups**");
      expect(report).toContain("- H-2: missing input — ran");
      expect(report).toContain("unmet (not required)");
    });

    test.each([
      ["request", "Add a farewell file", "this requirement of the original request", ""],
      ["spec", "farewell.txt exists", "this requirement of the specification", ""],
      ["request", "Add a farewell file", "this requirement of the original request", "uncited evidence"],
      ["spec", "farewell.txt exists", "this requirement of the specification", "uncited evidence"],
    ])(
      "an unmet %s holdout fails verify and names the violated requirement",
      async (requirement, citation, source, evidence) => {
        let checked = false;
        const { f, implementCalls } = drive(
          unmetH2({ requirement, requirementCitation: citation, ...(evidence ? { evidence } : {}) }),
          (prompt, call) => {
            if (call !== 2) return;
            expect(prompt).toContain(`**H-2** violates ${source}: "${citation}"`);
            expect(prompt).toContain("Observed failure: the file keeps a stale greeting line");
            expect(prompt).not.toContain(secret);
            expect(prompt).not.toContain("missing input");
            expect(prompt).not.toContain("[private detail]");
            expect(prompt).not.toContain("Citation validation");
            checked = true;
          },
        );
        const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
        expect(implementCalls()).toBe(2);
        expect(checked).toBe(true);
        const first = f.store.getRunState<RunState>(run.id)?.verifyResults?.[0];
        expect(first?.notes.includes("evidence does not cite the requirement")).toBe(!!evidence);
      },
    );

    test.each([
      ["a fabricated citation", `run ${secret}`],
      ["a missing citation", ""],
      ["an out-of-scope citation", "Delete the old parser"],
    ])(
      "%s is not a failed invocation: the classification still blocks and the citation is withheld",
      async (_label, citation) => {
        let checked = false;
        const { f, implementCalls, verifies } = drive(
          unmetH2({ requirement: "spec", requirementCitation: citation }),
          (prompt, call) => {
            if (call !== 2) return;
            expect(prompt).toContain(
              "**H-2** violates a requirement of the specification (the verifier's citation was not found in it)",
            );
            expect(prompt).toContain("Observed failure: the file keeps a stale greeting line");
            expect(prompt).not.toContain(secret);
            expect(prompt).not.toContain("[private detail]");
            const feedback = prompt.split("### Checks not met")[1] ?? "";
            expect(feedback).not.toContain("Delete the old parser");
            expect(feedback).toContain("check them against the original request and specification above");
            checked = true;
          },
        );
        const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
        const invs = f.store.listInvocations(run.id).filter((i) => i.role === "verify");
        expect(invs.map((i) => i.status)).toEqual(["ok", "ok"]);
        expect(verifies()).toBe(2);
        expect(implementCalls()).toBe(2);
        expect(checked).toBe(true);
        const first = f.store.getRunState<RunState>(run.id)?.verifyResults?.[0];
        expect(first?.overall).toBe("fail");
        expect(first?.criteria.find((c) => c.id === "H-2")?.requirement).toBe("spec");
        expect(first?.notes).toContain("requirement citation validation failed");
      },
    );

    test.each([
      ["Background\n\nOur service uses IPv4.\n\nRequirements\n\n- Support IPv6", "Background", false],
      ["Support IPv6\nKeep IPv4", "Support IPv6", true],
      ["Add a farewell file", "**AC-1** Done", true],
    ] as const)("citation grounding in the fake pipeline: %s / %s", async (request, citation, grounded) => {
      let checked = false;
      const requirement = citation.startsWith("**AC-") ? "spec" : "request";
      const { f, implementCalls } = drive(
        unmetH2({ requirement, requirementCitation: citation }),
        (prompt, call) => {
          if (call !== 2) return;
          const feedback = prompt.split("### Checks not met")[1] ?? "";
          expect(feedback).not.toContain(secret);
          expect(feedback).not.toContain("missing input");
          if (grounded)
            expect(feedback).toContain(
              `violates this requirement of the ${requirement === "spec" ? "specification" : "original request"}:`,
            );
          else {
            expect(feedback).toContain("the verifier's attribution could not be validated");
            expect(feedback).not.toContain("the verifier's citation was not found in it");
            expect(feedback).toContain("check them against the original request and specification above");
          }
          checked = true;
        },
        {
          ...spec,
          acceptance_criteria: [{ id: "AC-1", criterion: "Done", how_to_verify: "cat farewell.txt" }],
        },
      );
      const run = await f.createRun({ repo: repoDir, prompt: request });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(checked).toBe(true);
      expect(implementCalls()).toBe(2);
      const first = f.store.getRunState<RunState>(run.id)?.verifyResults?.[0];
      expect(first?.overall).toBe("fail");
      expect(first?.notes.includes("citation is not a stated public requirement")).toBe(!grounded);
    });

    test("an all-met verify with a non-enum requirement value succeeds instead of failing the invocation", async () => {
      const allMet = { ...pass, criteria: pass.criteria.map((c) => ({ ...c, requirement: "" })) };
      const { f, implementCalls, verifies } = drive(allMet, () => {});
      const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(
        f.store
          .listInvocations(run.id)
          .filter((i) => i.role === "verify")
          .map((i) => i.status),
      ).toEqual(["ok"]);
      expect(verifies()).toBe(1);
      expect(implementCalls()).toBe(1);
    });

    test("verifier output without a requirement field stays blocking on replay", async () => {
      let checked = false;
      const { f, handler, implementCalls, verifies } = drive(unmetH2({}), (prompt, call) => {
        if (call !== 2) return;
        expect(prompt).toContain("private scenario (unmet): the file keeps a stale greeting line");
        expect(prompt).not.toContain(secret);
        checked = true;
      });
      f.deps.faults = {
        "stage:verify:after": {
          action: "kill",
          onHit: ({ runId }) => {
            const state = f.store.getRunState<RunState>(runId);
            const stored = state?.verifyResults?.[0];
            if (!state || !stored) throw new Error("missing stored verification");
            for (const c of stored.criteria) {
              delete c.requirement;
              delete c.requirementCitation;
            }
            stored.overall = "pass"; // Replay must recompute even a stale model-supplied verdict.
            f.store.setRunState(runId, state);
          },
        },
      };
      const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
      const deadline = Date.now() + 10_000;
      while (f.store.listStages(run.id).at(-1)?.status !== "cancelled") {
        if (Date.now() > deadline) throw new Error("verify interruption timed out");
        await Bun.sleep(10);
      }
      await f.stop();
      f.store.close();
      const resumed = start(handler);
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(implementCalls()).toBe(2);
      expect(checked).toBe(true);
      expect(verifies()).toBe(2);
      const first = resumed.store.getRunState<RunState>(run.id)?.verifyResults?.[0];
      expect(first?.overall).toBe("fail");
      expect(first?.criteria.find((c) => c.id === "H-2")?.requirement).toBeNull();
    });
  });

  test("needs-human delivery includes failed holdouts and restores full verify evidence", async () => {
    const secret = "PRIVATE_FAILURE_CASE_872";
    const privateHoldout = {
      scenarios: holdout.scenarios.map((scenario) =>
        scenario.id === "H-2" ? { ...scenario, steps: `run ${secret}` } : scenario,
      ),
    };
    const failedVerify = {
      ...pass,
      criteria: pass.criteria.map((criterion) =>
        criterion.id === "H-2"
          ? {
              ...criterion,
              status: "unmet",
              evidence: `Observed empty output for ${secret}`,
              publicSummary: "",
            }
          : criterion,
      ),
    };
    let runId = "";
    let preDeliveryChecked = false;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: privateHoldout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: failedVerify };
      if (runId && !preDeliveryChecked && f.store.getRunState<RunState>(runId)?.round) {
        preDeliveryChecked = true;
        expect(f.store.getArtifact(runId, "holdout-scenarios.json")).toBeNull();
        expect(f.store.getArtifact(runId, "verify-0.json")).not.toContain(secret);
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    runId = run.id;
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
    expect(preDeliveryChecked).toBe(true);
    expect(f.store.getArtifact(run.id, "holdout-scenarios.json")).toContain(secret);
    expect(f.store.getArtifact(run.id, "verify-0.json")).toContain(secret);
    const report = f.store.getArtifact(run.id, "report.md") ?? "";
    expect(report).toContain("## Holdout scenarios");
    expect(report).toContain("H-2");
    expect(report).toContain(`Observed empty output for ${secret}`);
  });

  test("pre-delivery verify artifacts preserve public evidence and redact private rows on retry", async () => {
    const privateLiterals = [
      "privateDescriptionToken_731",
      "privateStepsToken_732",
      "privateExpectedToken_733",
      "privateEvidenceToken_734",
      "privateSummaryToken_735",
      "privateNotesToken_736",
      "unknownRowToken_737",
      "retryPrivateEvidenceToken_739",
      "privateCanary_731",
    ];
    const [description, steps, expected, evidence, summary, notes, unknown, retryEvidence] = privateLiterals;
    if (!description || !steps || !expected || !evidence || !summary || !notes || !unknown || !retryEvidence)
      throw new Error("missing private test literals");
    const privateHoldout = {
      scenarios: holdout.scenarios.map((scenario, index) => ({
        ...scenario,
        description: `Scenario ${description} privateCanary_731 ${index}`,
        steps: `Run ${steps} ${index}`,
        expected: `Returns ${expected} ${index}`,
      })),
    };
    const publicEvidence =
      'src/farewell.ts:742 publicIdentifier_738 returned 42 instead of 500 with --verbose "enabled"';
    const retryPublicEvidence =
      'src/farewell.ts:42 retryIdentifier_740 returned 500 instead of 42 with --verbose "enabled"';
    const privateEvidence = `Observed ${description} ${steps} ${expected} ${evidence}`;
    const retryPrivateEvidence = `Retry observed ${description} ${steps} ${expected} ${retryEvidence}`;
    let verifies = 0;
    let implementations = 0;
    let runId = "";
    const checkArtifact = (
      name: string,
      expectedPublicStatus: string,
      expectedPrivateStatus: string,
      expectedPublicEvidence: string,
    ) => {
      const raw = f.store.getArtifact(runId, name);
      expect(raw).not.toBeNull();
      const artifact = JSON.parse(raw as string) as typeof pass;
      const publicRow = artifact.criteria.find((criterion) => criterion.id === "AC-1");
      expect(publicRow?.status).toBe(expectedPublicStatus);
      expect(publicRow?.evidence).toBe(
        `${expectedPublicEvidence}; [private detail] [1 private details withheld]`,
      );
      expect(publicRow?.publicSummary).toBe(
        `${expectedPublicEvidence}; [private detail] [1 private details withheld]`,
      );
      for (const id of ["H-1", "H-2", "H-3"]) {
        const row = artifact.criteria.find((criterion) => criterion.id === id);
        expect(row?.id).toBe(id);
        expect(row?.status).toBe(id === "H-1" ? expectedPrivateStatus : "met");
        expect(row?.evidence).toContain("[private detail]");
      }
      expect(artifact.criteria.find((criterion) => criterion.id === "unknown-5")?.evidence).toBe("");
      expect(raw).not.toContain("X-9");
      expect(artifact.criteria.find((criterion) => criterion.id === "H-1")?.publicSummary).toContain(
        "Observed behavior",
      );
      expect(artifact.criteria.find((criterion) => criterion.id === "H-1")?.publicSummary).toContain(
        "[private detail]",
      );
      expect(artifact.criteria.find((criterion) => criterion.id === "H-2")?.publicSummary).toBe("");
      expect(artifact.criteria.find((criterion) => criterion.id === "H-3")?.publicSummary).not.toContain(
        summary,
      );
      for (const literal of privateLiterals) expect(raw).not.toContain(literal);
      expect(raw).not.toContain(`Scenario ${description}`);
      expect(raw).not.toContain(`Run ${steps}`);
      expect(raw).not.toContain(`Returns ${expected}`);
    };
    const publicSources = RunContext.prototype.publicHoldoutSources;
    const legacySpec = spyOn(RunContext.prototype, "publicHoldoutSources").mockImplementation(async function (
      this: RunContext,
    ) {
      this.state.spec = {
        ...spec,
        acceptance_criteria: [
          ...spec.acceptance_criteria,
          { id: "H-1", criterion: "legacy", how_to_verify: "inspect" },
        ],
      };
      return publicSources.call(this);
    });
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: privateHoldout };
      if (role === "review") return { structured: approve };
      if (role === "verify") {
        if (verifies === 2) {
          verifies++;
          return { structured: pass };
        }
        // Simulate a resumed persisted spec that predates ID validation.
        verifies++;
        if (verifies === 2) checkArtifact("verify-0.json", "blocked", "met", publicEvidence);
        return {
          structured: {
            ...pass,
            notes: `Verifier notes ${notes}`,
            criteria: [
              {
                id: "AC-1",
                status: verifies === 1 ? "blocked" : "unmet",
                evidence: `${verifies === 1 ? publicEvidence : retryPublicEvidence}; ${privateHoldout.scenarios[0]?.description}`,
                publicSummary: `${verifies === 1 ? publicEvidence : retryPublicEvidence}; ${privateHoldout.scenarios[0]?.description}`,
              },
              {
                id: "H-1",
                status: verifies === 2 ? "unmet" : "met",
                evidence: verifies === 1 ? privateEvidence : retryPrivateEvidence,
                publicSummary: `Observed behavior ${summary}`,
              },
              {
                id: "H-2",
                status: "met",
                evidence: verifies === 1 ? privateEvidence : retryPrivateEvidence,
                publicSummary: "",
              },
              {
                id: "H-3",
                status: "met",
                evidence: verifies === 1 ? privateEvidence : retryPrivateEvidence,
                publicSummary: summary,
              },
              { id: "X-9", status: "met", evidence: `Extra ${unknown}`, publicSummary: "" },
            ],
          },
        };
      }
      implementations++;
      if (implementations === 2) {
        checkArtifact("verify-0-retry.json", "unmet", "unmet", retryPublicEvidence);
        expect(s.prompt).toContain(retryPublicEvidence);
        expect(s.prompt).toContain("H-1** private scenario (unmet): Observed behavior");
        expect(s.prompt).toContain("[private detail]");
        for (const literal of privateLiterals) expect(s.prompt).not.toContain(literal);
        expect(s.prompt).not.toContain(privateHoldout.scenarios[0]?.description ?? "missing scenario");
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    try {
      const run = await f.createRun({
        repo: repoDir,
        prompt: "Add a farewell file",
      });
      runId = run.id;
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(verifies).toBe(3);
      expect(implementations).toBe(2);
    } finally {
      legacySpec.mockRestore();
    }
  });

  test("blocked verification redacts legacy collisions and unexpected ids before stopping", async () => {
    const secret = "privateBlockedToken_731";
    const credential = "run-error-owner-credential-423";
    registerCredential("OWNER_RUN_ERROR_TEST", credential);
    const unexpectedId = "H-1 unexpected private words";
    const sources = RunContext.prototype.publicHoldoutSources;
    const legacy = spyOn(RunContext.prototype, "publicHoldoutSources").mockImplementation(async function (
      this: RunContext,
    ) {
      this.state.spec = {
        ...spec,
        acceptance_criteria: [
          ...spec.acceptance_criteria,
          { id: "H-1", criterion: "legacy", how_to_verify: "inspect" },
        ],
      };
      return sources.call(this);
    });
    let verifies = 0;
    let runId = "";
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout")
        return {
          structured: { scenarios: holdout.scenarios.map((c) => ({ ...c, steps: `run ${secret}` })) },
        };
      if (role === "review") return { structured: approve };
      if (role === "verify") {
        verifies++;
        if (verifies === 2) {
          const artifact = f.store.getArtifact(runId, "verify-0.json");
          expect(artifact).toContain("unknown-");
          for (const text of [secret, unexpectedId, "unexpected private evidence prose"])
            expect(artifact).not.toContain(text);
        }
        return {
          structured: {
            ...pass,
            criteria: [
              ...pass.criteria.map((c) =>
                c.id === "H-1"
                  ? {
                      ...c,
                      status: "blocked",
                      evidence: `EPERM ${secret} ${credential}`,
                      publicSummary: secret,
                    }
                  : c,
              ),
              {
                id: unexpectedId,
                status: "blocked",
                evidence: "unexpected private evidence prose",
                publicSummary: "",
              },
            ],
          },
        };
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    try {
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
      runId = run.id;
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
      expect(verifies).toBe(2);
      const state = f.store.getRunState<RunState>(run.id);
      for (const output of [state?.terminalReason, state?.needsHumanReason, f.store.getRun(run.id)?.error]) {
        expect(output).toContain("unknown-");
        for (const text of [secret, unexpectedId, "unexpected private evidence prose"])
          expect(output).not.toContain(text);
      }
      expect(state?.terminalReason).toContain("EPERM");
      expect(JSON.stringify(ownerDiagnostics(f.store.db, run.id))).not.toContain(credential);
      expect(ownerDiagnostics(f.store.db, run.id).find((d) => d.kind === "run-error")?.text).toContain(
        "[redacted]",
      );
      expect(ownerDiagnostics(f.store.db, run.id).find((d) => d.kind === "run-error")?.text).toContain(
        secret,
      );
      expect(ownerDiagnostics(f.store.db, run.id).find((d) => d.kind === "run-error")?.text).toContain(
        "unexpected private evidence prose",
      );
    } finally {
      legacy.mockRestore();
    }
  });
});
