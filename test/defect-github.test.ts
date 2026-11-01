import { expect, test } from "bun:test";
import { createDefectGitHub } from "../src/integrations/defect-github.ts";

const body = `<!-- limitless-defect:v1:issue:${"a".repeat(64)}:${"b".repeat(32)} -->\nEvidence`;
const issue = {
  number: 7,
  body,
  createdAt: "2026-10-31T18:00:00Z",
  author: { login: "factory[bot]", __typename: "Bot" },
  lastEditedAt: null,
  includesCreatedEdit: false,
  labels: { nodes: [{ name: "defect" }] },
};

function fixture() {
  const calls: { url: string; init?: RequestInit }[] = [];
  let nodes: unknown[] = [issue];
  const abort = new AbortController();
  const transport = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const raw = url.endsWith("graphql")
      ? { data: { nodes } }
      : url.includes("/labels/")
        ? { name: "defect" }
        : url.includes("page=")
          ? nodes.map((_, i) => ({ node_id: `node-${i}` }))
          : { node_id: "node-0" };
    return Response.json(raw);
  }) as typeof fetch;
  return {
    calls,
    abort,
    transport,
    setNodes: (values: unknown[]) => {
      nodes = values;
    },
    gh: createDefectGitHub(abort.signal, transport),
  };
}

test("App adapter hydrates REST pages and writes with GraphQL provenance, labels and comment IDs", async () => {
  const h = fixture();
  const page = { state: "all", page: 2, perPage: 100 } as const;
  expect(await h.gh.list("example/factory", null, page, "app-token")).toEqual([
    { ...issue, labels: [{ name: "defect" }] },
  ]);
  expect(h.calls[0]?.url).toBe(
    "https://api.github.com/repos/example/factory/issues?state=all&sort=created&direction=asc&per_page=100&page=2",
  );
  expect(h.calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer app-token" });
  expect(JSON.parse(String(h.calls[1]?.init?.body)).query).toContain("lastEditedAt includesCreatedEdit");
  expect(await h.gh.label("example/factory", "defect", "app-token")).toBe(true);
  expect(await h.gh.issue("example/factory", 7, "app-token")).toMatchObject({
    number: 7,
    lastEditedAt: null,
  });
  const result = await h.gh.post(
    "example/factory",
    null,
    { body, title: "Factory defect", labels: ["defect"] },
    "app-token",
  );
  expect(result).toMatchObject({ number: 7, includesCreatedEdit: false });
  const post = h.calls.find((c) => c.url.endsWith("/issues") && c.init?.method === "POST");
  expect(JSON.parse(String(post?.init?.body))).toEqual({ body, title: "Factory defect", labels: ["defect"] });
  const { number: _number, labels: _labels, ...comment } = issue;
  h.setNodes([{ ...comment, databaseId: 27 }]);
  expect(await h.gh.post("example/factory", 7, { body }, "app-token")).toMatchObject({ number: 27 });
  expect(h.calls.some((c) => c.url.endsWith("/issues/7/comments") && c.init?.method === "POST")).toBe(true);
});

test("App adapter retains PR exclusions and rejects incomplete hydration rather than reporting absence", async () => {
  const h = fixture();
  const { labels: _labels, ...pr } = issue;
  h.setNodes([pr]);
  expect(
    await h.gh.list("example/factory", null, { state: "all", page: 1, perPage: 100 }, "token"),
  ).toMatchObject([{ pull_request: true }]);
  const gh = createDefectGitHub(h.abort.signal, (async (url: string) =>
    Response.json(
      url.endsWith("graphql") ? { data: { nodes: [] } } : [{ node_id: "missing" }],
    )) as typeof fetch);
  await expect(
    gh.list("example/factory", null, { state: "all", page: 1, perPage: 100 }, "token"),
  ).rejects.toThrow();
});

test("App adapter cancellation between REST and hydration prevents a new request", async () => {
  const abort = new AbortController();
  let calls = 0;
  const gh = createDefectGitHub(abort.signal, (async () => {
    calls++;
    abort.abort();
    return Response.json([{ node_id: "one" }]);
  }) as unknown as typeof fetch);
  await expect(
    gh.list("example/factory", null, { state: "all", page: 1, perPage: 100 }, "token"),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
