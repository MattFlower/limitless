import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Git in tests sees the global config CI has: an identity and nothing else. A developer's own settings
// (commit signing, hooks, templates) would otherwise run on every fixture and factory commit, making the
// suite slower and machine-dependent. Tests that need other global settings set GIT_CONFIG_GLOBAL.
// Automatic maintenance stays on: the delivery test proves the factory itself turns it off.
const dir = mkdtempSync(join(tmpdir(), "limitless-test-git-"));
const config = join(dir, "config");
writeFileSync(config, "[user]\n\tname = Test\n\temail = test@example.invalid\n");
process.env.GIT_CONFIG_GLOBAL = config;
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
