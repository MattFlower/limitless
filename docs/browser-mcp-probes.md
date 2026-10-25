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

The new pinned-server browser probes are **unperformed on unconfined macOS**.
This factory session cannot nest Seatbelt. Skipped tests are not confinement evidence;
both `CONFINEMENT_GAPS` remain, so production browser setup still fails closed.

After explicit operator provisioning with `bun scripts/provision-browser-mcp.ts`,
run `bun test test/browser-mcp-seatbelt.test.ts` from an unconfined macOS checkout
under the real home. The test uses the production MCP configuration, the pinned
server and its pinned Chromium, ephemeral local servers, and actual screenshot
tools. It checks allowed navigation and screenshots, blocked off-port fetch and
redirect, and denied screenshot creation and overwrite in the checkout.
`LIMITLESS_HOME` selects the provisioned tool-cache home, as in the provisioning script.
No test provisions packages or downloads browsers.
Before landing, also run `bun run check` unconfined from that checkout under the
real home, as required for shared confinement-policy changes.

Only after those probes pass may the corresponding gap entries be removed.
Claude editors and unsupported platforms remain excluded independently.
