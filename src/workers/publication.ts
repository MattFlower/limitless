import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { AgentJobRequest } from "../db/workers.ts";
import { loadPrivateStrings, PrivateError } from "../gates/private.ts";
import { cacheGit, stageAll, worktreeGit } from "../git/command.ts";
import { checkPrivateRange, commitAll } from "../git/repos.ts";
import { githubToken } from "../integrations/github-token.ts";
import { checkDiscreetCommits } from "../pipeline/markers.ts";
import { agentEnv, registerCredential, registeredCredentials } from "../util/proc.ts";

const identity = z
  .string()
  .min(1)
  .refine(
    (s) => s.trim() === s && !/[<>]/.test(s) && ![...s].some((c) => c < " " || c.charCodeAt(0) === 127),
  );
const email = identity.refine((s) => /^[^\s@]+@[^\s@]+$/.test(s));
export const publicationFields = {
  commit: z
    .object({
      message: z
        .string()
        .min(1)
        .refine((s) => !s.includes("\0")),
      authorName: identity,
      authorEmail: email,
      committerName: identity,
      committerEmail: email,
    })
    .optional(),
  repoUrl: z
    .string()
    .refine((s) => {
      if ([...s].some((c) => c < " " || c.charCodeAt(0) === 127)) return false;
      if (isAbsolute(s)) return true; // Local bare remotes in offline tests.
      return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(s);
    })
    .optional(),
  expectedRemoteSha: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)
    .nullable()
    .optional(),
  discreet: z.boolean().optional(),
};

/** Publish only the immutable commit inspected here; session credentials are acquired afterwards. */
export async function publishAgentChanges(
  cwd: string,
  req: AgentJobRequest,
  cfg: Config,
  signal: AbortSignal,
  tokenLookup = githubToken,
): Promise<string> {
  if (req.mode === "readonly") return req.parentSha;
  await stageAll({ cwd, signal });
  const changed = await worktreeGit(["git", "diff", "--cached", "--quiet"], { cwd, signal, allowFail: true });
  if (changed.exitCode === 0) return req.parentSha;
  if (changed.exitCode !== 1) throw new Error("Cannot inspect worker changes");
  const { commit, repoUrl, expectedRemoteSha, discreet, branch } = req;
  if (!commit || !repoUrl || expectedRemoteSha === undefined || discreet === undefined || !branch)
    throw new Error("Changed edit session is missing publication metadata");
  const sha = await commitAll(cwd, commit.message, {
    signal,
    verbatim: true,
    env: {
      ...agentEnv(),
      GIT_AUTHOR_NAME: commit.authorName,
      GIT_AUTHOR_EMAIL: commit.authorEmail,
      GIT_COMMITTER_NAME: commit.committerName,
      GIT_COMMITTER_EMAIL: commit.committerEmail,
    },
  });
  if (!sha) return req.parentSha;
  const parents = await worktreeGit(["git", "rev-list", "--parents", "-n", "1", sha], { cwd, signal });
  if (parents.stdout.trim() !== `${sha} ${req.parentSha}`) throw new Error("Worker commit parent mismatch");
  const range = `${req.parentSha}..${sha}`;
  await checkPrivateRange(cwd, range, loadPrivateStrings(cfg.paths.configDir, [cwd]));
  if (discreet) await checkDiscreetCommits(cwd, range, req.parentSha, req.runId, cfg.uiUrl);
  const token = await tokenLookup(signal);
  registerCredential("GH_TOKEN", token);
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  registerCredential("WORKER_GIT_AUTH", basic);
  try {
    await checkPrivateRange(
      cwd,
      range,
      registeredCredentials().map((value) => ({ value, entry: 1 })),
    );
  } catch (error) {
    if (error instanceof PrivateError)
      throw new Error("Registered worker credential in publication; push blocked");
    throw error;
  }
  signal.throwIfAborted();
  const ref = `refs/heads/${branch}`;
  const pushed = await cacheGit(
    [
      "git",
      "push",
      "--porcelain",
      "--no-follow-tags",
      `--force-with-lease=${ref}:${expectedRemoteSha ?? ""}`,
      repoUrl,
      `${sha}:${ref}`,
    ],
    {
      cwd: join(dirname(cwd), "repo.git"),
      signal,
      timeoutMs: 300_000,
      allowFail: true,
      env: {
        ...agentEnv(),
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      },
    },
  );
  if (pushed.timedOut) throw new Error("Worker push timed out");
  if (pushed.exitCode !== 0) {
    if (pushed.stdout.split("\n").some((line) => line === `!\t${sha}:${ref}\t[rejected] (stale info)`))
      throw new Error("Worker push refused: branch moved");
    throw new Error("Worker push failed");
  }
  return sha;
}
