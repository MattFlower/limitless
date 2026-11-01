import { z } from "zod";
import { defectItemSchema } from "./defect-publication.ts";
import type { DefectGitHub } from "./defect-reporter.ts";

/** REST supplies pagination and writes; GraphQL supplies edit provenance unavailable in REST. */
export function createDefectGitHub(signal: AbortSignal, transport: typeof fetch = fetch): DefectGitHub {
  const request = async (path: string, token: string, body?: unknown) => {
    signal.throwIfAborted();
    const response = await transport(`https://api.github.com/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw new Error("Defect GitHub request failed");
    return response.json() as Promise<unknown>;
  };
  const hydrate = async (raw: unknown, token: string) => {
    const values = z.array(z.object({ node_id: z.string() })).parse(raw);
    if (!values.length) return [];
    const fields = `body createdAt author { login __typename } lastEditedAt includesCreatedEdit`;
    const query = `query { nodes(ids:${JSON.stringify(values.map((v) => v.node_id))}) {
      ... on Issue { number ${fields} labels(first:100) { nodes { name } } }
      ... on PullRequest { number ${fields} }
      ... on IssueComment { databaseId ${fields} } } }`;
    const result = z
      .object({
        errors: z.never().optional(),
        data: z.object({ nodes: z.array(z.record(z.string(), z.unknown())).length(values.length) }),
      })
      .parse(await request("graphql", token, { query }));
    return result.data.nodes.map((node) => ({
      ...defectItemSchema.parse({ ...node, number: node.number ?? node.databaseId }),
      ...(node.number !== undefined && node.labels === undefined ? { pull_request: true } : {}),
      labels: z
        .object({ nodes: z.array(z.object({ name: z.string() })) })
        .optional()
        .parse(node.labels)?.nodes,
    }));
  };
  const path = (repo: string, issue: number | null) =>
    `repos/${repo}/issues${issue === null ? "" : `/${issue}/comments`}`;
  return {
    list: async (repo, issue, page, token) =>
      hydrate(
        await request(
          `${path(repo, issue)}?state=all&sort=created&direction=asc&per_page=100&page=${page.page}`,
          token,
        ),
        token,
      ),
    issue: async (repo, issue, token) =>
      (await hydrate([await request(`repos/${repo}/issues/${issue}`, token)], token))[0],
    label: async (repo, name, token) =>
      z.object({ name: z.literal("defect") }).parse(await request(`repos/${repo}/labels/${name}`, token))
        .name === name,
    post: async (repo, issue, input, token) =>
      (await hydrate([await request(path(repo, issue), token, input)], token))[0],
  };
}
