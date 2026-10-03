import { createHash, randomBytes } from "node:crypto";
import type { Config } from "../config.ts";
import type { AuthSession } from "../core/types.ts";
import type { Store } from "../db/store.ts";

export const SESSION_COOKIE = "__Host-limitless-session";
const PASSWORD_SETTING = "auth_password_hash";
/** Verified when no password is set, so that answers like a wrong password and takes as long (same parameters). */
const UNSET_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$pJtok/xbOOc3m8AspqD4O9dnoplX0NzPVw1cBMixqss$3djx1O1qpCvtbR+fu9E/6pFCUqFHQ85IsUTwcjRcWoA";
const DAY_MS = 86_400_000;
/** Refresh last-seen at most this often, so streams and polling don't write on every request. */
const TOUCH_MS = 60_000;
const ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Strict";
export const CLEAR_SESSION = `${SESSION_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;

const sha256 = (token: string) => createHash("sha256").update(token).digest("hex");
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function cookie(headers: Headers, name: string): string | null {
  for (const pair of headers.get("cookie")?.split(";") ?? []) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

const LOCAL = "http://limitless.invalid";
/**
 * A same-origin path to return to after signing in, or `/`. Only printable ASCII, with no backslash and no
 * encoded slash, backslash or control character; dot segments are resolved before the login page is refused.
 */
export function localPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\/(?!\/)[!-~]*$/.test(value) ||
    /\\|%(2f|5c|[01][0-9a-f]|7f)/i.test(value)
  )
    return "/";
  const url = new URL(value, LOCAL);
  return url.origin === LOCAL && !/^\/login(\/|$)/.test(url.pathname) ? url.pathname + url.search : "/";
}

/** Browser half of passkeys: base64url to bytes and back around navigator.credentials. */
const WEBAUTHN_JS = `const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const bin = (s) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const ids = (list) => (list ?? []).map((c) => ({ ...c, id: bin(c.id) }));
const json = (c, fields) => ({ id: c.id, rawId: b64(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(),
  response: Object.fromEntries(fields.map((f) => [f, c.response[f] && b64(c.response[f])])) });
const post = async (path, data) => {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error);
  return body;
};
const run = (id, action) => document.getElementById(id).addEventListener("click", () =>
  action().catch((e) => (document.querySelector("[role=alert]").textContent = e.message)));`;

function page(body: string, status = 200, headers: Record<string, string> = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light">
<title>Sign in · Limitless</title><style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;
min-height:90vh}form,main{display:grid;gap:12px;width:min(320px,90vw)}input,button{font:inherit;padding:8px;
width:100%;box-sizing:border-box}p{margin:0}[role=alert]{color:#e55}</style></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

export function loginPage(next: string, message = "", status = 200, headers: Record<string, string> = {}) {
  // A cross-site link arrives without the SameSite=Strict cookie; the same-site session check finds it.
  return page(
    `<form method="post" action="/login"><h1>◆ limitless</h1>
<button type="button" id="passkey">Sign in with a passkey</button>
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label>Username <input name="username" autocomplete="username" value="limitless" readonly></label>
<label>Password <input type="password" name="password" autocomplete="current-password" required></label>
<p role="alert">${escapeHtml(message)}</p><button>Sign in with password</button></form><script>${WEBAUTHN_JS}
const back = () => location.replace(document.forms[0].next.value);
fetch("/api/auth/session").then((r) => r.ok && back());
run("passkey", async () => {
  const o = await post("/api/auth/passkey/login/options", {});
  const c = await navigator.credentials.get({ publicKey: { ...o, challenge: bin(o.challenge), allowCredentials: ids(o.allowCredentials) } });
  await post("/api/auth/passkey/login", json(c, ["clientDataJSON", "authenticatorData", "signature", "userHandle"]));
  back();
});</script>`,
    status,
    headers,
  );
}

export function enrollPage() {
  return page(`<main><h1>◆ limitless</h1><p>Create a passkey to sign in to Limitless. This link works once.</p>
