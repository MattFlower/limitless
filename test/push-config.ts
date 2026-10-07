import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh } from "../src/util/proc.ts";

/** Every executable checkout setting has its own observable side effect. */
export async function plantPushConfig(cwd: string, root: string, destination: string, git = "git") {
  const dir = join(root, "push-attacks");
  mkdirSync(dir);
  const markers: string[] = [];
  const script = (name: string) => {
    const marker = join(dir, `${name}.marker`);
    const command = join(dir, name);
    markers.push(marker);
    writeFileSync(command, `#!/bin/sh\n: > '${marker}'\nexit 97\n`, { mode: 0o755 });
    return command;
  };
  const config = (key: string, value: string) => sh([git, "config", key, value], { cwd });
  for (const key of [
    "remote.origin.receivepack",
    "remote.origin.uploadpack",
    "core.sshCommand",
    "credential.helper",
    `credential.${destination}.helper`,
    "gpg.program",
  ])
    await config(key, script(key.replaceAll("/", "_")));
  await config("remote.origin.pushurl", `ext::${script("pushurl")}`);
  for (const key of ["insteadOf", "pushInsteadOf"])
    await config(`url.ext::${script(key)}.${key}`, destination);
  const included = join(dir, "included.config");
  writeFileSync(included, `[remote "origin"]\nreceivepack = ${script("included")}\n`);
  await config("include.path", included);
  await config("includeIf.gitdir:**.path", included);
  return () => markers.filter(existsSync);
}
