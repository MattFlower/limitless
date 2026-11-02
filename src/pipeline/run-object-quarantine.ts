import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { cacheGit } from "../git/command.ts";
import type { GitOptions } from "../git/confinement.ts";
import { agentEnv, runProcess } from "../util/proc.ts";
import type { PrivateObjectReader, PrivateObjectType, RunObjectIO } from "./run-object-contract.ts";
import { RunTransferError } from "./run-transfer-errors.ts";

export interface RunObjectQuarantineDependencies {
  scratchRoot: string;
  cacheGit?: (cmd: string[], options: GitOptions) => Promise<{ stdout: string }>;
  runProcess?: typeof runProcess;
  makeScratch?: (prefix: string) => Promise<string>;
  removeScratch?: (path: string) => Promise<void>;
}

export function createRunObjectValidator(deps: RunObjectQuarantineDependencies): RunObjectIO["validate"] {
  return async (input, inspect, signal) => {
    let scratch: string | undefined;
    let active = false,
      unavailable = false;
    const pending = new Set<Promise<unknown>>();
    try {
      signal.throwIfAborted();
      const invalid = () => new RunTransferError("invalid");
      if (!isAbsolute(deps.scratchRoot) || !(input.bytes instanceof Uint8Array)) throw invalid();
      const { objectFormat } = input;
      if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new RunTransferError("unsupported");
      const width = objectFormat === "sha1" ? 40 : 64;
      const oidPattern = new RegExp(`^[a-f0-9]{${width}}$`);
      const validOID = (oid: string) => typeof oid === "string" && oidPattern.test(oid) && !/^0+$/.test(oid);
      const commits = [...input.requiredCommits];
      const refs = input.refs.map((ref) => ({ ...ref }));
      if (!commits.length || new Set(commits).size !== commits.length || !commits.every(validOID))
        throw invalid();
      const expected = new Map(refs.map((ref) => [ref.name, ref.oid]));
      const scope = refs[0]?.name.match(
        /^refs\/limitless-run-objects\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\//,
      )?.[1];
      if (
        !scope ||
        refs.length !== commits.length ||
        expected.size !== commits.length ||
        commits.some((oid) => expected.get(`refs/limitless-run-objects/${scope}/${oid}`) !== oid)
      )
        throw invalid();
      const bytes = Buffer.from(input.bytes);
      const boundary = bytes.indexOf("\n\n");
      if (boundary < 0) throw invalid();
      const header = bytes.subarray(0, boundary).toString("latin1").split("\n");
      const version = header.shift();
      if (version !== "# v2 git bundle" && version !== "# v3 git bundle")
        throw new RunTransferError("unsupported");
      let format = "sha1";
      if (header[0]?.startsWith("@object-format=")) {
        if (version !== "# v3 git bundle") throw invalid();
        format = header.shift()?.slice(15) ?? "";
      }
      if (format !== objectFormat) throw new RunTransferError("unsupported");
      const advertised = new Set<string>();
      for (const line of header) {
        const match = /^([a-f0-9]+) (refs\/[^\s]+)$/.exec(line);
        if (
          !match ||
          !validOID(match[1] ?? "") ||
          expected.get(match[2] ?? "") !== match[1] ||
          advertised.has(match[2] ?? "")
        )
          throw invalid();
        advertised.add(match[2] ?? "");
      }
      if (advertised.size !== expected.size) throw invalid();
      const pack = bytes.subarray(boundary + 2);
      if (
        pack.length < 12 + width / 2 ||
        pack.toString("ascii", 0, 4) !== "PACK" ||
        ![2, 3].includes(pack.readUInt32BE(4))
      )
        throw invalid();
      const count = pack.readUInt32BE(8);
      const hash = pack.subarray(-width / 2).toString("hex");
      unavailable = true;
      scratch = await (deps.makeScratch ?? mkdtemp)(join(deps.scratchRoot, "run-quarantine-"));
      signal.throwIfAborted();
      const repo = join(scratch, "repo.git"),
        bundle = join(scratch, "objects.bundle");
      const templates = join(scratch, "templates");
      await mkdir(templates);
      // Drop all inherited Git selectors, config injection, object stores and executable selectors.
      const env = Object.fromEntries(Object.entries(agentEnv()).filter(([key]) => !key.startsWith("GIT_")));
      Object.assign(env, {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_SHALLOW_FILE: "",
        GIT_ALLOW_PROTOCOL: "file",
        GIT_PROTOCOL_FROM_USER: "0",
        GIT_TERMINAL_PROMPT: "0",
      });
      const git = async (args: string[]) => {
        signal.throwIfAborted();
        try {
          const result = await (deps.cacheGit ?? cacheGit)(
            [
              "git",
              `--git-dir=${repo}`,
              ...[
                "protocol.allow=never",
                "protocol.file.allow=always",
                "fetch.fsckObjects=true",
                "transfer.fsckObjects=true",
                "fetch.unpackLimit=1",
                "gc.auto=0",
                "maintenance.auto=false",
              ].flatMap((config) => ["-c", config]),
              ...args,
            ],
            { cwd: scratch ?? deps.scratchRoot, env, signal, encoding: "latin1", timeoutMs: 300_000 },
          );
          signal.throwIfAborted();
          return result.stdout;
        } catch {
          throw new RunTransferError(signal.aborted ? "aborted" : "corrupt");
        }
      };
      // Raw cat-file output uses lossless streaming beyond sh's bounded text output.
      const readObject = async (type: string, oid: string) => {
        const chunks: Uint8Array[] = [];
        const result = await (deps.runProcess ?? runProcess)({
          cmd: ["git", `--git-dir=${repo}`, "--no-replace-objects", "cat-file", type, oid],
          cwd: scratch ?? deps.scratchRoot,
          env,
          signal,
          encoding: "latin1",
          timeoutMs: 300_000,
          tailLimit: 0,
          onRawChunk: (chunk, stream) => {
            if (stream === "stdout") chunks.push(Buffer.from(chunk, "latin1"));
          },
        }).catch(() => {
          throw new RunTransferError(signal.aborted ? "aborted" : "corrupt");
        });
        if (signal.aborted) throw new RunTransferError("aborted");
        if (result.exitCode !== 0 || result.cancelled || result.timedOut || result.idleTimedOut)
          throw new RunTransferError("corrupt");
        return Buffer.concat(chunks);
      };
      await git(["init", "--bare", `--template=${templates}`, `--object-format=${objectFormat}`, repo]);
      await writeFile(bundle, bytes, { mode: 0o600 });
      await git(["bundle", "verify", bundle]);
      // Keep the original complete pack: fetch may otherwise unpack or omit unreachable objects.
      const packPath = join(repo, "objects", "pack", `pack-${hash}.pack`);
      await writeFile(packPath, pack, { mode: 0o600 });
      if ((await git(["index-pack", "--strict", packPath])).trim() !== hash) throw invalid();
      await git([
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--no-write-fetch-head",
        bundle,
        ...refs.map((ref) => `${ref.name}:${ref.name}`),
      ]);
      for (const oid of commits)
        if ((await git(["cat-file", "-t", oid])).trim() !== "commit") throw invalid();
      await git(["rev-list", "--objects", "--missing=error", "--quiet", ...commits, "--"]);
      const inventory = new Map<string, PrivateObjectType>();
      const listing = await git([
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname) %(objecttype) %(objectsize)",
      ]);
      for (const line of listing.trimEnd().split("\n")) {
        const match = /^([a-f0-9]+) (commit|tree|blob|tag) (0|[1-9][0-9]*)$/.exec(line);
        if (!match || !validOID(match[1] ?? "") || inventory.has(match[1] ?? "")) throw invalid();
        inventory.set(match[1] ?? "", match[2] as PrivateObjectType);
        const raw = await readObject(match[2] ?? "", match[1] ?? "");
        if (BigInt(raw.length) !== BigInt(match[3] ?? "-1")) throw invalid();
      }
      if (inventory.size !== count) throw invalid();
      const check = (...oids: string[]) => {
        if (!active) throw new RunTransferError("unavailable");
        if (signal.aborted) throw new RunTransferError("aborted");
        if (oids.some((oid) => !validOID(oid) || !inventory.has(oid))) throw invalid();
      };
      const reader: PrivateObjectReader = {
        objects() {
          check();
          const entries = inventory.entries();
          return {
            [Symbol.asyncIterator]() {
              check();
              return {
                async next() {
                  check();
                  const item = entries.next();
                  return item.done
                    ? { done: true, value: undefined }
                    : { done: false, value: { oid: item.value[0], type: item.value[1] } };
                },
              };
            },
          };
        },
        async type(oid) {
          check(oid);
          return inventory.get(oid) as PrivateObjectType;
        },
        read(oid) {
          const task = (async () => {
            check(oid);
            const raw = await readObject(inventory.get(oid) ?? "", oid);
            check(oid);
            return raw;
          })();
          pending.add(task);
          void task.then(
            () => pending.delete(task),
            () => pending.delete(task),
          );
          return task;
        },
      };
      unavailable = false;
      active = true;
      try {
        await inspect(reader);
      } finally {
        active = false;
        await Promise.allSettled(pending);
      }
      signal.throwIfAborted();
    } catch (error) {
      if (error instanceof RunTransferError) throw error;
      throw new RunTransferError(signal.aborted ? "aborted" : unavailable ? "unavailable" : "invalid");
    } finally {
      active = false;
      const remove = deps.removeScratch ?? ((path: string) => rm(path, { recursive: true, force: true }));
      if (scratch)
        await Promise.resolve(scratch)
          .then(remove)
          .catch(() => {
            throw new RunTransferError("unavailable");
          });
    }
    if (signal.aborted) throw new RunTransferError("aborted");
  };
}
