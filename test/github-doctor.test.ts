import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";
import { githubDoctor } from "../src/integrations/github-poller.ts";

const dir = mkdtempSync(join(tmpdir(), "github-doctor-"));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("doctor lists persisted access problems with the fix, from the database alone", () => {
  let store = new Store(join(dir, "db.sqlite"));
  expect(githubDoctor(store)).toEqual(["GitHub access: ok"]);
  store.setGithubAccess("acme/app", { reason: "sso", detail: "SSO authorization required", head: null });
  store.setGithubAccess("acme/ip", { reason: "ip", detail: "IP allow list", head: "a".repeat(40) });
  store.close();
  store = new Store(join(dir, "db.sqlite"));
  const lines = githubDoctor(store).join("\n");
  expect(lines).toContain("GitHub access problem in acme/app");
  expect(lines).toContain("sign in to your identity provider");
  expect(lines).toContain("gh auth refresh");
  expect(lines).toMatch(/acme\/ip[\s\S]*VPN/);
  store.setGithubAccess("acme/app", null);
  store.setGithubAccess("acme/ip", null);
  expect(githubDoctor(store)).toEqual(["GitHub access: ok"]);
  store.close();
});
