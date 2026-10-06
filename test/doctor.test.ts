import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctor, setupCommand, setupDeps } from "../src/cli/setup.ts";
import { tomlValue } from "../src/router/config-catalog.ts";
import { customProvider } from "./provider-config-support.ts";
import { assertReadOnlyCommand, setupFixture } from "./setup-support.ts";

const keyProvider = {
  ...customProvider,
  id: "acme",
  api_key_env: "ACME_API_KEY",
  health_url: "http://provider.invalid/health",
};
type Fixture = ReturnType<typeof setupFixture>;
test("real setup runner preserves the child environment and overrides only the configured port", async () => {
  const f = setupFixture("[server]\nport = 7461\n");
  const env = {
    PATH: `${join(f.root, "bin")}:${process.env.PATH ?? ""}`,
    HOME: join(f.root, "user"),
    LIMITLESS_HOME: f.home,
    LIMITLESS_CONFIG_DIR: f.configDir,
    LIMITLESS_APP_DIR: join(f.root, "app"),
    LIMITLESS_PORT: "9999",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    const d = setupDeps({ configDir: f.configDir, home: f.home });
    Object.assign(process.env, env);
    const result = await d.run([
      process.execPath,
      "--eval",
      `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(env))}.map(key => [key, process.env[key]]))))`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ ...env, LIMITLESS_PORT: "7461" });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    f.close();
  }
});
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
    writeFileSync(
      join(f.configDir, "secrets.env"),
      "UNUSED_API_KEY=sk-SENTINEL-read-only\nOPENROUTER_API_KEY=sk-SENTINEL-or\nOMLX_API_KEY=sk-SENTINEL-omlx\nTWILIGHT_API_KEY=sk-SENTINEL-twilight\nTYPESAFE_API_KEY=sk-SENTINEL-typesafe\n",
    );
    f.reload();
    const fetch = f.d.fetch;
    f.d.fetch = (url, init) =>
      url.includes("/api/") && !url.includes("openrouter.ai")
        ? fetch(url, init)
        : Promise.resolve(Response.json({ ok: true }));
    mkdirSync(f.home);
    writeFileSync(f.smokeFile, JSON.stringify([{ name: "live", status: "pass" }]));
    const before = f.snapshot();
    expect(await setupCommand("doctor", { json: true }, f.d)).toBe(0);
    const summary = JSON.parse(f.output[0] ?? "");
    expect(summary.checks.map((c: { status: string }) => c.status)).toEqual(Array(16).fill("ok"));
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
    f.d.fetch = (url, init) =>
      url.startsWith("http://provider.invalid")
        ? Promise.resolve(Response.json({ ok: true }))
        : fetch(url, init);
    f.d.smoke = async () => [{ name: "live", status: "pass", reason: secret, durationMs: 1 }];
    expect(await setupCommand("init", { yes: true, json: true }, f.d)).toBe(0);
    expect(JSON.parse(f.output[1] ?? "").smoke[0].reason).toBe("[redacted]");
    expect(JSON.parse(readFileSync(f.smokeFile, "utf8"))[0].reason).toBe("[redacted]");
    expect(f.output.join("\n")).not.toContain("SENTINEL");
  } finally {
    f.close();
  }
});

test("doctor fakes reject service installation and MCP mutations", () => {
  for (const args of [
    ["bun", "main.ts", "service", "install"],
    ["claude", "mcp", "add", "limitless"],
    ["codex", "mcp", "add", "limitless"],
  ])
    expect(() => assertReadOnlyCommand(args)).toThrow("Unexpected command");
});

