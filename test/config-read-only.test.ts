import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, readRepoSettingsReadOnly } from "../src/config.ts";
import { registeredCredentials, sh } from "../src/util/proc.ts";

const root = fs.mkdtempSync(join(os.tmpdir(), "repo-read-"));
const file = join(root, "config.toml");
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);
});
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const read = (text: string, slug = "OWNER/Repo") => {
  fs.writeFileSync(file, text);
  return readRepoSettingsReadOnly(slug, root);
};
const defaults = {
  shared: false,
  githubActions: false,
  githubActionsPaidMinutes: false,
  discreet: false,
  branchPrefix: "change/",
  landRequiresApproval: false,
};

test("local defaults, case-insensitive lookup and all existing settings", () => {
  for (const text of ["", "[server]\nport = false", '[repos."other/repo"]\nshared = true'])
    expect(read(text)).toEqual(defaults);
  expect(
    read(
      '[repos."Owner/Repo"]\nshared = true\ndiscreet = true\nbranch_prefix = "fix/"\nland_requires_approval = true\ngithub_actions = true\ngithub_actions_paid_minutes = true',
    ),
  ).toEqual({
    shared: true,
    discreet: true,
    branchPrefix: "fix/",
    landRequiresApproval: true,
    githubActions: true,
    githubActionsPaidMinutes: true,
  });
  expect(read('[repos."owner/repo"]\nshared = false')).toEqual(defaults);
});

test.each([
  "repos = []",
  "repos = false",
  '[repos]\n"other/repo" = 1',
  '[repos."bad slug"]',
  '[repos."other/repo"]\nshared = "false"',
  '[repos."other/repo"]\ndiscreet = 1',
  '[repos."other/repo"]\ngithub_actions = []',
  '[repos."other/repo"]\ngithub_actions_paid_minutes = {}',
  '[repos."other/repo"]\nland_requires_approval = 1',
  '[repos."other/repo"]\nbranch_prefix = ""',
  '[repos."other/repo"]\nbranch_prefix = "../"',
  '[repos."other/repo"]\nbranch_prefix = false',
  '[repos."Other/Repo"]\n[repos."other/repo"]',
])("reject every repository entry: %s", (text) => {
  expect(() => read(text)).toThrow("REPO_CONFIG_SETTINGS: Invalid repository settings");
});

test("fixed failures for invalid slugs, absent/unreadable files and malformed TOML", () => {
  for (const slug of ["bad slug", "owner/repo\n", "owner/repo\r"])
    expect(() => read("", slug)).toThrow("REPO_CONFIG_SLUG: Invalid repository slug");
  fs.rmSync(file);
  expect(() => readRepoSettingsReadOnly("owner/repo", root)).toThrow(
    "REPO_CONFIG_READ: Cannot read repository configuration",
  );
  // A directory deterministically fails as a file on Linux and macOS, even when run as root.
  fs.mkdirSync(file);
  expect(() => readRepoSettingsReadOnly("owner/repo", root)).toThrow(
    "REPO_CONFIG_READ: Cannot read repository configuration",
  );
  fs.rmSync(file, { recursive: true });
  expect(() => read("[broken")).toThrow("REPO_CONFIG_TOML: Invalid repository configuration syntax");
});

test("explicit directory wins over environment, then the standard directory is used", () => {
  const other = join(root, "other");
  fs.mkdirSync(other);
  fs.writeFileSync(join(other, "config.toml"), '[repos."owner/repo"]\nshared = true');
  fs.writeFileSync(file, "");
  process.env.LIMITLESS_CONFIG_DIR = other;
  expect(readRepoSettingsReadOnly("owner/repo", root).shared).toBe(false);
  expect(readRepoSettingsReadOnly("owner/repo").shared).toBe(true);
  delete process.env.LIMITLESS_CONFIG_DIR;
  const home = spyOn(os, "homedir").mockReturnValue(root);
  try {
    fs.mkdirSync(join(root, ".config/limitless"), { recursive: true });
    fs.writeFileSync(join(root, ".config/limitless/config.toml"), "");
    expect(readRepoSettingsReadOnly("owner/repo")).toEqual(defaults);
  } finally {
    home.mockRestore();
  }
});

test("success and failure emit no private configuration text, including warning paths", async () => {
  const token = `private-${crypto.randomUUID()}`;
  const table = `[repos."${token}/Repo"]\n"${token}" = "${token}"\n`;
  for (const [text, expected] of [
    [table, "ok"],
    [`${table}shared = "invalid"`, "Error: REPO_CONFIG_SETTINGS: Invalid repository settings"],
    [`${table}[repos."${token}/repo"]`, "Error: REPO_CONFIG_SETTINGS: Invalid repository settings"],
    [`[${token}`, "Error: REPO_CONFIG_TOML: Invalid repository configuration syntax"],
  ] as const) {
    fs.writeFileSync(file, text);
    const result = await sh(
      [
        process.execPath,
        "--config=/dev/null",
        "--no-env-file",
        "-e",
        `
      import { readRepoSettingsReadOnly } from ${JSON.stringify(resolve("src/config.ts"))};
      try { readRepoSettingsReadOnly("owner/repo", ${JSON.stringify(root)}); process.stdout.write("ok"); }
      catch (error) { process.stdout.write(String(error)); }
    `,
      ],
      { cwd: root },
    );
    expect(result.stdout).toBe(expected);
    expect(result.stderr).toBe("");
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
  }
});

test("reads only config.toml without filesystem, credential or runtime effects", () => {
  fs.writeFileSync(file, "");
  const runtime = loadConfig({ home: root, configDir: root, readOnly: true });
  const snapshot = structuredClone(runtime);
  const token = `private-${crypto.randomUUID()}`;
  fs.writeFileSync(join(root, "secrets.env"), `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`);
  process.env.LIMITLESS_HOME = join(root, "must-not-create");
  const credentials = [...registeredCredentials()];
  const environment = { ...process.env };
  const mkdir = spyOn(fs, "mkdirSync");
  const readFile = spyOn(fs, "readFileSync");
  try {
    expect(readRepoSettingsReadOnly("owner/repo", root)).toEqual(defaults);
    expect(readFile.mock.calls.map((call) => call[0])).toEqual([file]);
    expect(mkdir).not.toHaveBeenCalled();
    expect(registeredCredentials()).toEqual(credentials);
    expect(runtime).toEqual(snapshot);
    expect(process.env).toEqual(environment);
  } finally {
    mkdir.mockRestore();
    readFile.mockRestore();
  }
});
