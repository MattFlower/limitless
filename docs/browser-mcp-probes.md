# Browser MCP confinement evidence (#890)

Include the following supplied path-probe table unchanged in the PR description.
These path probes were completed by the orchestrator on unconfined macOS,
2026-10-25, main `edc9922c`. They do not establish the new browser boundaries.

| Path | Profile applies? | Today the server can |
|---|---|---|
| Claude editor (implement) | no: exit 71, already inside the factory's outer profile | reach the network; write only the checkout and scratch |
| Claude reader (verify) | yes: exit 0 | read `~/.ssh`, write the home, reach the network |
| Codex editor | yes: exit 0 | read `~/.ssh`, write the home, reach the network |
| Codex reader | yes: exit 0 | read `~/.ssh`, write the home, reach the network |
| LAN workers | n/a: src/pipeline/lan-agent.ts disables the browser (the preview is on the coordinator) | — |

The orchestrator also established that headless Chromium renders without an outer
profile, fails to initialize its own sandbox under any outer Seatbelt profile,
and renders under an outer profile with its own sandbox disabled.

The new pinned-server browser probes are **unperformed on unconfined macOS**: this
factory session cannot nest Seatbelt, so `test/browser-mcp-seatbelt.test.ts` skips
here, and a skip is not confinement evidence. The profile closes both former
`CONFINEMENT_GAPS` entries on the paths that apply it, so the list is now empty
and those paths get a browser. The issue makes the orchestrator's unconfined review
run of these probes the gate: if any probe fails, the change must not land, and the
corresponding gap entry goes back.

After explicit operator provisioning with `bun scripts/provision-browser-mcp.ts`,
run `bun test test/browser-mcp-seatbelt.test.ts` from an unconfined macOS checkout
under the real home. The test uses the production MCP configuration and gap list,
the pinned server and its pinned Chromium, ephemeral local servers, and actual
screenshot tools. It checks allowed navigation and screenshots, blocked off-port
fetch and redirect, and denied screenshot creation and overwrite in the checkout.
`LIMITLESS_HOME` selects the provisioned tool-cache home, as in the provisioning script.
No test provisions packages or downloads browsers.
Before landing, also run `bun run check` unconfined from that checkout under the
real home, as required for shared confinement-policy changes.

Seatbelt network rules accept only `*` or `localhost` as the host, so the profile
selects the preview's loopback address by family: `(remote ip4 "localhost:<port>")`
for `127.0.0.1`, `(remote ip6 "localhost:<port>")` for `[::1]`, and both for
`localhost`. No other port, address family or destination is allowed. Unit tests
compile each loopback form with `sandbox-exec`.

Claude editors, LAN workers and unsupported platforms remain excluded independently
of the gap list.