<button id="enroll">Create passkey</button><p role="alert"></p></main><script>${WEBAUTHN_JS}
run("enroll", async () => {
  const token = location.hash.slice(1);
  const o = await post("/api/auth/passkey/register/options", { token });
  const c = await navigator.credentials.create({ publicKey: { ...o, challenge: bin(o.challenge), user: { ...o.user, id: bin(o.user.id) }, excludeCredentials: ids(o.excludeCredentials) } });
  const response = json(c, ["clientDataJSON", "attestationObject"]);
  response.response.transports = c.response.getTransports?.() ?? [];
  await post("/api/auth/passkey/register", { token, response });
  location.replace("/");
});</script>`);
}

/** Failed sign-ins per source address: `max` within `windowMs`, then refused until the oldest ages out. */
export class LoginLimiter {
  private failures = new Map<string, number[]>();
  constructor(
    readonly max = 5,
    readonly windowMs = 15 * 60_000,
    private now = Date.now,
  ) {}

  /** Seconds until `address` may try again; 0 when it may try now. */
  retryAfter(address: string): number {
    const since = this.now() - this.windowMs;
    const recent = (this.failures.get(address) ?? []).filter((t) => t > since);
    if (recent.length) this.failures.set(address, recent);
    else this.failures.delete(address);
    const blocking = recent[recent.length - this.max];
    return blocking === undefined ? 0 : Math.ceil((blocking - since) / 1000);
  }

  fail(address: string): void {
    this.failures.set(address, [...(this.failures.get(address) ?? []), this.now()]);
  }

  clear(address: string): void {
    this.failures.delete(address);
  }
}

/** Built-in sign-in for non-loopback UI access: one password, and sessions with sliding expiry. */
export class Auth {
  readonly limiter = new LoginLimiter();
  constructor(
    private store: Store,
    private cfg: Pick<Config, "sessionIdleDays" | "sessionAbsoluteDays">,
    private now = Date.now,
  ) {}

  private expired(session: AuthSession, now = this.now()): boolean {
    return (
      now - session.createdAt >= this.cfg.sessionAbsoluteDays * DAY_MS ||
      now - session.lastSeenAt >= this.cfg.sessionIdleDays * DAY_MS
    );
  }

  /** The live session the request's cookie names, with its idle clock refreshed; null otherwise. */
  session(headers: Headers): AuthSession | null {
    const token = cookie(headers, SESSION_COOKIE);
    const session = token ? this.store.authSession(sha256(token)) : null;
    const now = this.now();
    if (!session || this.expired(session, now)) {
      if (session) this.store.revokeAuthSessions(session.id);
      return null;
    }
    if (now - session.lastSeenAt >= TOUCH_MS) this.store.touchAuthSession(session.id, now);
    return session;
  }

  sessions(): AuthSession[] {
    const now = this.now();
    const { sessionAbsoluteDays: absolute, sessionIdleDays: idle } = this.cfg;
    this.store.expireAuthSessions(now - absolute * DAY_MS, now - idle * DAY_MS);
    return this.store.listAuthSessions();
  }

  /** Starts a session and returns the Set-Cookie value that carries it. */
  signIn(method: AuthSession["method"], device: string): string {
    const token = randomBytes(32).toString("base64url");
    this.store.createAuthSession(sha256(token), method, device.slice(0, 256), this.now());
    const maxAge = Math.floor(this.cfg.sessionAbsoluteDays * 86_400);
    return `${SESSION_COOKIE}=${token}; Max-Age=${maxAge}; ${ATTRIBUTES}`;
  }

  async setPassword(password: unknown): Promise<void> {
    if (typeof password !== "string" || [...password].length < 12)
      throw new Error("the password needs at least 12 characters");
    this.store.setSetting(PASSWORD_SETTING, await Bun.password.hash(password, "argon2id"));
  }

  /**
   * The sign-in form's POST. An attempt counts as a failure from before its first await until it succeeds,
   * so concurrent guesses can't outrun the limit, and an unset password fails exactly like a wrong one.
   */
  async passwordSignIn(req: Request, address: string): Promise<Response> {
    const form = await req.formData();
    const next = localPath(form.get("next"));
    const wait = this.limiter.retryAfter(address);
    if (wait) {
      const message = `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} min.`;
      return loginPage(next, message, 429, { "retry-after": String(wait) });
    }
    this.limiter.fail(address);
    const hash = this.store.getSetting<string | null>(PASSWORD_SETTING, null);
    const password = form.get("password");
    const match = await Bun.password.verify(typeof password === "string" ? password : "", hash ?? UNSET_HASH);
    if (!match || !hash) return loginPage(next, "Incorrect password.", 401);
    this.limiter.clear(address);
    const cookie = this.signIn("password", req.headers.get("user-agent") ?? "");
    return new Response(null, { status: 303, headers: { location: next, "set-cookie": cookie } });
  }
}
