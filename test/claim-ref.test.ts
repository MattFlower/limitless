import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";
import {
  type Anchor,
  type ClaimRecord,
  type ClaimTip,
  createClaimClient,
  formatRecord,
  memberId,
  parseRecord,
} from "../src/integrations/claim-ref.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import { CommandError, registerCredential } from "../src/util/proc.ts";

const repo = "owner/project";
const ref = "refs/limitless/claims/12";
const zeros = "0".repeat(40);
const checkpoint = `ckpt1:${"a".repeat(32)}:${"b".repeat(64)}`;
const held: ClaimRecord = {
  kind: "issue",
  state: "held",
  generation: 1,
  number: 12,
  holder: "m-0123456789abcdef",
  run: "logical-run",
  status: "running",
};
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
type Request = { step: Step; args: string[]; body: Body; repo: string; signal?: AbortSignal };
type RawCommit = { sha: string; message: string; committer: { date: string }; parents: string[] };

// This fake rejects unknown operations, so forbidden REST writes and listings fail immediately.
class GitHub {
  requests: Request[] = [];
  refs = new Map<string, string>();
  commits = new Map<string, RawCommit>();
  clock = Date.parse("2026-10-27T12:00:00Z");
  serial = 0;
  fault?: (request: Request) => string | undefined;
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

describe("records", () => {
  test("round-trip every field and bind each kind to its full ref", () => {
    for (const record of [
      held,
      { ...held, kind: "pr" as const },
      { ...held, kind: "run" as const, number: undefined, state: "released" as const, checkpoint },
    ]) {
      const suffix = record.kind === "issue" ? "12" : record.kind === "pr" ? "pr-12" : "run-logical-run";
      const message = formatRecord(record);
      expect(message.startsWith("limitless-claim: 1\n")).toBe(true);
      expect(parseRecord(message, `refs/limitless/claims/${suffix}`)).toEqual(record);
      expect(parseRecord(message, `${ref}-wrong`)).toBe("malformed");
      expect(parseRecord(message, `limitless/claims/${suffix}`)).toBe("malformed");
    }
  });
  test("all RunStatus values are supported", () => {
    for (const status of [
      "queued",
      "waiting",
      "running",
      "waiting_input",
      "succeeded",
      "failed",
      "cancelled",
      "needs_human",
      "resolved",
    ] as const)
      expect(parseRecord(formatRecord({ ...held, status }), ref)).toEqual({ ...held, status });
  });
  test.each([
    ["unknown", "extra: value"],
    ["branch", "branch: private"],
    ["pr", "pr: 123"],
    ["duplicate", "holder: m-0123456789abcdef"],
    ["free text", "free text"],
  ])("reject %s lines", (_name, line) => {
    expect(parseRecord(`${formatRecord(held)}\n${line}`, ref)).toBe("malformed");
  });
  test.each([
    ["kind", "land"],
    ["state", "unknown"],
    ["holder", "host-name"],
    ["checkpoint", "ckpt1:bad"],
    ["status", "unknown"],
    ["generation", "1.5"],
    ["generation", "-1"],
    ["generation", "9007199254740992"],
    ["number", "0"],
    ["number", "9007199254740992"],
    ["run", ""],
  ])("reject invalid %s %s", (field, value) => {
    const message = `${formatRecord(held)}\ncheckpoint: ${checkpoint}`;
    expect(parseRecord(message.replace(new RegExp(`^${field}: .*$`, "m"), `${field}: ${value}`), ref)).toBe(
      "malformed",
    );
  });
  test("reject missing fields, versions, and issue/PR numbers", () => {
    const message = formatRecord(held);
    for (const key of ["kind", "state", "generation", "number", "holder", "run", "status"])
      expect(
        parseRecord(
          message
            .split("\n")
            .filter((s) => !s.startsWith(`${key}:`))
            .join("\n"),
          ref,
        ),
      ).toBe("malformed");
    expect(
      parseRecord(
        message.replace("kind: issue", "kind: pr").replace("number: 12\n", ""),
        "refs/limitless/claims/pr-12",
      ),
    ).toBe("malformed");
    expect(parseRecord(message.replace("claim: 1", "claim: 2"), ref)).toBe("malformed");
    expect(parseRecord("free text", ref)).toBe("malformed");
  });
  test("same immutable SHA validates separately against each ref", async () => {
    const gh = new GitHub();
    const tip = gh.seed(held);
    gh.refs.set(gh.key(repo, "refs/limitless/claims/13"), tip.sha);
    const client = gh.client();
    expect(await client.read(repo, ref)).toEqual({ kind: "tip", tip });
    expect(await client.read(repo, "refs/limitless/claims/13")).toEqual({
      kind: "tip",
      tip: { ...tip, record: "malformed" },
    });
    expect(gh.calls("commitRead")).toHaveLength(1);
    expect(gh.calls("ref")).toHaveLength(2);
  });
});

describe("protocol", () => {
  test.each([false, true])(
    "create, renewal, release capture exact expected OIDs (unconditional=%s)",
    async (unconditional) => {
      const gh = new GitHub(unconditional);
      const client = gh.client();
      const controller = new AbortController();
      let before: ClaimTip | null = null;
      for (const record of [
        held,
        { ...held, status: "needs_human" as const },
        { ...held, state: "released" as const },
      ]) {
        let journaled = "";
        const previousCalls = gh.calls("update").length;
        const outcome = await client.write(repo, ref, before, record, {
          signal: controller.signal,
          onCommit: (sha) => {
            expect(gh.calls("update")).toHaveLength(previousCalls);
            journaled = sha;
          },
          beforeSend: () => {
            expect(journaled).toMatch(/^[0-9a-f]{40}$/);
            expect(gh.calls("update")).toHaveLength(previousCalls);
            return true;
          },
        });
        expect(outcome.kind).toBe("applied");
        if (outcome.kind !== "applied") throw new Error("Expected applied");
        expect(outcome.anchor).toEqual(sample);
        const update = gh.calls("update").at(-1);
        expect(update?.body.variables).toEqual({
          r: `id:${repo}`,
          u: [{ name: ref, beforeOid: before?.sha ?? zeros, afterOid: journaled, force: false }],
        });
        const commit = gh.calls("commit").at(-1)?.body;
        expect(commit?.parents).toEqual(before ? [before.sha] : []);
        expect(commit?.author).toEqual({ name: "limitless", email: "factory@example.invalid" });
        expect(commit?.committer).toEqual({ name: "limitless", email: "factory@example.invalid" });
        expect(commit?.message).toBe(formatRecord(record));
        expect(await client.read(repo, ref, controller.signal)).toEqual({ kind: "tip", tip: outcome.tip });
        before = outcome.tip;
      }
      expect(gh.calls("update")).toHaveLength(3);
      expect(gh.requests.every((r) => r.repo === repo && r.signal === controller.signal)).toBe(true);
      expect(gh.calls("tree")).toHaveLength(1);
    },
  );
  test("competing creates have one winner and show its tip to the loser", async () => {
    const gh = new GitHub();
    const results = await Promise.all([
      gh.client().write(repo, ref, null, held),
      gh.client().write(repo, ref, null, { ...held, holder: "m-fedcba9876543210" }),
    ]);
    const winner = results.find((r) => r.kind === "applied");
    if (winner?.kind !== "applied") throw new Error("Missing winner");
    expect(results.find((r) => r.kind === "moved")).toEqual({ kind: "moved", tip: winner.tip });
    for (const r of gh.calls("update")) expect(r.body.variables?.u?.[0]?.beforeOid).toBe(zeros);
  });
  test.each([false, true])(
    "stale beforeOid is emitted even against unconditional=%s",
    async (unconditional) => {
      const gh = new GitHub(unconditional);
      const before = gh.seed(held);
      const newer = gh.seed({ ...held, generation: 2 }, ref, repo, [before.sha]);
      const outcome = await gh.client().write(repo, ref, before, { ...held, state: "released" });
      expect(gh.calls("update")[0]?.body.variables?.u?.[0]?.beforeOid).toBe(before.sha);
      expect(outcome.kind).toBe(unconditional ? "applied" : "moved");
      if (!unconditional) {
        expect(outcome).toEqual({ kind: "moved", tip: newer });
        expect(gh.refs.get(gh.key(repo, ref))).toBe(newer.sha);
      }
    },
  );
  test("beforeSend can veto after onCommit without a ref request", async () => {
    const gh = new GitHub();
    const events: string[] = [];
    expect(
      await gh.client().write(repo, ref, null, held, {
        onCommit: (sha) => {
          expect(gh.commits.has(sha)).toBe(true);
          events.push("commit");
        },
        beforeSend: () => {
          events.push("veto");
          return false;
        },
      }),
    ).toEqual({ kind: "unchanged", tip: null });
    expect(events).toEqual(["commit", "veto"]);
    expect(gh.calls("update")).toHaveLength(0);
  });
  test("sample is taken immediately before the commit operation", async () => {
    const gh = new GitHub();
    const events: string[] = [];
    gh.fault = (r) => {
      events.push(r.step);
    };
    const client = createClaimClient({
      gh: gh.gh,
      sample: () => {
        events.push("sample");
        return sample;
      },
    });
    await client.write(repo, ref, null, held);
    expect(events).toEqual(["tree", "repository", "sample", "commit", "update"]);
  });
});

describe("outcomes", () => {
  for (const operation of ["create", "renew", "release"] as const) {
    test.each(["success", "own", "equivalent", "unchanged", "moved", "unconfirmed", "commit failure"])(
      `${operation}: %s`,
      async (mode) => {
        const gh = new GitHub();
        const before = operation === "create" ? null : gh.seed(held);
        const record: ClaimRecord = {
          ...held,
          status: "needs_human",
          state: operation === "release" ? "released" : "held",
          checkpoint,
        };
        let other: ClaimTip | undefined;
        gh.fault = (request) => {
          if (request.step === "commit" && mode === "commit failure") throw new Error("Commit failed");
          if (request.step === "ref" && mode === "unconfirmed") throw new Error("Read failed");
          if (request.step !== "update" || mode === "success") return;
          if (mode === "own") gh.apply(request);
          if (mode === "equivalent") other = gh.seed(record);
          if (mode === "moved") other = gh.seed({ ...record, generation: 9 });
          throw new Error("Something went wrong");
        };
        const outcome = await gh.client().write(repo, ref, before, record);
        const expectedKind = ["success", "own", "equivalent"].includes(mode)
          ? "applied"
          : ["unchanged", "commit failure"].includes(mode)
            ? "unchanged"
            : mode;
        expect(String(outcome.kind)).toBe(expectedKind);
        if (outcome.kind === "applied") {
          expect(outcome.tip.record).toEqual(record);
          expect(outcome.anchor).toEqual(mode === "equivalent" ? null : sample);
          if (mode === "equivalent") {
            if (!other) throw new Error("Missing equivalent tip");
            expect(outcome.tip).toEqual(other);
          } else expect(gh.calls("update")[0]?.body.variables?.u?.[0]?.afterOid).toBe(outcome.tip.sha);
        }
        if (outcome.kind === "unchanged") expect(outcome.tip).toEqual(before);
        if (outcome.kind === "moved") {
          if (!other) throw new Error("Missing competing tip");
          expect(outcome.tip).toEqual(other);
        }
        expect(gh.calls("ref")).toHaveLength(["success", "commit failure"].includes(mode) ? 0 : 1);
        expect(gh.calls("update")).toHaveLength(mode === "commit failure" ? 0 : 1);
      },
    );
  }
  test("rejected renewal never confirms its unchanged ownership tuple", async () => {
    const gh = new GitHub();
    const before = gh.seed(held);
    gh.fault = (r) => {
      if (r.step === "update") throw new Error("Something went wrong");
    };
    expect(await gh.client().write(repo, ref, before, { ...held, status: "needs_human" })).toEqual({
      kind: "unchanged",
      tip: before,
    });
    expect(await gh.client().write(repo, ref, before, held)).toEqual({ kind: "unchanged", tip: before });
  });
  test.each([
    { ...held, status: "failed" as const },
    { ...held, state: "released" as const },
    { ...held, checkpoint },
    { ...held, number: 13 },
    { ...held, kind: "pr" as const },
    { ...held, run: "another-run" },
    { ...held, holder: "m-fedcba9876543210" },
    { ...held, generation: 2 },
    "malformed record",
  ])("same holder is insufficient when a requested field differs: %j", async (competing) => {
    const gh = new GitHub();
    gh.fault = (r) => {
      if (r.step !== "update") return;
      gh.seed(competing);
      throw new Error("Something went wrong");
    };
    expect((await gh.client().write(repo, ref, null, held)).kind).toBe("moved");
  });
  test("checkpoint absence differs from presence in either direction", async () => {
    const gh = new GitHub();
    gh.fault = (r) => {
      if (r.step === "update") {
        gh.seed(held);
        throw new Error("Lost response");
      }
    };
    expect((await gh.client().write(repo, ref, null, { ...held, checkpoint })).kind).toBe("moved");
  });
  test("optional number presence participates in run record equality", async () => {
    const gh = new GitHub();
    const record: ClaimRecord = { ...held, kind: "run", number: undefined };
    const runRef = "refs/limitless/claims/run-logical-run";
    gh.fault = (r) => {
      if (r.step === "update") {
        gh.seed({ ...record, number: 12 }, runRef);
        throw new Error("Lost response");
      }
    };
    expect((await gh.client().write(repo, runRef, null, record)).kind).toBe("moved");
  });
  test("delayed application is visible on the next read", async () => {
    const gh = new GitHub();
    let pending: Request | undefined;
    gh.fault = (r) => {
      if (r.step === "update") {
        pending = r;
        throw new Error("Lost response");
      }
    };
    const client = gh.client();
    expect(await client.write(repo, ref, null, held)).toEqual({ kind: "unchanged", tip: null });
    if (!pending) throw new Error("Missing deferred write");
    gh.apply(pending);
    expect(await client.read(repo, ref)).toMatchObject({ kind: "tip", tip: { record: held } });
  });
  test("an absent ref after an existing-tip write is unconfirmed", async () => {
    const gh = new GitHub();
    const before = gh.seed(held);
    gh.fault = (r) => {
      if (r.step === "update") {
        gh.refs.clear();
        throw new Error("Lost response");
      }
    };
    expect((await gh.client().write(repo, ref, before, held)).kind).toBe("unconfirmed");
  });
  test.each(["success", "own", "equivalent", "unchanged", "moved"])(
    "GitHub clock skew does not affect %s classification",
    async (mode) => {
      for (const offset of [-3_600_000, 3_600_000]) {
        const gh = new GitHub();
        gh.clock += offset;
        const anchor = { inclusive: -offset * 97, exclusive: offset * 73 };
        gh.fault = (r) => {
          if (r.step !== "update" || mode === "success") return;
          if (mode === "own") gh.apply(r);
          if (mode === "equivalent") gh.seed(held);
          if (mode === "moved") gh.seed({ ...held, generation: 2 });
          throw new Error("Something went wrong");
        };
        const outcome = await gh.client(anchor).write(repo, ref, null, held);
        expect(String(outcome.kind)).toBe(["success", "own", "equivalent"].includes(mode) ? "applied" : mode);
        if (outcome.kind === "applied") {
          expect(outcome.anchor).toEqual(mode === "equivalent" ? null : anchor);
          expect(Date.parse(outcome.tip.committedAt)).toBeGreaterThanOrEqual(
            Date.parse("2026-10-27T12:00:00Z") + offset,
          );
        }
      }
    },
  );
});

describe("failures", () => {
  const failures: Record<string, () => string> = {
    transport: () => {
      throw new Error("Transport failed");
    },
    non2xx: () => {
      throw new CommandError("HTTP failure", 1, "HTTP/2.0 500 Server Error\r\n\r\n{}", "Server Error", false);
    },
    json: () => "{",
    missing: () => "{}",
    null: () => "null",
    graphql: () => JSON.stringify({ errors: [{ message: "Something went wrong" }] }),
  };
  for (const step of ["tree", "repository", "commit"] as const) {
    test.each(Object.keys(failures))(`${step} pre-CAS failure: %s`, async (mode) => {
      const gh = new GitHub();
      gh.fault = (r) => (r.step === step ? failures[mode]?.() : undefined);
      expect(await gh.client().write(repo, ref, null, held)).toEqual({ kind: "unchanged", tip: null });
      expect(gh.calls("update")).toHaveLength(0);
      expect(gh.calls("ref")).toHaveLength(0);
    });
  }
  test.each(Object.keys(failures))("updateRefs failure confirms exactly once: %s", async (mode) => {
    const gh = new GitHub();
    gh.fault = (r) => (r.step === "update" ? failures[mode]?.() : undefined);
    expect(await gh.client().write(repo, ref, null, held)).toEqual({ kind: "unchanged", tip: null });
    expect(gh.calls("update")).toHaveLength(1);
    expect(gh.calls("ref")).toHaveLength(1);
  });
  test.each([
    "{}",
    "null",
    '{"data":{"updateRefs":{}}}',
    '{"data":{"updateRefs":null}}',
    '{"data":{"updateRefs":{"clientMutationId":null}},"errors":[{}]}',
  ])("malformed mutation response after application is recovered: %s", async (response) => {
    const gh = new GitHub();
    gh.fault = (r) => {
      if (r.step === "update") {
        gh.apply(r);
        return response;
      }
    };
    expect(await gh.client().write(repo, ref, null, held)).toMatchObject({ kind: "applied", anchor: sample });
    expect(gh.calls("ref")).toHaveLength(1);
  });
  test("missing-ref nonzero exit and successful 404 both mean absent", async () => {
    const gh = new GitHub();
    expect(await gh.client().read(repo, ref)).toEqual({ kind: "absent" });
    gh.fault = (r) => (r.step === "ref" ? "HTTP/1.1 404 Not Found\n\n{}" : undefined);
    expect(await gh.client().read(repo, ref)).toEqual({ kind: "absent" });
  });
  const badReads = [
    () => "HTTP/2.0 500 Server Error\r\n\r\n{}",
    () => "HTTP/2.0 4040 Invalid\r\n\r\n{}",
    () => "HTTP/2.0 2000 Invalid\r\n\r\n{}",
    () => "HTTP/2.0 200 OK\r\n\r\n{",
    () => "HTTP/2.0 200 OK\r\n\r\n{}",
    () => "HTTP/2.0 200 OK\r\n\r\nnull",
    () => 'HTTP/2.0 200 OK\r\n\r\n{"object":{"sha":"bad"}}',
    () => '{"object":{"sha":"404"}}',
    () => {
      throw new Error("Transport failed");
    },
    () => {
      throw new CommandError(
        "gh: Not Found (HTTP 404)",
        1,
        '{"message":"404 Not Found"}',
        "gh: Not Found (HTTP 404)",
        false,
      );
    },
    () => {
      throw new CommandError(
        "bad request",
        1,
        "HTTP/2.0 403 Forbidden\r\n\r\n{}",
        "404 mentioned in prose",
        false,
      );
    },
  ];
  test.each(badReads.map((inject, index) => ({ inject, index })))(
    "ref read failure $index stays unconfirmed",
    async ({ inject }) => {
      const gh = new GitHub();
      gh.fault = (r) => {
        if (r.step === "update") throw new Error("Something went wrong");
        if (r.step === "ref") return inject();
      };
      expect((await gh.client().read(repo, ref)).kind).toBe("unconfirmed");
      expect((await gh.client().write(repo, ref, null, held)).kind).toBe("unconfirmed");
    },
  );
  test.each([...Object.keys(failures), "bad date", "missing date", "bad message"])(
    "commit read failure %s stays unconfirmed and is not cached",
    async (mode) => {
      const gh = new GitHub();
      const before = gh.seed(held);
      gh.fault = (r) => {
        if (r.step === "update") {
          gh.apply(r);
          throw new Error("Lost response");
        }
        if (r.step !== "commitRead") return;
        if (mode === "bad date")
          return JSON.stringify({ message: formatRecord(held), committer: { date: "tomorrow" } });
        if (mode === "missing date") return JSON.stringify({ message: formatRecord(held), committer: {} });
        if (mode === "bad message")
          return JSON.stringify({ message: 12, committer: { date: "2026-10-27T12:00:00Z" } });
        return failures[mode]?.();
      };
      const client = gh.client();
      expect((await client.read(repo, ref)).kind).toBe("unconfirmed");
      expect((await client.write(repo, ref, before, { ...held, status: "needs_human" })).kind).toBe(
        "unconfirmed",
      );
      gh.fault = undefined;
      expect((await client.read(repo, ref)).kind).toBe("tip");
      expect(gh.calls("commitRead")).toHaveLength(3);
    },
  );
  test.each(["sample", "onCommit", "beforeSend"])("throwing %s hook is a pre-write failure", async (hook) => {
    const gh = new GitHub();
    const fail = () => {
      throw new Error("Hook failed");
    };
    const client = createClaimClient({ gh: gh.gh, sample: hook === "sample" ? fail : () => sample });
    expect(
      await client.write(repo, ref, null, held, {
        onCommit: hook === "onCommit" ? fail : undefined,
        beforeSend: hook === "beforeSend" ? fail : undefined,
      }),
    ).toEqual({ kind: "unchanged", tip: null });
    expect(gh.calls("update")).toHaveLength(0);
  });
  test.each(["tree", "repository", "commit", "update", "ref", "commitRead"] as const)(
    "cancellation at %s rethrows the caller's same AbortError",
    async (step) => {
      const gh = new GitHub();
      const controller = new AbortController();
      const error = new DOMException("Cancelled", "AbortError");
      gh.fault = (r) => {
        expect(r.signal).toBe(controller.signal);
        if (r.step === "update" && step !== "update") {
          gh.apply(r);
          throw new Error("Lost response");
        }
        if (r.step === step) {
          controller.abort(error);
          throw error;
        }
      };
      await expect(gh.client().write(repo, ref, null, held, { signal: controller.signal })).rejects.toBe(
        error,
      );
    },
  );
  test.each(["ref", "commitRead"] as const)(
    "read cancellation at %s propagates even if runner returns normally",
    async (step) => {
      const gh = new GitHub();
      gh.seed(held);
      const controller = new AbortController();
      const error = new DOMException("Cancelled", "AbortError");
      gh.fault = (r) => {
        if (r.step === step) controller.abort(error);
      };
      await expect(gh.client().read(repo, ref, controller.signal)).rejects.toBe(error);
    },
  );
  test("already-aborted calls do no work; aborts in synchronous hooks propagate", async () => {
    for (const hook of ["already", "sample", "onCommit", "beforeSend", "veto"]) {
      const gh = new GitHub();
      const controller = new AbortController();
      const error = new DOMException("Cancelled", "AbortError");
      const abort = () => {
        controller.abort(error);
        return sample;
      };
      if (hook === "already") abort();
      const client = createClaimClient({ gh: gh.gh, sample: hook === "sample" ? abort : () => sample });
      await expect(
        client.write(repo, ref, null, held, {
          signal: controller.signal,
          onCommit: hook === "onCommit" ? abort : undefined,
          beforeSend:
            hook === "beforeSend" || hook === "veto"
              ? () => {
                  abort();
                  return hook !== "veto";
                }
              : undefined,
        }),
      ).rejects.toBe(error);
      expect(gh.calls("update")).toHaveLength(0);
      if (hook === "already") {
        await expect(client.read(repo, ref, controller.signal)).rejects.toBe(error);
        expect(gh.requests).toHaveLength(0);
      }
    }
  });
  test("unconfirmed errors redact registered credentials", async () => {
    const gh = new GitHub();
    const secret = `claim-test-${crypto.randomUUID()}`;
    registerCredential("CLAIM_TEST_SECRET", secret);
    gh.fault = () => {
      throw new Error(`Failed with ${secret}`);
    };
    const result = await gh.client().read(repo, ref);
    expect(result).toEqual({ kind: "unconfirmed", error: "Error: Failed with [redacted]" });
  });
});

describe("isolation", () => {
  test.each(
    (["tree", "repository", "commitRead"] as const).flatMap((step) =>
      [0, 1].map((cancelled) => ({ step, cancelled })),
    ),
  )("pending $step cache isolates cancellation of caller $cancelled", async ({ step, cancelled }) => {
    const gh = new GitHub();
    if (step === "commitRead") gh.seed(held);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controllers = [new AbortController(), new AbortController()];
    const error = new DOMException("Cancelled", "AbortError");
    const errors: unknown[] = [];
    const client = createClaimClient({
      sample: () => sample,
      gh: async (...args) => {
        const [argv, signal] = args;
        const target = step === "tree" ? "git/trees" : step === "repository" ? "graphql" : "git/commits/";
        if (argv[1]?.includes(target)) {
          started.resolve();
          // Keep the runner pending even on abort to check the client's own cancellation boundary.
          await release.promise;
          signal?.throwIfAborted();
        }
        return (await gh.gh(...args)) ?? "";
      },
    });
    const invoke = (index: number) => {
      const signal = controllers[index]?.signal;
      return (
        step === "commitRead"
          ? client.read(repo, ref, signal)
          : client.write(repo, ref, null, held, { signal })
      ).catch((e: unknown) => {
        errors[index] = e;
        return null;
      });
    };
    const first = invoke(0);
    await started.promise;
    const second = invoke(1);
    let results: Awaited<ReturnType<typeof invoke>>[] = [];
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      controllers[cancelled]?.abort(error);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(errors[cancelled]).toBe(error);
      expect(errors[1 - cancelled]).toBeUndefined();
    } finally {
      release.resolve();
      results = await Promise.all([first, second]);
    }
    expect(results[1 - cancelled]).toMatchObject({ kind: step === "commitRead" ? "tip" : "applied" });
    expect(errors[1 - cancelled]).toBeUndefined();
    // A completed value can be reused by a caller with a different signal.
    const requests = gh.requests.length;
    if (step === "commitRead") await client.read(repo, ref, new AbortController().signal);
    else
      await client.write(repo, ref, null, held, {
        signal: new AbortController().signal,
        beforeSend: () => false,
      });
    expect(gh.requests.slice(requests).map((r) => r.step)).toEqual(
      step === "commitRead" ? ["ref"] : ["commit"],
    );
  });
  test("concurrent operations share pending caches within one instance", async () => {
    const gh = new GitHub();
    const client = gh.client();
    const results = await Promise.all([
      client.write(repo, ref, null, held),
      client.write(repo, "refs/limitless/claims/13", null, { ...held, number: 13 }),
    ]);
    expect(results.map((r) => r.kind)).toEqual(["applied", "applied"]);
    expect(gh.calls("tree")).toHaveLength(1);
    expect(gh.calls("repository")).toHaveLength(1);
    await Promise.all([client.read(repo, ref), client.read(repo, ref)]);
    expect(gh.calls("commitRead")).toHaveLength(1);
  });
  test("101 historical refs need one exact read and never a listing", async () => {
    const gh = new GitHub();
    for (let number = 1; number <= 101; number++)
      gh.seed({ ...held, number }, `refs/limitless/claims/${number}`);
    expect(await gh.client().read(repo, "refs/limitless/claims/87")).toMatchObject({
      kind: "tip",
      tip: { record: { number: 87 } },
    });
    expect(gh.requests.map((r) => r.step)).toEqual(["ref", "commitRead"]);
  });
  test("trees and repository ids are cached per repo, raw commits per instance, tips never cached", async () => {
    const gh = new GitHub();
    const client = gh.client();
    for (const repository of [repo, "owner/other"]) {
      const created = await client.write(repository, ref, null, held);
      if (created.kind !== "applied") throw new Error("Expected create");
      await client.read(repository, ref);
      await client.read(repository, ref);
      await client.write(repository, ref, created.tip, { ...held, state: "released" });
      expect(await client.read(repository, ref)).toMatchObject({
        kind: "tip",
        tip: { record: { state: "released" } },
      });
    }
    expect(gh.calls("tree")).toHaveLength(2);
    expect(gh.calls("repository")).toHaveLength(2);
    expect(gh.calls("commitRead")).toHaveLength(4);
    expect(gh.calls("ref")).toHaveLength(6);
    const fresh = gh.client();
    const previous = await fresh.read(repo, ref);
    if (previous.kind !== "tip") throw new Error("Expected tip");
    await fresh.write(repo, ref, previous.tip, held);
    expect(gh.calls("tree")).toHaveLength(3);
    expect(gh.calls("repository")).toHaveLength(3);
    expect(gh.calls("commitRead")).toHaveLength(5);
  });
  test("member id is opaque, stable and survives Store reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "claim-member-"));
    const path = join(directory, "store.db");
    let store = new Store(path);
    try {
      const id = memberId(store);
      expect(id).toMatch(/^m-[0-9a-f]{16}$/);
      expect(memberId(store)).toBe(id);
      expect(store.getSetting("member.id", "missing")).toBe(id);
      store.close();
      store = new Store(path);
      expect(memberId(store)).toBe(id);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
