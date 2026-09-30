/** Raised once transient GitHub failures exhaust their retries, so runs read as environment-caused. */
export class GitHubUnavailableError extends Error {}

/** Delays between attempts (3 attempts over about a minute). Mutable so tests can shorten them. */
export const githubRetry = { delaysMs: [15_000, 45_000] };

// 5xx, 429 and network/timeout failures only; 4xx validation or auth errors never match.
// `Command failed (SIGTERM)` is `sh` killing a command at its timeout (cancellation throws earlier).
const TRANSIENT =
  /HTTP (5\d\d|429)\b|returned error: (5\d\d|429)\b|\b(502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out)\b|Command failed \(SIG(TERM|KILL)\)|timed? ?out|could not resolve host|connection (reset|refused|closed)|network is unreachable|ECONNRESET|ETIMEDOUT|TLS handshake|unexpected disconnect|remote end hung up|early EOF/i;

export function isTransient(text: string): boolean {
  return TRANSIENT.test(text);
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
 * Run `op` with bounded backoff on transient failures. Retries get `retrying = true` so they can
 * first reconcile with remote state: a 502 can hide an operation that actually succeeded.
 */
export async function withGithubRetry<T>(
  label: string,
  op: (retrying: boolean) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op(attempt > 0);
    } catch (e) {
      signal?.throwIfAborted();
      const message = (e as Error).message;
      if (!isTransient(message)) throw e;
      const delay = githubRetry.delaysMs[attempt];
      if (delay === undefined)
        throw new GitHubUnavailableError(
          `GitHub unavailable: ${label} failed after ${attempt + 1} attempts: ${message}`,
        );
      await sleep(delay, signal);
    }
  }
}
