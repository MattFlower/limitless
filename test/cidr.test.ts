import { expect, test } from "bun:test";
import { githubHookRanges, githubWebhook } from "../src/integrations/github.ts";
import { inAnyCidr, inCidr } from "../src/util/cidr.ts";

test("IPv4 and IPv6 CIDR matching", () => {
  expect(inCidr("140.82.115.10", "140.82.112.0/20")).toBe(true);
  expect(inCidr("140.82.128.1", "140.82.112.0/20")).toBe(false);
  expect(inCidr("::ffff:192.30.252.7", "192.30.252.0/22")).toBe(true);
  expect(inCidr("2606:50c0:8000::154", "2606:50c0::/32")).toBe(true);
  expect(inCidr("2606:50c1::1", "2606:50c0::/32")).toBe(false);
  expect(inCidr("140.82.115.10", "2606:50c0::/32")).toBe(false);
  expect(inCidr("not-an-ip", "0.0.0.0/0")).toBe(false);
  expect(inAnyCidr("185.199.108.5", ["10.0.0.0/8", "185.199.108.0/22"])).toBe(true);
});

test("tunnel deliveries from outside GitHub's ranges are refused before the signature check", async () => {
  const factory = { cfg: { secrets: { GITHUB_WEBHOOK_SECRET: "s" }, githubOwner: "o" } } as never;
  const handler = githubWebhook(factory, async () => ["140.82.112.0/20"]);
  const res = await handler(
    new Request("http://x/webhooks/github", {
      method: "POST",
      headers: { "cf-connecting-ip": "8.8.8.8" },
      body: "{}",
    }),
  );
  expect(res.status).toBe(403);
  const fromGitHub = await handler(
    new Request("http://x/webhooks/github", {
      method: "POST",
      headers: { "cf-connecting-ip": "140.82.115.10" },
      body: "{}",
    }),
  );
  expect(fromGitHub.status).toBe(401); // reached the signature check
});

test("hook ranges are cached and survive a failed refresh", async () => {
  let calls = 0;
  const ranges = githubHookRanges((async () => {
    calls++;
    return new Response(JSON.stringify({ hooks: ["192.30.252.0/22"] }));
  }) as unknown as typeof fetch);
  expect(await ranges()).toEqual(["192.30.252.0/22"]);
  expect(await ranges()).toEqual(["192.30.252.0/22"]);
  expect(calls).toBe(1);
  const failing = githubHookRanges((async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch);
  expect(await failing()).toBeNull();
});
