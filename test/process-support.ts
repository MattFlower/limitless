import { expect } from "bun:test";
import { readFileSync } from "node:fs";

const darwin = process.platform === "darwin" ? await import("../src/util/processes-darwin.ts") : null;

/** A killed descendant can remain a zombie until its parent reaps it. */
export function expectProcessStopped(pid: number): void {
  expect(pid).toBeGreaterThan(0);
  if (darwin) {
    expect(darwin.captureDarwinInvocationLeader(pid)).toBeNull();
  } else if (process.platform === "linux") {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") {
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        return;
      }
      throw error;
    }
    expect(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]).toBe("Z");
  } else {
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  }
}
