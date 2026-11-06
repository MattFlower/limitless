import { afterEach, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatePrivacyScope } from "../src/gates/text-privacy.ts";
import { appendLandLog, openLandLog, readLandLog } from "../src/land/land-log.ts";
import { createCredentialRegistry } from "../src/util/credential-matcher.ts";
import { createPrivacyRegistry } from "../src/util/privacy-boundary.ts";
import { createPrivacyChecker } from "../src/util/privacy-checker.ts";
import { registerCredential } from "../src/util/proc.ts";
import { deferred } from "./evals-support.ts";
import { privacyPort, provenResult } from "./privacy-support.ts";

const root = mkdtempSync(join(tmpdir(), "signed-land-"));
afterEach(() => {
  for (const file of new Bun.Glob("*").scanSync(root))
    rmSync(join(root, file), { recursive: true, force: true });
});
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
async function fixture(
  run: (scope: {
    checker: ReturnType<typeof createPrivacyChecker>;
    registry: ReturnType<typeof createPrivacyRegistry>;
    signer: () => Buffer;
  }) => Promise<void>,
) {
  const registry = createPrivacyRegistry(createCredentialRegistry());
  registry.replacePolicy([]);
  const checker = createPrivacyChecker({ registry, workerFactory: privacyPort }),
    scope = { registry, checker, signer: () => Buffer.alloc(32, 37) };
  try {
    await gatePrivacyScope.run(scope, () => run(scope));
  } finally {
    await checker.dispose();
  }
}
const path = join(root, "land.log"),
  withheld = "[land log entry withheld: unproven]\n";

test("appends keep earlier bytes and bindings, while reads take one fresh snapshot", () =>
  fixture(async ({ registry }) => {
    const log = openLandLog(path);
    expect(statSync(`${path}.proof`).mode & 0o777).toBe(0o600);
    await appendLandLog(log, ["first λ\n"]);
    const first = readFileSync(path),
      proof = readFileSync(`${path}.proof`);
    registry.replacePolicy([{ value: "unrelated-policy-entry", entry: 0 }]);
    await appendLandLog(log, ["second\n"]);
    expect(readFileSync(path).subarray(0, first.length)).toEqual(first);
    expect(readFileSync(`${path}.proof`).subarray(0, proof.length)).toEqual(proof);
    const refresh = spyOn(registry, "refreshPolicy");
    try {
      expect(readLandLog(path)).toBe(`${withheld}second\n`);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      refresh.mockRestore();
    }
  }));

test("only projected gate fields and the checker's rendering reach disk", () =>
  fixture(async ({ registry }) => {
    const log = openLandLog(path);
    const gate = await provenResult({
      name: "check",
      command: "true",
      ok: true,
      exitCode: 0,
      durationMs: 1,
      output: "checked tail\n",
      failures: "raw excerpt",
    });
    await appendLandLog(log, ["$ ", gate]);
    expect(readLandLog(path)).toBe("$ true\nchecked tail\n");
    await appendLandLog(log, ["$ ", { ...gate, output: "unproved raw text" }]);
    expect(readFileSync(path, "utf8")).not.toContain("unproved raw text");
    const before = readFileSync(`${path}.proof`, "utf8");
    registry.replacePolicy([{ value: "private-entry", entry: 0 }]);
    await appendLandLog(log, ["contains private-entry\n"]);
    expect(readFileSync(path, "utf8")).toContain("[land log entry withheld: private-match]\n");
    expect(readFileSync(`${path}.proof`, "utf8")).toBe(before);
  }));

test("foreign, malformed, overlapping and out-of-range ranges never grant whole-file trust", () =>
  fixture(async () => {
    const log = openLandLog(path);
    await appendLandLog(log, ["one\n"]);
    appendFileSync(path, "foreign\n");
    await appendLandLog(log, ["two\n"]);
    const lines = readFileSync(`${path}.proof`, "utf8").trim().split("\n");
    writeFileSync(
      `${path}.proof`,
      [lines[0], "null", "bad JSON", lines[0], '{"offset":9999,"length":1}', lines[1]].join("\n"),
    );
    expect(readLandLog(path)).toBe(`one\n${withheld}two\n`);
    rmSync(`${path}.proof`);
    expect(readLandLog(path)).toBe(withheld);
    writeFileSync(path, "legacy text");
    expect(readLandLog(path)).toBe(withheld);
  }));

test("new credentials withhold proved bytes instead of silently redacting them", () =>
  fixture(async () => {
    const log = openLandLog(path),
      text = `credential-${crypto.randomUUID()}`;
    await appendLandLog(log, [text]);
    registerCredential("LAND_RENDERING", text);
    expect(readLandLog(path)).toBe("[land log entry withheld: credential-changed]\n");
  }));

test("queued appends run in call order and settled waits for the delayed checker", () =>
  fixture(async ({ checker }) => {
    const log = openLandLog(path),
      started = deferred<void>(),
      release = deferred<void>(),
      protect = checker.protectText;
    let calls = 0,
      settled = false;
    const spy = spyOn(checker, "protectText").mockImplementation(async (...args) => {
      calls++;
      if (calls === 1) {
        started.resolve();
        await release.promise;
      }
      return protect(...args);
    });
    try {
      const pending = ["one λ\n", "two\n", "three\n"].map((text) => appendLandLog(log, [text]));
      const done = log.settled().then(() => {
        settled = true;
      });
      await started.promise;
      expect(calls).toBe(1);
      expect(settled).toBe(false);
      release.resolve();
      await Promise.all([...pending, done]);
      const bytes = readFileSync(path);
      expect(bytes.toString()).toBe("one λ\ntwo\nthree\n");
      const entries = readFileSync(`${path}.proof`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries.map((e) => bytes.subarray(e.offset, e.offset + e.length).toString())).toEqual([
        "one λ\n",
        "two\n",
        "three\n",
      ]);
      expect(log.length).toBe(bytes.length);
    } finally {
      release.resolve();
      spy.mockRestore();
    }
  }));

test("failed appends do not poison later appends and settled reports the failure", () =>
  fixture(async () => {
    const log = openLandLog(path);
    renameSync(path, `${path}.old`);
    await appendLandLog(log, ["lost\n"]);
    writeFileSync(path, "");
    await appendLandLog(log, ["later\n"]);
    expect(readLandLog(path)).toBe("later\n");
    await expect(log.settled()).rejects.toThrow();
  }));

test("generation changes after the checker await cannot create a proof", () =>
  fixture(async ({ registry, checker }) => {
    const log = openLandLog(path),
      protect = checker.protectText;
    const spy = spyOn(checker, "protectText").mockImplementation(async (...args) => {
      const receipt = await protect(...args);
      registry.replacePolicy([{ value: "changed-policy", entry: 0 }]);
      return receipt;
    });
    try {
      await appendLandLog(log, ["safe entry\n"]);
      expect(readFileSync(path, "utf8")).toBe("[land log entry withheld: stale-generation]\n");
      expect(readFileSync(`${path}.proof`, "utf8")).toBe("");
    } finally {
      spy.mockRestore();
    }
  }));

test("without a key the checked rendering is used but remains unproved", () =>
  fixture(async (scope) => {
    await gatePrivacyScope.run({ ...scope, signer: () => undefined }, async () => {
      const log = openLandLog(path);
      await appendLandLog(log, ["checked\n"]);
      expect(readFileSync(path, "utf8")).toBe("checked\n");
      expect(readFileSync(`${path}.proof`, "utf8")).toBe("");
      expect(readLandLog(path)).toBe(withheld);
    });
  }));
