import { CommandError } from "./proc.ts";

export class NetworkFailure extends Error {
  constructor(
    cause: string,
    readonly step?: string,
  ) {
    super(`Network failure: ${cause}`);
  }
}

// Inspect diagnostic lines (also `npm error code …`, `curl: (6) …`), never command strings, successes or prose.
const codes = "ENOTFOUND|EAI_AGAIN|DNSResolveFailed|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH";
const prefix = `^(?:(?:error|fatal|TypeError|API Error|Network failure):\\s*|npm (?:error|ERR!)(?: code| errno)? |curl: \\(\\d+\\) )?`;
const diagnostic = new RegExp(
  `${prefix}(?:(?:${codes})\\b|(?:getaddrinfo|connect|fetch failed|request failed|network request|Can.t reach the API server)[^\\n]*\\b(${codes})\\b)`,
  "im",
);
const connection = new RegExp(
  prefix +
    /(?:(?:ssh:\s*)?could not resolve host(?:name)?|unable to resolve (?:host|hostname)|unable to access [^\n]*could not resolve host|(?:connection refused|connection reset by peer|failed to lookup address information)\b|(?:failed to connect|unable to connect|can.t reach the API server|error connecting to)\b[^\n]*(?:connection refused|could(?: not|n.t) resolve|no such host|name resolution|name or service not known|network is unreachable|no route to host|internet or DNS)|(?:Post|Get|Head|Put|Patch|Delete) "[^"\n]+": [^\n]*(?:lookup [^\n]*: (?:no such host|temporary failure in name resolution)|connect: connection refused)|error sending request [^\n]*(?:dns error|connection refused)|ssh: connect to host [^\n]*(?:refused|unreachable))/
      .source,
  "im",
);
const nonNetwork =
  /\b(?:40[13]|429|unauthori[sz]ed|authenticat\w*|forbidden|credentials?|api key|token|permission denied|quota|rate.?limit\w*|usage limit|billing|credits?)\b/i;

// Hostnames, URLs and package paths name targets, not failure kinds (`token.example`, `@aws-sdk/credential-…`).
const withoutHosts = (line: string) =>
  line.replace(/\S*\w[./@]\w\S*/g, " ").replace(new RegExp(`\\b(${codes})\\s+\\S+`, "g"), "$1");

/** Returns only a fixed, public cause; raw diagnostics can contain private hosts or credentials. */
export function networkFailure(value: unknown, step?: string): NetworkFailure | undefined {
  const seen = new Set<unknown>();
  const inspect = (input: unknown): NetworkFailure | undefined => {
    if (!input || typeof input !== "object" || seen.has(input)) return;
    seen.add(input);
    if (input instanceof NetworkFailure) return input;
    const v = input as Record<string, unknown>;
    if (v.status === "ok" || v.ok === true || v.status === "quota" || v.failureClass === "authentication")
      return;
    let text: unknown;
    if (input instanceof CommandError) {
      if (input.exitCode === 0) return;
      text = `${input.stderr}\n${input.stdout}`;
    } else if (input instanceof Error || (v.status === undefined && v.ok === undefined)) {
      const cause = inspect(v.cause);
      if (cause) return cause;
      text =
        typeof v.code === "string" && new RegExp(`^(?:${codes})$`).test(v.code)
          ? v.code
          : typeof v.message === "string"
            ? v.message.split("\n", 1)[0]
            : undefined;
    } else if ((v.status === "error" || v.status === "unavailable") && v.failureClass !== "authentication")
      text = [v.error, v.finalText].filter((t) => typeof t === "string" && t).join("\n");
    else if (v.ok === false && v.exitCode !== 0) text = v.output;
    else return;
    if (typeof text !== "string") return;
    const failedText = text.replace(/^stream disconnected before completion:\s*/i, "");
    // A diagnostic line that also names an authentication, quota or rate-limit failure is not an outage.
    const outage = (m: RegExpExecArray | null) =>
      m && !nonNetwork.test(withoutHosts(failedText.slice(m.index).split("\n", 1)[0] ?? "")) ? m : undefined;
    const code = outage(diagnostic.exec(failedText))?.[0].match(new RegExp(`\\b(${codes})\\b`))?.[1];
    if (code) return new NetworkFailure(code, step);
    const generic = "host resolution or connection failed";
    if (failedText === `Network failure: ${generic}` || outage(connection.exec(failedText)))
      return new NetworkFailure(generic, step);
  };
  return inspect(value);
}
