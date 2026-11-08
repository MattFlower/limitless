import { afterEach, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLandLog, openLandLog, readLandLog } from "../src/land/land-log.ts";
import { createPrivacyRegistry } from "../src/util/privacy-boundary.ts";
import { createPrivacyChecker } from "../src/util/privacy-checker.ts";
import { provisionPrivacyPolicy } from "../src/util/privacy-policy.ts";
import { registerCredential } from "../src/util/proc.ts";
import { privacyPort } from "./privacy-support.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "land-log-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const registry = createPrivacyRegistry();
  provisionPrivacyPolicy(dir, [], { registry });
  const checker = createPrivacyChecker({ registry, workerFactory: privacyPort });
  cleanups.push(() => checker.dispose());
  const privacy = { checker, signer: () => Buffer.alloc(32, 37) };
  const path = join(dir, "land.log"),
    log = openLandLog(path, "header\n", privacy);
  return {
    dir,
    registry,
    checker,
    privacy,
    path,
    log,
    read: () => readLandLog(path, privacy),
    proofs: () => readFileSync(`${path}.proof`, "utf8").trim().split("\n"),
  };
}
test("entries retain their original policy binding without renewing earlier proofs", async () => {
  const f = fixture();
  await appendLandLog(f.log, ["first entry\n"]);
  const earlier = readFileSync(`${f.path}.proof`, "utf8");
  writeFileSync(join(f.dir, "private-strings.txt"), "new-private-value\n");
  await appendLandLog(f.log, ["second entry\n"]);
  expect(readFileSync(`${f.path}.proof`, "utf8")).toStartWith(earlier);
  expect(await f.read()).not.toContain("first entry");
  expect(await f.read()).toContain("[land log entry withheld:");
  expect(await f.read()).toEndWith("second entry\n");
  expect(statSync(`${f.path}.proof`).mode & 0o777).toBe(0o600);
});
test.each(["refusal", "generation", "missing-key"])(
  "%s appends only a marker without a proof",
  async (kind) => {
    const f = fixture();
    await f.log.pending;
    const before = f.proofs();
    if (kind === "refusal") writeFileSync(join(f.dir, "private-strings.txt"), "blocked-entry\n");
    if (kind === "missing-key") f.log.privacy.signer = () => undefined;
    const protect = f.checker.protectText;
    const spy = spyOn(f.checker, "protectText").mockImplementation(async (...args) => {
      const receipt = await protect(...args);
      if (kind === "generation") f.registry.addCredential("changed-generation");
      return receipt;
    });
    try {
      await appendLandLog(f.log, ["blocked-entry"]);
    } finally {
      spy.mockRestore();
    }
    expect(f.proofs()).toEqual(before);
    expect(readFileSync(f.path, "utf8")).toContain("[land log entry withheld:");
    expect(await f.read()).not.toContain("blocked-entry");
  },
);
test("foreign, malformed, overlapping and out-of-range records cover no private bytes", async () => {
  const f = fixture();
  await appendLandLog(f.log, ["verified π\n"]);
  const privateValue = `foreign-${crypto.randomUUID()}`;
  appendFileSync(f.path, `${privateValue}\n`);
  const first = JSON.parse(f.proofs()[0] ?? "{}");
  appendFileSync(
    `${f.path}.proof`,
    `garbage\n${JSON.stringify(first)}\n${JSON.stringify({ ...first, offset: 99999 })}\nnull\n`,
  );
  expect(await f.read()).toBe("header\nverified π\n[land log entry withheld: unverified]");
  writeFileSync(f.path, privateValue);
  rmSync(`${f.path}.proof`);
  expect(await f.read()).toBe("[land log entry withheld: unverified]");
});
test("concurrent appends serialize checks and writes in call order", async () => {
  const f = fixture();
  await f.log.pending;
  let release = () => {},
    entered = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const protect = f.checker.protectText,
    seen: string[] = [];
  const spy = spyOn(f.checker, "protectText").mockImplementation(async (input, control) => {
    seen.push(input.text);
    if (input.text === "first\n") {
      entered();
      await hold;
    }
    return protect(input, control);
  });
  try {
    const first = appendLandLog(f.log, ["first\n"]),
      second = appendLandLog(f.log, ["second\n"]);
    await started;
    expect(seen).toEqual(["first\n"]);
    release();
    await Promise.all([first, second]);
    expect(await f.read()).toBe("header\nfirst\nsecond\n");
    const entries = f.proofs().map((line) => JSON.parse(line));
    expect(entries.map((e) => e.offset)).toEqual([0, 7, 13]);
  } finally {
    release();
    spy.mockRestore();
  }
});
test("failed writes settle and later appends continue; reopening truncates both files", async () => {
  const f = fixture();
  await f.log.pending;
  const proof = readFileSync(`${f.path}.proof`, "utf8");
  rmSync(f.path);
  mkdirSync(f.path);
  await appendLandLog(f.log, ["lost"]);
  expect(readFileSync(`${f.path}.proof`, "utf8")).toBe(proof);
  rmSync(f.path, { recursive: true });
  writeFileSync(f.path, "header\n");
  await appendLandLog(f.log, ["kept"]);
  expect(await f.read()).toBe("header\nkept");
  const next = openLandLog(f.path, "new attempt", f.privacy);
  await next.pending;
  expect(await f.read()).toBe("new attempt");
  expect(f.proofs()).toHaveLength(1);
  rmSync(`${f.path}.proof`);
  await appendLandLog(next, ["recreated"]);
  expect(statSync(`${f.path}.proof`).mode & 0o777).toBe(0o600);
  expect(await f.read()).toBe("[land log entry withheld: unverified]recreated");
});
test("verified bytes changed by credential redaction are withheld", async () => {
  const f = fixture(),
    text = `later-credential-${crypto.randomUUID()}`;
  await appendLandLog(f.log, [text]);
  registerCredential("LAND_LOG_LATER", text);
  expect(await f.read()).toBe("header\n[land log entry withheld: credential-changed]");
});
test("saved URL entries with a newly registered encoded credential are withheld without renewing proofs", async () => {
  const f = fixture(),
    token = `late+/${crypto.randomUUID()}=`,
    url = `https://example.com/check?token=${encodeURIComponent(token)}`,
    clean = "https://example.com/check?value=clean%2B%2F%3D\n";
  await appendLandLog(f.log, [url]);
  await appendLandLog(f.log, [clean]);
  const proofs = readFileSync(`${f.path}.proof`, "utf8");
  expect(await f.read()).toBe(`header\n${url}${clean}`);
  registerCredential("LAND_LOG_ENCODED_LATER", token);
  expect(await f.read()).toBe(`header\n[land log entry withheld: credential-changed]${clean}`);
  expect(readFileSync(`${f.path}.proof`, "utf8")).toBe(proofs);
});

