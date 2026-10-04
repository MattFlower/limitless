import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real-git tests get the global git config CI has: an identity and nothing else. A developer's own
// settings (commit signing, hooks, templates) would otherwise run on every fixture and factory commit,
// making the suite slower and machine-dependent. Automatic maintenance is housekeeping no test
// exercises; it only adds a process after commits, fetches and pushes.
const dir = mkdtempSync(join(tmpdir(), "limitless-test-git-"));
const config = join(dir, "config");
writeFileSync(
  config,
  "[user]\n\tname = Test\n\temail = test@example.invalid\n[maintenance]\n\tauto = false\n",
);
process.env.GIT_CONFIG_GLOBAL = config;
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
