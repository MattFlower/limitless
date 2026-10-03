import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { authCommand, readSecret } from "../src/cli/auth.ts";
import { Store } from "../src/db/store.ts";
import { Auth, LoginLimiter, localPath, SESSION_COOKIE } from "../src/server/auth.ts";

const DAY = 86_400_000;
const cookieOf = (setCookie: string) => new Headers({ cookie: `theme=dark; ${setCookie.split(";")[0]}` });

test("sessions slide with use, expire when idle or at the absolute limit, and end when revoked", () => {
  let now = 1_700_000_000_000;
  const store = new Store(":memory:");
  const auth = new Auth(store, { sessionIdleDays: 30, sessionAbsoluteDays: 180 }, () => now);
  const kept = cookieOf(auth.signIn("password", "Browser/1"));
  const idle = cookieOf(auth.signIn("password", "Browser/2"));
  expect(auth.session(new Headers())).toBeNull();
  expect(auth.session(new Headers({ cookie: `${SESSION_COOKIE}=forged` }))).toBeNull();
  for (let day = 29; day < 180; day += 29) {
    now += 29 * DAY;
    expect(auth.session(kept)?.device).toBe("Browser/1");
  }
  expect(auth.session(idle)).toBeNull();
  now += 6 * DAY - 1;
  expect(auth.session(kept)?.device).toBe("Browser/1");
  now += 1;
  expect(auth.session(kept)).toBeNull();
  expect(store.listAuthSessions()).toEqual([]);

  const first = cookieOf(auth.signIn("password", "Browser/3"));
  const second = cookieOf(auth.signIn("password", "Browser/4"));
  now += 30 * DAY;
  const fresh = cookieOf(auth.signIn("password", "Browser/5"));
  expect(auth.sessions().map((s) => s.device)).toEqual(["Browser/5"]);
  expect([auth.session(first), auth.session(second)]).toEqual([null, null]);
  const id = auth.session(fresh)?.id ?? "";
  expect(store.revokeAuthSessions(id)).toBe(1);
  expect(auth.session(fresh)).toBeNull();
});

test("failed sign-ins are limited per address until the oldest failure leaves the window", () => {
  let now = 0;
  const limiter = new LoginLimiter(3, 60_000, () => now);
  for (let i = 0; i < 3; i++) {
    expect(limiter.retryAfter("a")).toBe(0);
    limiter.fail("a");
    now += 10_000;
  }
  expect(limiter.retryAfter("a")).toBe(30);
  expect(limiter.retryAfter("b")).toBe(0);
  now = 60_000;
  expect(limiter.retryAfter("a")).toBe(0);
  limiter.fail("a");
  expect(limiter.retryAfter("a")).toBe(10);
  limiter.clear("a");
  expect(limiter.retryAfter("a")).toBe(0);
});

test("only same-origin paths other than the login page are return targets", () => {
  for (const [value, expected] of [
    ["/runs/abc?tab=diff", "/runs/abc?tab=diff"],
    ["/", "/"],
    ["//evil.example/x", "/"],
    ["/\\evil.example", "/"],
    ["https://evil.example/", "/"],
    ["/login?next=/x", "/"],
    ["/a b", "/"],
    ["/caf\u00e9", "/"],
    ["/a\\b", "/"],
    ["/%5c%5cevil.test", "/"],
    ["/%2F%2Fevil.test", "/"],
    ["/%0d%0aLocation:evil", "/"],
    ["/x%00", "/"],
    ["/x%7f", "/"],
    ["/x/../login", "/"],
    ["/x/%2e%2e/login?next=/", "/"],
    ["/a/./b/../c?tab=diff", "/a/c?tab=diff"],
    [null, "/"],
  ])
    expect(localPath(value)).toBe(expected as string);
});

class FakeTty extends EventEmitter {
  isTTY = true;
  modes: boolean[] = [];
  setRawMode(mode: boolean) {
    this.modes.push(mode);
  }
  resume() {}
  pause() {}
}

test("the password prompt never echoes what is typed", async () => {
  const tty = new FakeTty();
  let written = "";
  const output = { write: (text: string) => (written += text) };
  const terminal = tty as unknown as NodeJS.ReadStream;
  const reading = readSecret("Password: ", terminal, output);
  tty.emit("data", Buffer.from("hunter2x"));
  tty.emit("data", Buffer.from("\u007f!\r"));
  expect(await reading).toBe("hunter2!");
  expect(written).toBe("Password: \n");
  expect(tty.modes).toEqual([true, false]);
  const cancelled = readSecret("Password: ", terminal, output);
  tty.emit("data", "\u0003");
  await expect(cancelled).rejects.toThrow("cancelled");
});

test("auth CLI confirms the prompted password and never takes it as an argument", async () => {
  const bodies: unknown[] = [];
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    bodies.push([path, JSON.parse(String(init?.body ?? "null"))]);
    return { ok: true, revoked: 0 } as T;
  };
  const typed = ["correct horse battery", "correct horse battery", "first", "second"];
  const deps = { api, print: () => {}, secret: async () => typed.shift() ?? "", interactive: true };
  await authCommand(["set-password"], false, deps);
  await expect(authCommand(["set-password"], false, deps)).rejects.toThrow("the passwords differ");
  await expect(authCommand(["set-password", "hunter2"], false, deps)).rejects.toThrow("usage");
  await expect(authCommand(["sessions", "revoke", "ses-9"], false, deps)).rejects.toThrow("no session ses-9");
  expect(bodies).toEqual([
    ["/api/admin/auth/password", { password: "correct horse battery" }],
    ["/api/admin/auth/sessions/revoke", { id: "ses-9" }],
  ]);
});
