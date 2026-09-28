import { expect, test } from "bun:test";
import { installationUnits } from "../src/cli/service.ts";

test("installation selects only explicitly requested rollback and tunnel agents", () => {
  for (const mtplx of [undefined, false, true])
    for (const tunnel of [null, "/tunnel.yml"]) {
      const units = installationUnits({ mtplx }, tunnel);
      expect(units.map(([label]) => label)).toEqual([
        "cc.mattflower.limitless",
        ...(mtplx ? ["cc.mattflower.limitless-mtplx"] : []),
        ...(tunnel ? ["cc.mattflower.limitless-tunnel"] : []),
      ]);
      expect(units[0]?.[1]).toContain("serve");
      if (mtplx) expect(units[1]?.[1]).toContain("mtplx-local");
    }
});

test("service CLI dispatches opt-in mtplx and advertises the new flag", async () => {
  for (const flags of [[], ["--mtplx", "--tunnel"], ["--help"]]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        "./test/fixtures/service-cli-preload.ts",
        "src/cli/main.ts",
        "service",
        "install",
        ...flags,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    if (flags.includes("--help")) {
      expect(output).toContain("[--mtplx]");
      expect(output).not.toContain("--no-mtplx");
    } else expect(output).toContain(JSON.stringify({ tunnel: flags.length > 0, mtplx: flags.length > 0 }));
  }
});
