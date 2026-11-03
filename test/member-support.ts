import { afterEach } from "bun:test";
import { createDecipheriv } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlNamer } from "../src/integrations/control-identity.ts";
import { type ControlKey, createControlRefClient } from "../src/integrations/control-ref.ts";
import { publishPrivateStringsPolicy } from "../src/integrations/member-policy.ts";
import { dataKey, Remote, token } from "./shared-store-fake.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
export function fixture() {
  const remote = new Remote();
  const refs = createControlRefClient({ repo: "example/companion", token, dataKey, request: remote.request });
  const namer = createControlNamer(dataKey);
  const configDir = mkdtempSync(join(tmpdir(), "member-policy-"));
  dirs.push(configDir);
  const deps = { refs, namer, key: dataKey, configDir };
  const unused = (): never => {
    throw new Error("Unexpected claim IO");
  };
  let serial = 0;
  const publish = () =>
    publishPrivateStringsPolicy(
      {
        ...deps,
        blobs: remote.client(),
        claims: { read: unused, write: unused },
        owner: "owner-id",
      },
      { id: (++serial).toString(16).padStart(32, "0"), command: { publish: "private-strings" } },
    );
  const list = (text: string) => writeFileSync(join(configDir, "private-strings.txt"), text);
  return { ...deps, remote, publish, list };
}
export const refName = (key: ControlKey) => `refs/control/${key.kind}/${key.id}`;
export function decrypt(remote: Remote, key: ControlKey): Uint8Array {
  const sha = remote.refs.get(refName(key));
  const commit = remote.commits.get(sha ?? "");
  const entry = remote.trees.get(commit?.tree ?? "")?.[0];
  const frame = Buffer.from(remote.blobs.get(entry?.sha ?? "") ?? "", "base64");
  const cipher = createDecipheriv("aes-256-gcm", dataKey, frame.subarray(1, 13));
  cipher.setAAD(Buffer.from(JSON.stringify(["limitless-control", 1, key.kind, key.id])));
  cipher.setAuthTag(frame.subarray(-16));
  return Buffer.concat([cipher.update(frame.subarray(13, -16)), cipher.final()]);
}
