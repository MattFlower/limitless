import { CommandError } from "../util/proc.ts";

/** Raised once transient GitHub failures exhaust their retries, so runs read as environment-caused. */
export class GitHubUnavailableError extends Error {}

/** Delays between attempts (3 attempts over about a minute). Mutable so tests can shorten them. */
export const githubRetry = { delaysMs: [15_000, 45_000] };

// Network/timeout failures; a reported HTTP status is classified before these are consulted.
// `Command failed (SIGTERM)` is `sh` killing a command at its timeout (cancellation throws earlier).
const NETWORK =
  /\b(502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out)\b|Command failed \(SIG(TERM|KILL)\)|timed? ?out|could not resolve host|could not connect to server|temporary failure in name resolution|connection (reset|refused|closed)|network is unreachable|ECONNRESET|ETIMEDOUT|TLS handshake|unexpected disconnect|remote end hung up|early EOF/i;

/** Only 5xx, 429 and network/timeout failures; 4xx validation or auth errors never match. */
export function isTransient(text: string): boolean {
  const status = text.match(/\bHTTP (\d{3})\b|returned error: (\d{3})\b/);
  if (status) {
    const code = Number(status[1] ?? status[2]);
    return code >= 500 || code === 429;
  }
  return NETWORK.test(text);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `op` with bounded backoff on transient failures. A 502 can hide an operation that actually
 * succeeded, so after every transient failure (the last one included) `reconcile` may inspect
 * remote state and return the settled result instead of repeating or failing the operation.
 */
export async function withGithubRetry<T>(
  label: string,
  op: () => Promise<T>,
  opts: { signal?: AbortSignal; reconcile?: () => Promise<T | undefined> } = {},
): Promise<T> {
  const { signal, reconcile } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      signal?.throwIfAborted();
      const message = (e as Error).message;
      // Command arguments (e.g. a PR title mentioning "timeout") are not evidence of a failure.
      const evidence = e instanceof CommandError ? `Command failed (${e.status})\n${e.output}` : message;
      if (!isTransient(evidence)) throw e;
      // A failed reconcile leaves the outcome unknown, so its error propagates rather than
      // permitting another attempt that could duplicate a success the failure hid.
      const settled = reconcile ? await reconcile() : undefined;
      if (settled !== undefined) return settled;
      signal?.throwIfAborted();
      const delay = githubRetry.delaysMs[attempt];
      if (delay === undefined)
        throw new GitHubUnavailableError(
          `GitHub unavailable: ${label} failed after ${attempt + 1} attempts: ${message}`,
        );
      await sleep(delay, signal);
    }
  }
}
