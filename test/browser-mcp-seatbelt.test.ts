import { dlopen, FFIType, ptr } from "bun:ffi";
import { expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { browserCache, browserMcp } from "../src/harness/browser-mcp.ts";
import { createScratch, scratchParent } from "../src/harness/scratch.ts";
import { agentEnv, runProcess } from "../src/util/proc.ts";
import { browserSpec } from "./browser-mcp-support.ts";
import { seatbeltSkip } from "./confinement.ts";
import { test } from "./read-policy-support.ts";

// Ask the kernel how a confined process's profile decides an operation: 1 denied, 0 allowed.
const sandboxCheck = (pid: number, operation: string, filter: number, value?: string) => {
  const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
    sandbox_check: {
      // Darwin arm64 passes variadic arguments on the stack, after the eight register slots.
      args: [
        FFIType.i32,
        FFIType.ptr,
        FFIType.i32,
        ...(process.arch === "arm64" ? Array<FFIType>(5).fill(FFIType.u64) : []),
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
  });
  return symbols.sandbox_check(
    pid,
    ptr(Buffer.from(`${operation}\0`)),
    filter | 0x40000000 /* NO_REPORT */,
    ...(process.arch === "arm64" ? [0, 0, 0, 0, 0] : []),
    value === undefined ? null : ptr(Buffer.from(`${value}\0`)),
  );
};

// Requires operator provisioning; never substitute the repository's Playwright or download a browser.
// test/setup.ts points LIMITLESS_HOME at a temporary home, so the probe has its own cache variable.
test.skipIf(seatbeltSkip !== null)(
  `pinned MCP browser confines reads, IPC, redirects, fetches and screenshot filenames ${seatbeltSkip ?? ""}`,
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "browser-seatbelt-")));
    const cwd = join(root, "checkout");
    mkdirSync(cwd);
    // Production scratch: Chromium's profile-lock socket path must fit in sockaddr_un.
    const scratch = createScratch(cwd);
    const escaped: string[] = [];
    const other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        escaped.push(new URL(request.url).pathname);
        return new Response("escaped", { headers: { "Access-Control-Allow-Origin": "*" } });
      },
    });
    const elsewhere = `http://127.0.0.1:${other.port}`;
    const preview = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const { pathname: path, port } = new URL(request.url);
        if (path === "/redirect") return Response.redirect(`${elsewhere}/redirect-target`);
        // TEST-NET-1: nothing answers there, so an unconfined browser would hang instead of failing fast.
        if (path === "/external") return Response.redirect("http://192.0.2.1/external-target");
        // Same port, other hostname: an accepted residual, since it reaches this same server.
        if (path === "/rename") return Response.redirect(`http://localhost:${port}/renamed`);
        if (path === "/own") return new Response("own-fetch-ok");
        if (path === "/download")
          return new Response("download", {
            headers: { "Content-Disposition": 'attachment; filename="d.txt"' },
          });
        return new Response(
          `<body>allowed-preview <span id="result"></span><script>
          new WebSocket('ws://127.0.0.1:${other.port}/websocket-target');
          navigator.sendBeacon('${elsewhere}/beacon-target', 'beacon');
          fetch('/own').then(r => r.text()).then(async own => {
            let status;
            try { await fetch('${elsewhere}/fetch-target'); status = 'fetch-escaped'; }
            catch { status = 'fetch-blocked'; }
            document.getElementById('result').textContent = own + ' ' + status;
          });
        </script></body>`,
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    // Another process holding the preview's port on ::1, which `localhost` also resolves to.
    const sibling6 = Bun.serve({
      hostname: "::1",
      port: preview.port,
      fetch(request) {
        escaped.push(`[::1]${new URL(request.url).pathname}`);
        return new Response("escaped");
      },
    });
    // Like Claude, the client offers its checkout as a root, which the server then treats as a workspace
    // its own file checks allow writing to; only the profile keeps screenshots out of it.
    const client = new Client({ name: "confinement-probe", version: "1" }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(cwd).href, name: "checkout" }],
    }));
    let transport: StdioClientTransport | undefined;
    const call = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
    try {
      const cache = process.env.LIMITLESS_BROWSER_MCP_CACHE ?? browserCache(join(homedir(), ".limitless"));
      const spec = browserSpec(cwd, scratch, cache);
      spec.browser = { cacheDir: cache, previewUrl: `http://127.0.0.1:${preview.port}` };
      // Production launch configuration except for the longer action timeout below, for loaded hosts;
      // the gaps are cleared because this probe decides whether CONFINEMENT_GAPS may drop them.
      const server = browserMcp(spec, "codex", []);
      if (!server)
        throw new Error("Pinned browser unavailable; provision it with scripts/provision-browser-mcp.ts");
      server.args.push("--timeout-action", "15000");
      const directory = server.env.HOME;
      if (!directory) throw new Error("missing browser directory");
      // Exercise the production profile with its validated Node runtime, including APFS aliases.
      const node = server.args.slice(0, server.args.indexOf("--headless") - 1);
      const read = (path: string) =>
        runProcess({
          cmd: [
            server.command,
            ...node,
            "-e",
            `
          try { process.stdout.write(require('node:fs').readFileSync(process.argv[1])); }
          catch (error) { process.exit(['EPERM', 'EACCES'].includes(error.code) ? 77 : 78); }
        `,
            "--",
            path,
          ],
          cwd,
          env: { ...agentEnv(), ...server.env },
          timeoutMs: 10_000,
        });
      const readable = join(directory, "readable.txt");
      writeFileSync(readable, "allowed");
      const allowedRead = await read(readable);
      expect(allowedRead.exitCode, allowedRead.stderr).toBe(0);
      expect(allowedRead.stdout).toBe("allowed");
      const sibling = join(scratch, "browser-sibling");
      mkdirSync(sibling);
      for (const file of [join(cwd, "private.txt"), join(sibling, "private.txt")]) {
        writeFileSync(file, "private probe");
        for (const path of [file, `/System/Volumes/Data${file}`]) {
          expect(readFileSync(path, "utf8")).toBe("private probe");
          const denied = await read(path);
          expect(denied.exitCode, denied.stderr).toBe(77);
          expect(denied.stdout).toBe("");
        }
      }
      // The MCP SDK owns the server handle and closes it; browser_close stops its Chromium child.
      // Agents start the server in their checkout, as here.
      transport = new StdioClientTransport({ ...server, cwd, stderr: "pipe" });
      transport.stderr?.on("data", () => {});
      await client.connect(transport, { timeout: 15_000 });
      const navigation = await call("browser_navigate", { url: spec.browser.previewUrl });
      expect(navigation.isError, JSON.stringify(navigation)).not.toBe(true);
      expect(JSON.stringify(await call("browser_snapshot"))).toContain("allowed-preview");
      const fetched = await call("browser_wait_for", { text: "own-fetch-ok fetch-blocked" });
      expect(fetched.isError, JSON.stringify(fetched)).not.toBe(true);

      // env -C execs sandbox-exec, which execs Node: the server's pid carries the profile.
      const pid = transport.pid;
      if (pid === null) throw new Error("missing server pid");
      for (const name of [
        "com.apple.SecurityServer",
        "com.apple.coreservices.appleevents",
        "com.apple.pasteboard.1",
        "com.apple.tccd",
      ])
        expect(sandboxCheck(pid, "mach-lookup", 2 /* GLOBAL_NAME */, name), name).toBe(1);
      // The check discriminates: the one system service the browser needs is allowed.
      expect(sandboxCheck(pid, "mach-lookup", 2, "com.apple.coreservices.launchservicesd")).toBe(0);
      expect(sandboxCheck(pid, "appleevent-send", 4 /* APPLEEVENT_DESTINATION */, "com.apple.finder")).toBe(
        1,
      );
      expect(sandboxCheck(pid, "ipc-posix-shm-read-data", 0)).toBe(1);
      expect(sandboxCheck(pid, "file-read-data", 1 /* PATH */, join(cwd, "private.txt"))).toBe(1);

      const output = server.args[server.args.indexOf("--output-dir") + 1];
      if (!output) throw new Error("missing browser output directory");
      const allowed = join(output, "allowed.png");
      const shot = await call("browser_take_screenshot", { filename: allowed, type: "png" });
      expect(shot.isError, JSON.stringify(shot)).not.toBe(true);
      expect(readFileSync(allowed).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      symlinkSync(cwd, join(output, "checkout-link"));
      for (const name of ["new.png", "existing.png", "checkout-link/linked.png"]) {
        const target = join(cwd, name.replace("checkout-link/", ""));
        if (name === "existing.png") writeFileSync(target, "unchanged");
        const filename = name.startsWith("checkout-link/") ? join(output, name) : target;
        const result = await call("browser_take_screenshot", { filename, type: "png" });
        expect(result.isError, name).toBe(true);
        if (name === "existing.png") expect(readFileSync(target, "utf8")).toBe("unchanged");
        else expect(existsSync(target), name).toBe(false);
      }

      // Seatbelt refuses the connection (EPERM); an unconfined browser would follow or time out.
      for (const path of ["/redirect", "/external"]) {
        const redirect = await call("browser_navigate", { url: `${spec.browser.previewUrl}${path}` });
        expect(redirect.isError, path).toBe(true);
        expect(JSON.stringify(redirect), path).toContain("net::ERR_ACCESS_DENIED");
      }
      // The boundary is the preview's socket, not its web origin: the renamed request may reach the
      // preview itself, but nothing else (checked with the other listeners below).
      await call("browser_navigate", { url: `${spec.browser.previewUrl}/rename` });
      await call("browser_navigate", { url: `file://${join(cwd, "private.txt")}` });
      expect(JSON.stringify(await call("browser_snapshot"))).not.toContain("private probe");
      await call("browser_navigate", { url: `${spec.browser.previewUrl}/download` });
      for (let i = 0; i < 50 && !existsSync(join(output, "d.txt")); i++) await Bun.sleep(100);
      expect(readFileSync(join(output, "d.txt"), "utf8")).toBe("download");
      expect(readdirSync(cwd).sort()).toEqual(["existing.png", "private.txt"]);
      // WebSocket, beacon, fetch and redirect attempts never reached another port or ::1.
      expect(escaped).toEqual([]);
    } finally {
      if (transport) {
        await client
          .callTool({ name: "browser_close", arguments: {} }, undefined, { timeout: 5_000 })
          .catch(() => {});
        await client.close();
        await transport.close();
      }
      preview.stop(true);
      other.stop(true);
      sibling6.stop(true);
      rmSync(scratchParent(scratch), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
