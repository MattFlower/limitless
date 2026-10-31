import { z } from "zod";

export const ISSUE_TEXT_FIELDS = `number body author { login } editor { login } lastEditedAt
  userContentEdits(first:100) { nodes { editor { login } } pageInfo { hasNextPage } }`;
export const issueTextSchema = z.object({
  number: z.number().int().positive(),
  body: z.string(),
  author: z.object({ login: z.string() }).nullable(),
  editor: z.object({ login: z.string() }).nullable(),
  lastEditedAt: z.string().nullable(),
  userContentEdits: z.object({
    nodes: z.array(z.object({ editor: z.object({ login: z.string() }).nullable() })).max(100),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
});
export interface IssueText {
  number: number;
  body: string;
  author: { login: string } | null;
  editor?: { login: string } | null;
  lastEditedAt?: string | null;
  userContentEdits?: z.infer<typeof issueTextSchema>["userContentEdits"];
}

export function issueTextRefusal(issue: IssueText, trusted: string[]): string | undefined {
  const trusts = (login: string | undefined) =>
    !!login && trusted.some((s) => s.toLowerCase() === login.toLowerCase());
  if (!trusts(issue.author?.login)) return "untrusted author";
  if (issue.lastEditedAt && !trusts(issue.editor?.login)) return "untrusted body editor";
  const history = issueTextSchema.shape.userContentEdits.safeParse(issue.userContentEdits);
  if (!history.success) return "body edit history unavailable";
  if (history.data.pageInfo.hasNextPage) return "body edit history exceeds 100 edits";
  for (const edit of history.data.nodes)
    if (!trusts(edit.editor?.login)) return `untrusted body editor: ${edit.editor?.login ?? "unknown"}`;
}
