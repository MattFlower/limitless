import { expect } from "bun:test";
import {
  type Anchor,
  type ClaimRecord,
  type ClaimTip,
  createClaimClient,
  formatRecord,
  parseRecord,
} from "../src/integrations/claim-ref.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import { CommandError } from "../src/util/proc.ts";

const repo = "owner/project";
const ref = "refs/limitless/claims/12";
const zeros = "0".repeat(40);
const sample: Anchor = { inclusive: 71, exclusive: 93 };
type Step = "tree" | "repository" | "commit" | "update" | "ref" | "commitRead";
type Update = { name: string; beforeOid: string; afterOid: string; force: boolean };
type Body = {
  tree?: { path: string; mode: string; type: string; content: string }[];
  message?: string;
  parents?: string[];
  author?: unknown;
  committer?: unknown;
  query?: string;
  variables?: { owner?: string; name?: string; r?: string; u?: Update[] };
};
export type Request = { step: Step; args: string[]; body: Body; repo: string; signal?: AbortSignal };
type RawCommit = { sha: string; message: string; committer: { date: string }; parents: string[] };

// This fake rejects unknown operations, so forbidden REST writes and listings fail immediately.
export class GitHub {
  requests: Request[] = [];
  refs = new Map<string, string>();
  commits = new Map<string, RawCommit>();
  clock = Date.parse("2026-10-27T12:00:00Z");
  serial = 0;
  fault?: (request: Request) => string | undefined | Promise<string | undefined>;
  constructor(readonly unconditional = false) {}
  key(repository: string, name: string) {
    return `${repository}:${name}`;
  }
  seed(record: ClaimRecord | string, name = ref, repository = repo, parents: string[] = []): ClaimTip {
    const sha = (++this.serial).toString(16).padStart(40, "0");
    const message = typeof record === "string" ? record : formatRecord(record);
    const date = new Date(this.clock++).toISOString();
    this.commits.set(sha, { sha, message, committer: { date }, parents });
    this.refs.set(this.key(repository, name), sha);
    return { sha, committedAt: date, record: parseRecord(message, name) };
  }
  calls(step: Step) {
    return this.requests.filter((r) => r.step === step);
  }
  update(request: Request): Update {
    expect(request.args).toEqual(["api", "graphql", "--input", "-"]);
    expect(request.body.query).toBe(
      "mutation($r:ID!,$u:[RefUpdate!]!){updateRefs(input:{repositoryId:$r,refUpdates:$u}){clientMutationId}}",
    );
    expect(request.body.variables?.u).toHaveLength(1);
    const update = request.body.variables?.u?.[0];
    if (!update) throw new Error("Missing update");
    expect(update.force).toBe(false);
    return update;
  }
  apply(request: Request) {
    const update = this.update(request);
    this.refs.set(this.key(request.repo, update.name), update.afterOid);
  }
  gh: GhRunner = async (args, signal, stdin, repository) => {
    expect(repository).toBeDefined();
    const target = repository ?? "missing";
    const body = (stdin ? JSON.parse(stdin) : {}) as Body;
    expect(args[0]).toBe("api");
    expect(args).not.toContain("PATCH");
    expect(args).not.toContain("DELETE");
    const path = args[1]?.replace(`repos/${target}/`, "");
    const step: Step =
      path === "graphql"
        ? body.query?.startsWith("mutation")
          ? "update"
          : "repository"
        : path === "git/trees"
          ? "tree"
          : path === "git/commits"
            ? "commit"
            : path?.startsWith("git/ref/")
              ? "ref"
              : path?.startsWith("git/commits/")
                ? "commitRead"
                : (() => {
                    throw new Error(`Unexpected operation ${path}`);
                  })();
    const request: Request = { step, args, body, repo: target, signal };
    this.requests.push(request);
    if (step === "update") this.update(request);
    const override = await this.fault?.(request);
    if (override !== undefined) return override;
    if (step === "tree") {
      expect(body.tree).toEqual([
        { path: "claim", mode: "100644", type: "blob", content: "limitless claim\n" },
      ]);
      if (!body.tree?.length) throw new Error("Empty trees refused");
      return JSON.stringify({ sha: "e".repeat(40) });
    }
    if (step === "repository") {
      expect(body.variables).toEqual({ owner: target.split("/")[0], name: target.split("/")[1] });
      return JSON.stringify({ data: { repository: { id: `id:${target}` } } });
    }
    if (step === "commit") {
      const sha = (++this.serial).toString(16).padStart(40, "0");
      const commit: RawCommit = {
        sha,
        message: body.message ?? "",
        parents: body.parents ?? [],
        committer: { date: new Date(this.clock++).toISOString() },
      };
      this.commits.set(sha, commit);
      return JSON.stringify(commit);
    }
    if (step === "update") {
      const update = this.update(request);
      const current = this.refs.get(this.key(target, update.name));
      const parents = this.commits.get(update.afterOid)?.parents;
      if (
        !this.unconditional &&
        ((current ?? zeros) !== update.beforeOid || (current && !parents?.includes(current)))
      )
        throw new Error("Something went wrong");
      this.apply(request);
      return JSON.stringify({ data: { updateRefs: { clientMutationId: null } } });
    }
    if (step === "ref") {
      expect(args).toContain("--include");
      const name = `refs/${path?.slice("git/ref/".length)}`;
      const sha = this.refs.get(this.key(target, name));
      if (!sha)
        throw new CommandError(
          "gh failed",
          1,
          'HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"message":"Not Found"}',
          "gh: Not Found (HTTP 404)",
          false,
        );
      return `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ object: { sha } })}`;
    }
    const commit = this.commits.get(path?.slice("git/commits/".length) ?? "");
    if (!commit) throw new Error("Missing commit");
    return JSON.stringify(commit);
  };
  client(anchor = sample) {
    return createClaimClient({ gh: this.gh, sample: () => anchor });
  }
}
