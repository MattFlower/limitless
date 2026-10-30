export interface IssueText {
  number: number;
  body: string;
  author: { login: string } | null;
  editor?: { login: string } | null;
  lastEditedAt?: string | null;
}

export function issueTextRefusal(issue: IssueText, trusted: string[]): string | undefined {
  const trusts = (login: string | undefined) =>
    !!login && trusted.some((s) => s.toLowerCase() === login.toLowerCase());
  if (!trusts(issue.author?.login)) return "untrusted author";
  if (issue.lastEditedAt && !trusts(issue.editor?.login)) return "untrusted body editor";
}
