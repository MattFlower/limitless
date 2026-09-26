import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory, type FactoryOptions } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { ChatAction, ChatProposalFields } from "../src/core/types.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import type { Policy } from "../src/router/catalog.ts";

export const proposalFields: ChatProposalFields = {
  repo: "local/test",
  prompt: "Build a useful feature",
  profile: "auto",
  title: "Useful feature",
};

export function chatFixture(opts: { openaiBaseUrl?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "limitless-chat-"));
  const cfg = loadConfig({ home, configDir: join(home, "config") });
  cfg.secrets = {};
  const specs: AgentSpec[] = [];
  const harnessCalls: string[] = [];
  const respond = (name: string) =>
    fakeHarness((spec) => {
      harnessCalls.push(name);
      specs.push(spec);
      return reply;
    });
  let reply: FakeReply = { structured: { action: { type: "reply", text: "Hello" } } };
  const options: FactoryOptions = {
    harnesses: { fake: respond("fake"), llm: respond("llm") },
    providers: [
      {
        id: "fake",
        label: "Fake",
        harness: "fake" as const,
        billing: "subscription" as const,
        maxConcurrent: 1,
        ...(opts.openaiBaseUrl ? { openaiBaseUrl: opts.openaiBaseUrl } : {}),
      },
    ],
    models: [
      {
        id: "fake/chat",
        provider: "fake",
        model: "chat",
        vendor: "other" as const,
        tier: 1,
        price: { input: 1, output: 1 },
      },
    ],
    policy: { chat: { default: ["fake/chat"] } } as Policy,
  };
  let factory = new Factory(cfg, options);
  factory.store.upsertRepo({
    slug: "local/test",
    kind: "local",
    localPath: home,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  return {
    get factory() {
      return factory;
    },
    home,
    specs,
    harnessCalls,
    action(action: ChatAction | unknown) {
      reply = { structured: { action } };
    },
    reply(value: FakeReply) {
      reply = value;
    },
    reopen() {
      factory.store.close();
      factory = new Factory(cfg, options);
      return factory;
    },
    close() {
      factory.store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
