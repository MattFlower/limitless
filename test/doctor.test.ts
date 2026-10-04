import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctor, setupCommand } from "../src/cli/setup.ts";
import { tomlValue } from "../src/router/config-catalog.ts";
import { customProvider } from "./provider-config-support.ts";
import { setupFixture } from "./setup-support.ts";

const keyProvider = {
  ...customProvider,
  id: "acme",
  api_key_env: "ACME_API_KEY",
  health_url: "http://provider.invalid/health",
};
type Fixture = ReturnType<typeof setupFixture>;
const cases: [string, string, string, (f: Fixture) => void][] = [
  [
    "git",
    "fail",
    "upgrade git to 2.40 or newer",
    (f) => {
      const run = f.d.run;
      f.d.run = (args) =>
        args.join(" ") === "git --version"
          ? Promise.resolve({ exitCode: 0, stdout: "git version 2.39.8", stderr: "" })
          : run(args);
    },
  ],
  [
    "gh",
    "fail",
    "gh auth login",
    (f) => {
      f.state.auth = false;
    },
  ],
  ...["claude", "codex"].flatMap((cli): typeof cases => [
    [
      cli,
      "warn",
      cli === "claude"
        ? "install Claude Code, then run claude and /login"
        : "install Codex, then run codex login",
      (f) => {
        const run = f.d.run;
        f.d.run = (args) =>
          args[0] === cli ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "" }) : run(args);
      },
    ],
    [
      cli,
      "fail",
      cli === "claude"
        ? "install Claude Code, then run claude and /login"
        : "install Codex, then run codex login",
      (f) => {
        const run = f.d.run;
        f.d.run = (args) =>
          args[0] === cli && args[1] !== "--version"
            ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "" })
            : run(args);
      },
    ],
  ]),
  [
    "python3",
    "warn",
    "install python3; it is needed for the sandbox probe",
    (f) => {
      const run = f.d.run;
      f.d.run = (args) =>
        args[0] === "python3" ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "" }) : run(args);
    },
  ],
  [
    "daemon",
    "warn",
    "limitless service install",
    (f) => {
      f.state.daemon = false;
    },
  ],
  [
    "daemon",
    "warn",
    "limitless deploy",
    (f) => {
      f.state.sha = "old";
    },
  ],
  ["smoke", "warn", "run limitless init", () => {}],
  [
    "smoke",
    "warn",
    "run limitless init",
    (f) => {
      mkdirSync(f.home);
      writeFileSync(f.smokeFile, JSON.stringify([{ name: "sandbox", status: "fail" }]));
    },
  ],
];
for (const [id, status, fix, arrange] of cases)
  test(`doctor ${id}: ${status} (${fix})`, async () => {
    const f = setupFixture();
    try {
      arrange(f);
      expect((await doctor(f.d)).find((c) => c.id === id)).toMatchObject({ status, fix });
    } finally {
      f.close();
    }
  });
test("all checks pass without external effects, and outputs stay read-only", async () => {
  const f = setupFixture("[server]\nport = 7400\n");
  try {
    writeFileSync(join(f.configDir, "secrets.env"), "UNUSED_API_KEY=sk-SENTINEL-read-only\n");
    f.reload();
    mkdirSync(f.home);
    writeFileSync(f.smokeFile, JSON.stringify([{ name: "live", status: "pass" }]));
    const before = f.snapshot();
    expect(await setupCommand("doctor", { json: true }, f.d)).toBe(0);
    const summary = JSON.parse(f.output[0] ?? "");
    expect(summary.checks.map((c: { status: string }) => c.status)).toEqual(Array(8).fill("ok"));
    expect(f.snapshot()).toEqual(before);
    expect(f.effects).toEqual([]);
    expect(f.requests.every((r) => r.method === "GET")).toBe(true);
  } finally {
    f.close();
  }
});
for (const sso of [true, false])
  test(`repository 403 with SSO header=${sso}`, async () => {
    const f = setupFixture('[github]\nrepos = ["acme/app"]\n');
    try {
      const run = f.d.run;
      f.d.run = (args) =>
        args[1] === "api"
          ? Promise.resolve({
              exitCode: 1,
              stdout: `HTTP/2.0 403 Forbidden\n${sso ? "X-GitHub-SSO: required" : ""}`,
              stderr: "",
            })
          : run(args);
      const check = (await doctor(f.d)).find((c) => c.id === "gh");
      expect(check?.status).toBe("fail");
      expect(check?.fix).toBe(
        sso
          ? "sign in to your identity provider, then `gh auth refresh`"
          : "grant repository access to acme/app, then run gh auth refresh",
      );
    } finally {
      f.close();
    }
  });
