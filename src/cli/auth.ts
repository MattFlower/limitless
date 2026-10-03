import type { AuthSession } from "../core/types.ts";

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type Terminal = Pick<NodeJS.ReadStream, "isTTY" | "setRawMode" | "resume" | "pause" | "on" | "off">;

const USAGE = "usage: limitless auth set-password | limitless auth sessions [revoke <id> | revoke --all]";
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** Reads a line from the terminal without echoing it; piped input is read as its first line. */
export async function readSecret(
  prompt: string,
  input: Terminal = process.stdin,
  output: { write(text: string): unknown } = process.stderr,
): Promise<string> {
  if (!input.isTTY) return (await Bun.stdin.text()).split(/\r?\n/)[0] ?? "";
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003" || ch === "\u0004") return finish(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (ch >= " ") value += ch;
      }
    };
    input.on("data", onData);
  });
}

export async function authCommand(
  args: string[],
  all: boolean,
  deps: { api: Api; print: (line: string) => void; secret?: typeof readSecret; interactive?: boolean },
): Promise<void> {
  const { api, print, secret = readSecret, interactive = process.stdin.isTTY === true } = deps;
  const [action, sub, id] = args;
  if (action === "set-password" && args.length === 1) {
    const password = await secret("New UI password: ");
    if (interactive && (await secret("Repeat it: ")) !== password) throw new Error("the passwords differ");
    await api("/api/admin/auth/password", { method: "POST", body: JSON.stringify({ password }) });
    print(
      "UI password set. Signed-in browsers stay signed in; `limitless auth sessions revoke --all` ends them.",
    );
    return;
  }
  if (action === "sessions" && args.length === 1) {
    const sessions = await api<AuthSession[]>("/api/admin/auth/sessions");
    if (!sessions.length) print("No UI sessions");
    for (const s of sessions)
      print(
        `${s.id}  ${s.method.padEnd(8)}  seen ${stamp(s.lastSeenAt)}  since ${stamp(s.createdAt)}  ${s.device}`,
      );
    return;
  }
  if (action === "sessions" && sub === "revoke" && args.length === (all ? 2 : 3)) {
    const request = JSON.stringify(all ? { all: true } : { id });
    const { revoked } = await api<{ revoked: number }>("/api/admin/auth/sessions/revoke", {
      method: "POST",
      body: request,
    });
    if (!all && !revoked) throw new Error(`no session ${id}`);
    print(`Revoked ${revoked} session${revoked === 1 ? "" : "s"}`);
    return;
  }
  throw new Error(USAGE);
}
