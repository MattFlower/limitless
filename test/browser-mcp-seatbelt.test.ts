import { expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { browserCache, browserMcp } from "../src/harness/browser-mcp.ts";
import { agentEnv, runProcess } from "../src/util/proc.ts";
import { browserSpec } from "./browser-mcp-support.ts";
import { seatbeltSkip } from "./confinement.ts";
import { test } from "./read-policy-support.ts";

// Requires operator provisioning; never substitute the repository's Playwright or download a browser.
test.skipIf(seatbeltSkip !== null)(
  `pinned MCP browser confines reads, redirects, fetches and screenshot filenames ${seatbeltSkip ?? ""}`,
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "browser-seatbelt-")));
    const cwd = join(root, "checkout"),
      scratch = join(root, "scratch");
    mkdirSync(cwd);
    mkdirSync(scratch);
    const escaped: string[] = [];
    const other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        escaped.push(new URL(request.url).pathname);
        return new Response("escaped", { headers: { "Access-Control-Allow-Origin": "*" } });
      },
    });
    const preview = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/redirect") return Response.redirect(`http://127.0.0.1:${other.port}/redirect-target`);
        if (path === "/own") return new Response("own-fetch-ok");
        return new Response(
          `<body>allowed-preview <span id="result"></span><script>
          fetch('/own').then(r => r.text()).then(async own => {
            let status;
            try { await fetch('http://127.0.0.1:${other.port}/fetch-target'); status = 'fetch-escaped'; }
            catch { status = 'fetch-blocked'; }
            document.getElementById('result').textContent = own + ' ' + status;
          });
        </script></body>`,
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });
    const client = new Client({ name: "confinement-probe", version: "1" });
    let transport: StdioClientTransport | undefined;
    const call = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }, undefined, { timeout: 15_000 });
    try {
      const cache = browserCache(process.env.LIMITLESS_HOME ?? join(homedir(), ".limitless"));
      const spec = browserSpec(cwd, scratch, cache);
      spec.browser = { cacheDir: cache, previewUrl: `http://127.0.0.1:${preview.port}` };
      // Exactly the production launch configuration; the gaps are cleared because this probe is
      // the evidence that decides whether CONFINEMENT_GAPS may drop them.
      const server = browserMcp(spec, "codex", []);
      if (!server)
        throw new Error("Pinned browser unavailable; provision it with scripts/provision-browser-mcp.ts");
      const directory = server.env.HOME;
      if (!directory) throw new Error("missing browser directory");
      // Exercise the production profile with its validated Node runtime, including APFS aliases.
      const read = (path: string) =>
        runProcess({
          cmd: [
            server.command,
            ...server.args.slice(0, 3),
            "-e",
            `
          try { process.stdout.write(require('node:fs').readFileSync(process.argv[1])); }
          catch (error) { process.exit(['EPERM', 'EACCES'].includes(error.code) ? 77 : 78); }
        `,
            "--",
            path,
          ],
          cwd: directory,
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
      transport = new StdioClientTransport({ ...server, cwd, stderr: "pipe" });
      transport.stderr?.on("data", () => {});
      await client.connect(transport, { timeout: 15_000 });
      const navigation = await call("browser_navigate", { url: spec.browser.previewUrl });
      expect(navigation.isError).not.toBe(true);
      expect(JSON.stringify(navigation)).toContain("allowed-preview");
      const fetched = await call("browser_wait_for", { text: "own-fetch-ok fetch-blocked" });
      expect(fetched.isError).not.toBe(true);
      expect(escaped).toEqual([]);

      const output = server.args[server.args.indexOf("--output-dir") + 1];
      if (!output) throw new Error("missing browser output directory");
      const allowed = join(output, "allowed.png");
      expect((await call("browser_take_screenshot", { filename: allowed, type: "png" })).isError).not.toBe(
        true,
      );
      expect(readFileSync(allowed).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      for (const existing of [false, true]) {
        const denied = join(cwd, existing ? "existing.png" : "new.png");
        if (existing) writeFileSync(denied, "unchanged");
        const result = await call("browser_take_screenshot", { filename: denied, type: "png" });
        expect(result.isError).toBe(true);
        if (existing) expect(readFileSync(denied, "utf8")).toBe("unchanged");
        else expect(existsSync(denied)).toBe(false);
      }
      const redirect = await call("browser_navigate", { url: `${spec.browser.previewUrl}/redirect` });
      expect(redirect.isError).toBe(true);
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
      rmSync(root, { recursive: true, force: true });
    }
  },
  90_000,
);