test("configured provider keys and health are checked; secrets never appear in doctor or init", async () => {
  const f = setupFixture(`providers = ${tomlValue([keyProvider])}\n`);
  try {
    let checks = await doctor(f.d);
    expect(checks.find((c) => c.id === "provider:acme:key")).toMatchObject({
      status: "fail",
      fix: `add ACME_API_KEY=... to ${f.configDir}/secrets.env`,
    });
    expect(checks.find((c) => c.id === "provider:acme:health")).toMatchObject({
      status: "warn",
      fix: "start or repair provider acme, then run limitless doctor",
    });
    writeFileSync(join(f.configDir, "secrets.env"), "ACME_API_KEY=sk-test-SENTINEL-123\n");
    f.reload();
    const fetch = f.d.fetch;
    f.d.fetch = (url, init) =>
      url.startsWith("http://provider.invalid")
        ? Promise.resolve(Response.json({ ok: true }))
        : fetch(url, init);
    checks = await doctor(f.d);
    expect(checks.find((c) => c.id === "provider:acme:key")?.status).toBe("ok");
    expect(checks.find((c) => c.id === "provider:acme:health")?.status).toBe("ok");
    for (const json of [true, false]) {
      await setupCommand("doctor", { json }, f.d);
      await setupCommand("init", { yes: true, json }, f.d);
    }
    expect(f.output.join("\n")).toContain("ACME_API_KEY");
    expect(f.output.join("\n")).not.toContain("SENTINEL");
    expect(readFileSync(f.file, "utf8")).not.toContain("SENTINEL");
  } finally {
    f.close();
  }
});
test("recorded access problems retain githubDoctor's fixes", async () => {
  const f = setupFixture();
  try {
    const fetch = f.d.fetch;
    f.d.fetch = (url, init) =>
      url.endsWith("/api/github/access")
        ? Promise.resolve(
            Response.json([{ repo: "acme/app", reason: "ip", detail: "IP allow list", since: 0 }]),
          )
        : fetch(url, init);
    const check = (await doctor(f.d)).find((c) => c.id === "feed-access");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("acme/app");
    expect(check?.fix).toContain("gh auth refresh");
    expect(check?.fix).toContain("VPN");
  } finally {
    f.close();
  }
});

test("environment-only credentials are reported by name without disclosing their values", async () => {
  const previous = process.env.ACME_API_KEY;
  const f = setupFixture(`providers = ${tomlValue([keyProvider])}\n`);
  try {
    process.env.ACME_API_KEY = "sk-test-SENTINEL-env-123";
    f.reload();
    for (const json of [false, true]) {
      await setupCommand("doctor", { json }, f.d);
      await setupCommand("init", { yes: true, json }, f.d);
    }
    expect(f.output.join("\n")).toContain("ACME_API_KEY present");
    expect(f.output.join("\n")).not.toContain("SENTINEL");
    expect(existsSync(join(f.configDir, "secrets.env"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.ACME_API_KEY;
    else process.env.ACME_API_KEY = previous;
    f.close();
  }
});

test("neither CLI installed is a failure, and an explicit loggedIn false is a failure", async () => {
  const f = setupFixture();
  try {
    const run = f.d.run;
    f.d.run = (args) =>
      ["claude", "codex"].includes(args[0] ?? "")
        ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "" })
        : run(args);
    const checks = await doctor(f.d);
    expect(checks.find((c) => c.id === "claude")?.status).toBe("fail");
    expect(checks.find((c) => c.id === "codex")?.status).toBe("fail");
    f.d.run = (args) =>
      args[0] === "claude" && args[1] === "auth"
        ? Promise.resolve({ exitCode: 0, stdout: '{"loggedIn":false}', stderr: "" })
        : run(args);
    expect((await doctor(f.d)).find((c) => c.id === "claude")?.status).toBe("fail");
  } finally {
    f.close();
  }
});

test("escaped secrets are redacted before JSON encoding in feed, smoke storage and init summaries", async () => {
  const f = setupFixture(`providers = ${tomlValue([keyProvider])}\n`);
  const secret = 'sk-SENTINEL-"quoted\\token';
  try {
    writeFileSync(join(f.configDir, "secrets.env"), `ACME_API_KEY='${secret}'\n`);
    f.reload();
    const fetch = f.d.fetch;
    f.d.fetch = (url, init) =>
      url.endsWith("/api/github/access")
        ? Promise.resolve(Response.json([{ repo: "acme/app", reason: "auth", since: 0, detail: secret }]))
        : fetch(url, init);
    expect(await setupCommand("doctor", { json: true }, f.d)).toBe(1);
    expect(
      JSON.parse(f.output[0] ?? "").checks.find((c: { id: string }) => c.id === "feed-access").message,
    ).toContain("[redacted]");
    f.d.fetch = fetch;
    f.d.smoke = async () => [{ name: "live", status: "pass", reason: secret, durationMs: 1 }];
    expect(await setupCommand("init", { yes: true, json: true }, f.d)).toBe(0);
    expect(JSON.parse(f.output[1] ?? "").smoke[0].reason).toBe("[redacted]");
    expect(JSON.parse(readFileSync(f.smokeFile, "utf8"))[0].reason).toBe("[redacted]");
    expect(f.output.join("\n")).not.toContain("SENTINEL");
  } finally {
    f.close();
  }
});
