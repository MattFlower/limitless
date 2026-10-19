import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { expectProcessStopped } from "./process-support.ts";

for (const missing of ["ENOENT", "ESRCH"]) {
  test.skipIf(process.platform !== "linux").each(["running", "ESRCH", "EPERM"])(
    `Linux missing stat (${missing}) requires a nonexistent PID (%s)`,
    (probe) => {
      const read = spyOn(fs, "readFileSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("stat unavailable"), { code: missing });
      });
      const kill =
        probe === "running"
          ? null
          : spyOn(process, "kill").mockImplementationOnce(() => {
              throw Object.assign(new Error("PID probe"), { code: probe });
            });
      try {
        // The real current process stays alive even when procfs hides its stat file.
        const check = () => expectProcessStopped(process.pid);
        if (probe === "ESRCH") expect(check).not.toThrow();
        else expect(check).toThrow();
      } finally {
        read.mockRestore();
        kill?.mockRestore();
      }
    },
  );
}
