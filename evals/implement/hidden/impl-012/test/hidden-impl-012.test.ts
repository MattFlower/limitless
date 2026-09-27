import { describe, expect, test } from "bun:test";
import { githubHookRanges, githubWebhook } from "../src/integrations/github.ts";
import { inAnyCidr, inCidr } from "../src/util/cidr.ts";

describe("inCidr", () => {
  test("matches IPv4 addresses against IPv4 ranges", () => {
    expect(inCidr("140.82.115.10", "140.82.112.0/20")).toBe(true);
    expect(inCidr("140.82.112.0", "140.82.112.0/20")).toBe(true);
    expect(inCidr("140.82.127.255", "140.82.112.0/20")).toBe(true);
    expect(inCidr("140.82.128.1", "140.82.112.0/20")).toBe(false);
    expect(inCidr("10.200.3.4", "10.0.0.0/8")).toBe(true);
    expect(inCidr("8.8.8.8", "0.0.0.0/0")).toBe(true);
    expect(inCidr("192.30.252.7", "192.30.252.7/32")).toBe(true);
    expect(inCidr("192.30.252.8", "192.30.252.7/32")).toBe(false);
  });

  test("matches IPv6 addresses, including compressed forms", () => {
    expect(inCidr("2606:50c0:8000::154", "2606:50c0::/32")).toBe(true);
    expect(inCidr("2606:50c1::1", "2606:50c0::/32")).toBe(false);
    expect(inCidr("::1", "::1/128")).toBe(true);
    expect(inCidr("2a0a:a440:0:0:0:0:0:1", "2a0a:a440::/29")).toBe(true);
  });

  test("treats IPv4-mapped IPv6 addresses as IPv4", () => {
    expect(inCidr("::ffff:192.30.252.7", "192.30.252.0/22")).toBe(true);
    expect(inCidr("::ffff:8.8.8.8", "192.30.252.0/22")).toBe(false);
  });

  test("never matches across address families", () => {
    expect(inCidr("140.82.115.10", "2606:50c0::/32")).toBe(false);
    expect(inCidr("2606:50c0::1", "140.82.112.0/20")).toBe(false);
  });

  test("returns false for malformed input instead of throwing", () => {
    expect(inCidr("not-an-ip", "0.0.0.0/0")).toBe(false);
    expect(inCidr("1.2.3.4", "not-a-range/8")).toBe(false);
    expect(inCidr("1.2.3.4", "1.2.3.0/33")).toBe(false);
    expect(inCidr("1.2.3.4", "1.2.3.0/abc")).toBe(false);
  });
});

test("inAnyCidr matches when any range contains the address", () => {
  expect(inAnyCidr("185.199.108.5", ["10.0.0.0/8", "185.199.108.0/22"])).toBe(true);
  expect(inAnyCidr("8.8.8.8", ["10.0.0.0/8", "185.199.108.0/22"])).toBe(false);
  expect(inAnyCidr("8.8.8.8", [])).toBe(false);
});

describe("githubWebhook source check", () => {
  const factory = { cfg: { secrets: { GITHUB_WEBHOOK_SECRET: "s" }, githubOwner: "o" } } as never;
  const deliver = (handler: (req: Request) => Promise<Response>, ip?: string) =>
    handler(
      new Request("http://x/webhooks/github", {
        method: "POST",
        headers: ip ? { "cf-connecting-ip": ip } : {},
        body: "{}",
      }),
    );

  test("tunnel deliveries from outside GitHub's hook ranges are refused before the signature check", async () => {
    const handler = githubWebhook(factory, async () => ["140.82.112.0/20"]);
    expect((await deliver(handler, "8.8.8.8")).status).toBe(403);
    // Inside the ranges the request reaches the signature check, which rejects the unsigned body.
    expect((await deliver(handler, "140.82.115.10")).status).toBe(401);
  });

  test("requests without cf-connecting-ip are not filtered by source address", async () => {
    const handler = githubWebhook(factory, async () => ["140.82.112.0/20"]);
    expect((await deliver(handler)).status).toBe(401);
  });

  test("with no known ranges the signature check alone decides", async () => {
    const handler = githubWebhook(factory, async () => null);
    expect((await deliver(handler, "8.8.8.8")).status).toBe(401);
  });
});

describe("githubHookRanges", () => {
  test("fetches the hooks list from api.github.com/meta once and caches it", async () => {
    const urls: string[] = [];
    const ranges = githubHookRanges((async (url: string | URL | Request) => {
      urls.push(url instanceof Request ? url.url : String(url));
      return new Response(JSON.stringify({ hooks: ["192.30.252.0/22"], web: ["1.1.1.1/32"] }));
    }) as unknown as typeof fetch);
    expect(await ranges()).toEqual(["192.30.252.0/22"]);
    expect(await ranges()).toEqual(["192.30.252.0/22"]);
    expect(urls).toEqual(["https://api.github.com/meta"]);
  });

  test("returns null when the list has never been fetched successfully", async () => {
    const failing = githubHookRanges((async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    expect(await failing()).toBeNull();
    const malformed = githubHookRanges(
      (async () => new Response(JSON.stringify({ web: [] }))) as unknown as typeof fetch,
    );
    expect(await malformed()).toBeNull();
  });
});