test("reads yield between batches and keep one policy snapshot for the whole read", async () => {
  const f = fixture(),
    text = "entry\n",
    count = 384;
  await appendLandLog(f.log, [text]);
  const proof = JSON.parse(f.proofs().at(-1) ?? "{}");
  writeFileSync(f.path, text.repeat(count));
  writeFileSync(
    `${f.path}.proof`,
    Array.from(
      { length: count },
      (_, i) => `${JSON.stringify({ offset: i * text.length, length: text.length, mac: proof.mac })}\n`,
    ).join(""),
  );
  const refresh = spyOn(f.registry, "refreshPolicy");
  let yielded = false;
  const turn = new Promise<void>((resolve) =>
    setImmediate(() => {
      yielded = true;
      writeFileSync(join(f.dir, "private-strings.txt"), "new-private-entry\n");
      resolve();
    }),
  );
  try {
    const reading = f.read();
    expect(yielded).toBe(false);
    expect(await reading).toBe(text.repeat(count));
    expect(yielded).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await f.read()).not.toContain(text);
  } finally {
    await turn;
    refresh.mockRestore();
  }
});

test.each(["literal", "encoded"])(
  "credentials registered during a yielded read withhold earlier %s entries",
  async (kind) => {
    const f = fixture(),
      token = `during+/${crypto.randomUUID()}=`,
      text = `https://example.com/check?token=${kind === "encoded" ? encodeURIComponent(token) : token}\n`,
      count = 384;
    await appendLandLog(f.log, [text]);
    const proof = JSON.parse(f.proofs().at(-1) ?? "{}");
    writeFileSync(f.path, text.repeat(count));
    writeFileSync(
      `${f.path}.proof`,
      Array.from(
        { length: count },
        (_, i) => `${JSON.stringify({ offset: i * text.length, length: text.length, mac: proof.mac })}\n`,
      ).join(""),
    );
    const proofs = readFileSync(`${f.path}.proof`, "utf8");
    let registered = false;
    const turn = new Promise<void>((resolve) =>
      setImmediate(() => {
        registerCredential("LAND_LOG_DURING_READ", token);
        registered = true;
        resolve();
      }),
    );
    try {
      const result = await f.read();
      expect(registered).toBe(true);
      expect(result).not.toContain(text);
      expect(result).toBe("[land log entry withheld: credential-changed]".repeat(count));
      expect(await f.read()).toBe(result);
      expect(readFileSync(`${f.path}.proof`, "utf8")).toBe(proofs);
    } finally {
      await turn;
    }
  },
);
