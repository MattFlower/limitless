import { mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { cacheGit, worktreeGit } from "../git/command.ts";
import type { GitOptions } from "../git/confinement.ts";
import { withRepoLock } from "../git/repos.ts";
import { agentEnv } from "../util/proc.ts";
import type { RunObjectIO } from "./run-object-contract.ts";
import { RunTransferError, type RunTransferErrorCode } from "./run-transfer-errors.ts";

type GitRunner = (cmd: string[], options: GitOptions) => Promise<{ stdout: string }>;
export interface RunObjectExportDependencies {
  scratchRoot: string;
  worktreeGit?: GitRunner;
  cacheGit?: GitRunner;
  makeScratch?: (prefix: string) => Promise<string>;
  readBundle?: (path: string) => Promise<Uint8Array>;
  removeScratch?: (path: string) => Promise<void>;
}

/** Isolated committed-object export; no production caller until private validation is composed. */
export function createRunObjectExporter(deps: RunObjectExportDependencies): RunObjectIO["export"] {
  return async (input, signal) => {
    let code: RunTransferErrorCode = "invalid";
    try {
      signal.throwIfAborted();
      const { path, lockPath, trust } = input.repository;
      const { runScope, objectFormat } = input;
      if (
        !isAbsolute(path) ||
        !isAbsolute(lockPath) ||
        !isAbsolute(deps.scratchRoot) ||
        typeof runScope !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runScope) ||
        !["agent-controlled", "factory-owned"].includes(trust)
      )
        throw new RunTransferError("invalid");
      if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new RunTransferError("unsupported");
      const commits = [...new Set(input.commits.map((oid) => oid.toLowerCase()))].sort();
      if (commits.some((oid) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) || /^0+$/.test(oid)))
        throw new RunTransferError("invalid");
      if (commits.some((oid) => oid.length !== (objectFormat === "sha1" ? 40 : 64)))
        throw new RunTransferError("unsupported");
      if (!commits.length) return null;
      const refs = commits.map((oid) => ({ name: `refs/limitless-run-objects/${runScope}/${oid}`, oid }));
      const run =
        trust === "agent-controlled" ? (deps.worktreeGit ?? worktreeGit) : (deps.cacheGit ?? cacheGit);
      const env = agentEnv({
        GIT_NO_LAZY_FETCH: "1",
        GIT_ALLOW_PROTOCOL: "",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_SHALLOW_FILE: "",
      });
      code = "unavailable";
      const result = await withRepoLock(lockPath, async () => {
        signal.throwIfAborted();
        let scratch: string | undefined;
        const owned: typeof refs = [];
        const git = async (args: string[], options: Partial<GitOptions> = {}) =>
          run(["git", ...args], {
            cwd: path,
            env,
            signal,
            timeoutMs: 300_000,
            additionalWriteRoots: scratch ? [scratch] : [],
            ...options,
          });
        const cleanup = async () => {
          let failed = false;
          for (const ref of owned) {
            try {
              await git(["update-ref", "--no-deref", "-d", ref.name, ref.oid], { signal: undefined });
            } catch {
              failed = true;
            }
          }
          if (scratch) {
            try {
              await (deps.removeScratch ?? ((dir) => rm(dir, { recursive: true, force: true })))(scratch);
            } catch {
              failed = true;
            }
          }
          if (failed) throw new RunTransferError("unavailable");
        };
        try {
          code = "incomplete";
          const format = (await git(["rev-parse", "--show-object-format=storage"])).stdout.trim();
          if (format !== objectFormat) throw new RunTransferError("unsupported");
          for (const oid of commits) {
            signal.throwIfAborted();
            if ((await git(["cat-file", "-t", oid])).stdout.trim() !== "commit")
              throw new RunTransferError("invalid");
          }
          // Ignore shallow ancestry boundaries and require all reachable objects locally, without output.
          await git(["rev-list", "--objects", "--missing=error", "--quiet", ...commits, "--"]);
          signal.throwIfAborted();
          code = "unavailable";
          scratch = await (deps.makeScratch ?? mkdtemp)(join(deps.scratchRoot, "run-objects-"));
          signal.throwIfAborted();
          code = "conflict";
          for (const ref of refs) {
            signal.throwIfAborted();
            // Don't abort an atomic write after it succeeds but before ownership can be recorded.
            await git(["update-ref", "--no-deref", ref.name, ref.oid, "0".repeat(ref.oid.length)], {
              signal: undefined,
              dispatchGuard: () => signal.throwIfAborted(),
            });
            owned.push(ref);
            signal.throwIfAborted();
          }
          code = "incomplete";
          const bundle = join(scratch, "objects.bundle");
          await git(["bundle", "create", "--version=3", bundle, ...refs.map((ref) => ref.name)]);
          signal.throwIfAborted();
          const bytes = await (deps.readBundle ?? readFile)(bundle);
          if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new RunTransferError("incomplete");
          signal.throwIfAborted();
          return { bytes, requiredCommits: commits, refs, objectFormat };
        } finally {
          await cleanup();
        }
      });
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (error instanceof RunTransferError) throw error;
      throw new RunTransferError(signal.aborted ? "aborted" : code);
    }
  };
}
