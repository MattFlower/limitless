import { expect, test } from "bun:test";
import { networkFailure } from "../src/util/network-failure.ts";
import { CommandError } from "../src/util/proc.ts";

test.each([
  new Error("ENOTFOUND"),
  new Error('Post "https://api.example.invalid": dial tcp: lookup api.example.invalid: no such host'),
  new Error("ssh: Could not resolve hostname example.invalid: Temporary failure in name resolution"),
  new Error("error sending request for url: dns error: failed to lookup address information"),
  new Error("getaddrinfo EAI_AGAIN example.invalid"),
  new Error("error: DNSResolveFailed downloading tarball example.invalid"),
  { status: "unavailable", error: "connect ECONNREFUSED example.invalid" },
  { status: "error", error: "API Error: Can't reach the API server — check your DNS (ENOTFOUND)" },
  { status: "error", error: "Network failure: host resolution or connection failed" },
  {
    status: "error",
    error:
      "stream disconnected before completion: error sending request for url: dns error: failed to lookup address information",
  },
  new Error("fetch failed", { cause: { code: "ENOTFOUND" } }),
  new Error("wrapper", { cause: new Error("wrapper", { cause: new Error("connect ECONNREFUSED") }) }),
  new CommandError("command omitted", 1, "error: DNSResolveFailed downloading tarball", "", false),
  new CommandError(
    "command omitted",
    128,
    "",
    "fatal: unable to access 'url': Could not resolve host",
    false,
  ),
  { ok: false, exitCode: 1, output: "error: ENOTFOUND example.invalid" },
  new CommandError("command omitted", 1, "", "npm error code ENOTFOUND", false),
  new CommandError("command omitted", 1, "", "npm ERR! code EAI_AGAIN", false),
  new CommandError("command omitted", 1, "", "npm error code EAI_AGAIN", false),
  new CommandError(
    "command omitted",
    1,
    "",
    "npm error network request to https://example.invalid/pkg failed, reason: getaddrinfo ENOTFOUND example.invalid",
    false,
  ),
  new CommandError("command omitted", 6, "", "curl: (6) Could not resolve host: example.invalid", false),
  new CommandError(
    "command omitted",
    7,
    "",
    "curl: (7) Failed to connect to example.invalid port 443: Connection refused",
    false,
  ),
  { ok: false, exitCode: 6, output: "curl: (6) Could not resolve host: example.invalid" },
  new Error("getaddrinfo ENOTFOUND token.example.invalid"),
  new CommandError("command omitted", 1, "", "getaddrinfo ENOTFOUND billing.example.invalid", false),
  new CommandError("command omitted", 1, "", "connect ECONNREFUSED credentials.example.invalid:443", false),
  {
    ok: false,
    exitCode: 1,
    output:
      "error: DNSResolveFailed downloading tarball https://registry.npmjs.org/@aws-sdk/credential-provider-node/-/package.tgz",
  },
  {
    status: "error",
    error: "claude exited with code 1",
    finalText: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
  },
])("network diagnostics are classified safely: %#", (error) => {
  expect(networkFailure(error)?.message).toStartWith("Network failure:");
  expect(networkFailure(error)?.message).not.toContain("example.invalid");
});

test.each([
  new Error("AssertionError: expected ENOTFOUND to equal EAI_AGAIN"),
  new Error('The issue quotes "ENOTFOUND"'),
  new Error("Still failing after 3 rounds. Feedback:\nerror: ENOTFOUND"),
  new Error("Cannot find package example"),
  new Error("HTTP 401: authentication failed"),
  new Error("quota exceeded"),
  new Error("Failed to connect: authentication failed"),
  new Error("Unable to connect: quota exceeded"),
  new Error("error connecting to api: HTTP 401 Unauthorized"),
  { status: "error", error: "Failed to connect to the API: invalid API key" },
  { status: "error", error: "Unable to connect: usage limit reached" },
  { status: "error", error: "API Error: Can't reach the API server: rate limit exceeded" },
  { status: "error", error: "connect ECONNRESET: 429 Too Many Requests" },
  new CommandError("gh failed", 1, "", "error connecting to api.github.com: HTTP 403 forbidden", false),
  new Error("timed out after 1000ms"),
  { status: "error", error: "stream disconnected before completion" },
  { status: "ok", error: "ENOTFOUND", finalText: "connect ECONNREFUSED" },
  { status: "quota", error: "ENOTFOUND" },
  { status: "unavailable", failureClass: "authentication", error: "ENOTFOUND" },
  { ok: true, exitCode: 0, output: "ENOTFOUND" },
  { ok: false, exitCode: 1, command: "echo ENOTFOUND", output: "assertion failed" },
  new CommandError("echo ENOTFOUND failed", 1, "", "assertion failed", false),
  new CommandError("failed", 0, "ENOTFOUND", "", false),
  new CommandError("failed", 0, "", "curl: (6) Could not resolve host: example.invalid", false),
  new CommandError("npm install failed", 1, "", "npm error code E401", false),
  new CommandError("curl failed", 22, "", "curl: (22) The requested URL returned error: 404", false),
  new CommandError("curl failed", 1, "", "test said curl: (6) Could not resolve host", false),
  "ENOTFOUND",
])("ordinary failures and successful output are not outages: %#", (error) => {
  expect(networkFailure(error)).toBeUndefined();
});

test("cyclic wrapped errors terminate without inventing a network failure", () => {
  const error = new Error("ordinary error");
  error.cause = error;
  expect(networkFailure(error)).toBeUndefined();
});
