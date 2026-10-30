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

## Pinned-browser probe (unconfined macOS, 2026-10-29)

Run by hand on unconfined macOS from a checkout under the real home, against the production
cache: `@playwright/mcp@0.0.83`, Chrome for Testing `chromium-1247`, Homebrew Node 26.7.0. The
probe calls `browserMcp` with the gaps cleared, so it exercises exactly the launch configuration
the paths receive. Its MCP client, like Claude, offers the checkout as a root; the server then
treats the checkout as a workspace its own file checks allow, so only the profile keeps screenshots
out of it. Every assertion passed (`1 pass, 41 expect() calls`), and three repeated runs passed:

| Assertion | Result |
|---|---|
| Node under the profile reads a file in its browser directory | pass |
| Node cannot read a file in the checkout or a sibling scratch directory, nor either through `/System/Volumes/Data` (EPERM) | pass |
| The server starts from the checkout cwd and navigates to the preview | pass |
| The page's same-origin fetch loads; its fetch to another loopback port fails | pass |
| `mach-lookup` of `com.apple.SecurityServer`, `com.apple.coreservices.appleevents`, `com.apple.pasteboard.1`, `com.apple.tccd` is denied (`sandbox_check` on the server's pid) | pass |
| `mach-lookup` of `com.apple.coreservices.launchservicesd` is allowed (the check discriminates) | pass |
| `appleevent-send` and POSIX shared memory are denied | pass |
| A screenshot into the output directory is a PNG | pass |
| A screenshot to a new file in the checkout, over an existing one, or through a symlink in the output directory that points into the checkout fails and leaves the checkout unchanged | pass |
| A redirect to another loopback port fails with `net::ERR_ACCESS_DENIED` | pass |
| A redirect to an external origin (`192.0.2.1`, TEST-NET-1) fails with `net::ERR_ACCESS_DENIED` | pass |
| `file://` navigation to a checkout file does not show it | pass |
| A download lands in the output directory, not the checkout | pass |
| A redirect that changes only the hostname (to `localhost:<port>`) reaches the preview server and nothing else: a listener on `[::1]:<port>` receives nothing | pass |
| The other loopback port received no request: no WebSocket, `sendBeacon`, fetch or redirect | pass |

Negative controls (each appended one rule to the generated profile) show the assertions depend on
it: `(allow network-outbound)` let the redirect and the WebSocket reach the other port;
allowing IPv6 loopback let the hostname-change redirect reach the `[::1]` listener; reading the
checkout made the denied reads succeed; `(allow mach-lookup)` made the IPC checks fail; with the
checkout readable and writable, a screenshot was written into it. With reads widened but the write
deny kept, the checkout screenshots still failed (EPERM on `open`).

Every granted UI tool (navigate, back, snapshot, click, type, fill form, select, press key, hover,
drag, wait, tabs, close, resize, dialog, console, network requests, screenshot) also ran without
error under the final profile, and no Chromium process outlived the server.

After this run both `CONFINEMENT_GAPS` entries were removed.

## What the profile allows, and why

Everything was found by iterating the probe and then removing each allowance in turn; each one
that remains is needed for Node or Chromium to start, navigate or render. A blanket
`(deny file-read*)` covers everything else, including the checkout, other scratch and
`/System/Volumes/Data`; the credential and private-path denies follow the allowances.

| Allowance | Reason |
|---|---|
| file-read-data on `/` (literal) | dyld opens the root directory to find its shared cache; Node aborts in `CacheFinder` without it. It exposes only top-level names. |
| file-read-metadata on each symlink of dyld's lookups (literals) | dyld loads Homebrew libraries through `opt` links, versioned dylib links, `@rpath` and `@loader_path` (for example `libicudata.78.dylib`). `src/harness/dyld-links.ts` reads the recorded runtime's Mach-O load commands, refuses malformed ones, and grants the links of each dependency's lookup (36 for the pinned Node). A required non-system dependency that no longer ends at a recorded library refuses setup. |
| The recorded Node runtime and libraries, the browser directory, the pinned cache | Node, its libraries, the MCP server and Chromium. |
| `/System/Library`, `/usr/lib` | frameworks, system fonts and libraries |
| `/usr/share/icu` | CoreFoundation's ICU data |
| `/usr/share/langid` | language identification data; Chromium asserts in `LanguageIdentifier.c` without it |
| `/dev/null` | `OPENSSL_CONF` below |
| `OPENSSL_CONF=/dev/null` | Node aborts when it cannot read an OpenSSL configuration, and Homebrew's `openssl.cnf` is outside the profile |
| `MAC_CHROMIUM_TMPDIR=<browser directory>` | Chromium on macOS ignores `TMPDIR`; its profile lock cannot create its socket directory without it |
| `/usr/bin/env -C <browser directory>` before `sandbox-exec` | agents start MCP servers in their checkout, and Node's `process.cwd()` fails with EPERM there |

Removal showed these earlier allowances unnecessary, so they are gone: `/usr/share` (beyond the
two above), `/Library/Fonts`, `/Library/Apple/System/Library`, the timezone database and
`/etc/localtime` (pages see UTC), `/dev/random`, `/dev/urandom` and `/dev/zero`.

Chromium's socket path must fit in `sockaddr_un`. Production scratch (`/tmp/lr-…/claude-<uid>`)
fits; a scratch under the long per-user `$TMPDIR` does not, and Chromium then exits (the browser
fails closed). The probe therefore creates its scratch with `createScratch`, as runs do.

### IPC

With Chromium's own sandbox off, the profile bounds IPC for the browser only; gate profiles are
unchanged. An interposer logged every `bootstrap_look_up`, `bootstrap_check_in`,
`xpc_connection_create_mach_service`, `shm_open` and `sem_open` of a run with IPC unrestricted
(47 services, including SecurityServer, securityd, pasteboard, tccd, LaunchServices databases,
Apple Events, iCloud and Spotlight). Starting from deny-all and then removing each remaining name
left:

| Allowed | Reason |
|---|---|
| `mach-lookup` `com.apple.coreservices.launchservicesd` | LaunchServices check-in: Chromium's `TransformProcessType` aborts in `_RegisterApplication` without it |
| `mach-lookup` XPC service `com.apple.MTLCompilerService` | the GPU process's Metal shader compiler; without it `Page.captureScreenshot` fails ("Unable to capture screenshot") |
| `mach-lookup` and `mach-register` `com.google.chrome.for.testing.MachPortRendezvousServer.<pid>` | Chromium's child processes check in with the browser process |

Everything else is denied: `mach-lookup`, `mach-register`, `appleevent-send`, `ipc-posix*` and
`ipc-sysv*`. Screenshots of a test page (Latin and CJK text) were byte-identical with IPC unrestricted
and restricted. Crash reporting is off (crashpad cannot check in), which is harmless.

### Residual exposure

- LaunchServices check-in stays reachable. launchservicesd also serves application launches;
  Apple Events, the LaunchServices databases (`lsd.*`) and every other service stay denied.
- Seatbelt does not gate `exec` on file reads, so a process may execute a binary it cannot read;
  it still runs under this profile.
- The profile starts from `(allow default)` and restricts network, file, signal and IPC operations
  only. IOKit user clients (the GPU process needs them), binding and accepting sockets, and sysctl
  reads stay allowed.
- The allowlist was measured on one macOS release with this Chrome build and Homebrew Node; another
  coordinator, macOS release or pin needs the probe re-run. A Homebrew upgrade that moves an `opt`
  link, even with the old keg kept, makes setup refuse with "browser runtime changed: … reprovision
  the browser cache".
- `dyld-links.ts` models only the lookups a thin, single-architecture Homebrew Node uses: `@rpath` from
  the image's own and the executable's run paths, `@loader_path`, `@executable_path`, and the first
  candidate that exists. It doesn't follow run paths inherited through intermediate libraries, pick
  among candidates by architecture, recognize shared-cache images named through `@rpath`, or tell an
  unused lazy dependency that exists on disk from a loaded one. A runtime that needs any of those
  refuses setup with a named reason (it fails closed); reprovision the cache with a standard
  Homebrew Node.

## Running the probe

After explicit operator provisioning with `bun scripts/provision-browser-mcp.ts`,
run `bun test test/browser-mcp-seatbelt.test.ts` from an unconfined macOS checkout
under the real home. Factory gates skip it (Seatbelt cannot nest), and a skip is not
confinement evidence. It uses the production MCP configuration, the pinned server and its
pinned Chromium, ephemeral local servers and the real screenshot tools.
`LIMITLESS_BROWSER_MCP_CACHE` selects a provisioned cache directory; it defaults to
`~/.limitless/tools/playwright-mcp-0.0.83`. The probe ignores `LIMITLESS_HOME`, which
`test/setup.ts` points at a temporary home. No test provisions packages or downloads browsers.
Before landing, also run `bun run check` unconfined from that checkout under the
real home, as required for shared confinement-policy changes.

Browser previews must be `http://127.0.0.1:<port>`, which is what the preview service produces;
any other host or scheme gets no browser. Seatbelt network rules accept only `*` or `localhost` as
the host, so the profile allows exactly `(remote ip4 "localhost:<port>")`: no other port, no IPv6,
no other destination. Unit tests compile it with `sandbox-exec`.

The boundary is the preview's socket, not its web origin. Seatbelt cannot see HTTP hostnames, and
the pinned server's origin check does not recheck redirects, so a redirect that changes only the
hostname on the same port (for example to `http://localhost:<port>`) loads from the same preview
server under another origin. That is an accepted residual: it reaches no other process, since IPv6
loopback, where another process could hold the same port, stays denied.

Claude editors, LAN workers and unsupported platforms remain excluded independently
of the gap list.
