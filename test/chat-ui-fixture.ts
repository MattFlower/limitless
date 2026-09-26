// Run manually with `bun test/chat-ui-fixture.ts`; no scheduler, network providers or delivery.
import { startHttp } from "../src/server/http.ts";
import { chatFixture, proposalFields } from "./chat-support.ts";

if (import.meta.main) {
  const fixture = chatFixture();
  fixture.factory.cfg.port = 17400;
  fixture.factory.cfg.uiUrl = "http://127.0.0.1:17400";
  fixture.factory.deps.harnesses.fake = (await import("../src/harness/fake.ts")).fakeHarness((spec) => {
    const data = JSON.parse(spec.prompt.slice(spec.prompt.indexOf("\n") + 1)) as {
      history: { content: string }[];
    };
    return data.history.at(-1)?.content === "fail"
      ? { structured: { action: { type: "invalid" } }, delayMs: 500 }
      : { structured: { action: { type: "propose_run", ...proposalFields } }, delayMs: 500 };
  });
  const ui = (await import("../ui/index.html")).default;
  const server = startHttp(fixture.factory, { ui });
  console.log(`Fake-only chat UI: ${server.url}chat`);
  const stop = () => {
    server.stop(true);
    fixture.close();
    process.exit();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
