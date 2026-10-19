// Invoked by the trusted landing script, with its hardened argv and pinned administration paths.
import { gitSh } from "../src/git/confinement.ts";

try {
  const result = await gitSh(["git", ...process.argv.slice(2)], { cwd: process.cwd(), allowFail: true });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.exitCode ?? 1);
} catch {
  console.error("Cannot confine landing Git");
  process.exit(1);
}