test("isolated CLI config errors never echo TOML or validation input", async () => {
  const secret = "sk-SENTINEL-private-config";
  const f = setupFixture();
  try {
    for (const text of [`credential = ${secret}\n`, `[providers.${secret}]\nmax_concurrent = 2\n`]) {
      writeFileSync(f.file, text);
      for (const command of ["doctor", "init"])
        for (const json of [false, true]) {
          const child = Bun.spawn(
            [process.execPath, "src/cli/main.ts", command, ...(json ? ["--json"] : [])],
            {
              env: { ...process.env, LIMITLESS_HOME: f.home, LIMITLESS_CONFIG_DIR: f.configDir },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const [stdout, stderr, exit] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect(exit).toBe(1);
          expect(stdout + stderr).toContain("fix config.toml");
          expect(stdout + stderr).not.toContain(secret);
          expect(stdout + stderr).not.toContain(text.trim());
          if (json) expect(JSON.parse(stdout)).toMatchObject({ ok: false, failedStep: "config" });
        }
    }
  } finally {
    f.close();
  }
});

test("feed credentials are redacted in plain, mixed-case URL, form, and base64 encodings", async () => {
  const f = setupFixture();
  const secret = "sk-SENTINEL:/? +[private]ÿ";
  const forms = [
    secret,
    encodeURIComponent(secret),
    encodeURIComponent(secret).replace(/%[\dA-F]{2}/g, (s) => s.toLowerCase()),
    encodeURIComponent(secret).replace("%3A", "%3a"),
    encodeURIComponent(secret).replace("%BF", "%Bf"),
    encodeURI(secret).replace("%BF", "%bF"),
    new URLSearchParams({ key: secret }).toString().slice(4),
    new URLSearchParams({ key: secret }).toString().slice(4).replace("%3A", "%3a"),
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("base64url"),
  ];
  const differentCredential = encodeURIComponent(secret.toLowerCase()).replace("%3A", "%3a");
  try {
    writeFileSync(join(f.configDir, "secrets.env"), `FEED_TOKEN=${secret}\n`);
    f.reload();
    const fetch = f.d.fetch;
    f.d.fetch = (url, init) =>
      url.endsWith("/api/github/access")
        ? Promise.resolve(
            Response.json([
              {
                repo: "acme/app",
                reason: "auth",
                since: 0,
                detail: [...forms, differentCredential].join(" | "),
              },
            ]),
          )
        : fetch(url, init);
    for (const json of [false, true]) {
      f.output.length = 0;
      expect(await setupCommand("doctor", { json }, f.d)).toBe(1);
      const output = f.output.join("\n");
      expect(output).toContain("[redacted]");
      for (const form of forms) expect(output).not.toContain(form);
      expect(output).toContain(differentCredential);
    }
  } finally {
    f.close();
  }
});

for (const explicit of [false, true])
  for (const outcome of ["ok", "unauthorized", "unreachable", "missing"])
    test(`effective OpenRouter provider explicit=${explicit}: ${outcome}`, async () => {
      const f = setupFixture(explicit ? '[[providers]]\npreset = "openrouter"\n' : undefined);
      try {
        f.d.config.secrets.OPENROUTER_API_KEY = outcome === "missing" ? "" : "sk-SENTINEL-health";
        const fetch = f.d.fetch;
        const probes: RequestInit[] = [];
        f.d.fetch = async (url, init) => {
          if (url !== "https://openrouter.ai/api/v1/key") return fetch(url, init);
          probes.push(init ?? {});
          if (outcome === "unreachable") throw new Error("offline");
          return new Response("", { status: outcome === "ok" ? 200 : 401 });
        };
        const before = f.snapshot(),
          checks = await doctor(f.d);
        expect(checks.find((c) => c.id === "provider:openrouter:key")).toMatchObject({
          status: outcome === "missing" ? (explicit ? "fail" : "warn") : "ok",
        });
        const status = outcome === "ok" ? "ok" : explicit && outcome === "unauthorized" ? "fail" : "warn";
        expect(checks.find((c) => c.id === "provider:openrouter:health")).toMatchObject({
          status,
          ...(status !== "ok"
            ? { fix: "start or repair provider openrouter, then run limitless doctor" }
            : {}),
        });
        expect(probes).toHaveLength(1);
        expect(probes[0]?.method).toBe("GET");
        expect(new Headers(probes[0]?.headers).get("authorization")).toBe(
          outcome === "missing" ? null : "Bearer sk-SENTINEL-health",
        );
        expect(f.requests.some((r) => r.url === "http://127.0.0.1:8989/v1/models")).toBe(true);
        expect(checks.find((c) => c.id === "provider:omlx:key")?.status).toBe("warn");
        expect(f.snapshot()).toEqual(before);
      } finally {
        f.close();
      }
    });
