import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApplicationCommandDataResolvable,
  ApplicationCommandOptionType,
  ApplicationCommandType,
} from "discord.js";
import type { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { CreateRunRequest, Run } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import {
  DISCORD_COMMANDS,
  type DiscordCommand,
  type DiscordMessage,
  type DiscordPort,
  mountDiscord,
} from "../src/integrations/discord.ts";

class FakePort implements DiscordPort {
  onCommand: ((command: DiscordCommand) => Promise<void>) | null = null;
  definitions: readonly ApplicationCommandDataResolvable[] = [];
  posts: { channel: string; content: string }[] = [];
  async start(
    command: (command: DiscordCommand) => Promise<void>,
    _message: (message: DiscordMessage) => Promise<void>,
  ): Promise<void> {
    this.onCommand = command;
  }
  async register(_guild: string, definitions: readonly ApplicationCommandDataResolvable[]): Promise<void> {
    this.definitions = definitions;
  }
  async createThread(): Promise<string> {
    return "thread-1";
  }
  async sendMessage(channel: string, content: string): Promise<void> {
    this.posts.push({ channel, content });
  }
  async stop(): Promise<void> {}
}

let dir: string;
let store: Store;
let port: FakePort;
let factory: Factory;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-hidden-show-"));
  const cfg = loadConfig({ home: join(dir, "home"), configDir: join(dir, "config") });
  cfg.secrets.DISCORD_BOT_TOKEN = "token";
  cfg.secrets.DISCORD_APP_ID = "app";
  cfg.secrets.DISCORD_GUILD_ID = "guild";
  cfg.discordOwnerId = "owner";
  cfg.discordChannelId = "channel";
  store = new Store(cfg.paths.db);
  store.upsertRepo({
    slug: "local/test",
    kind: "local",
    url: null,
    localPath: dir,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  port = new FakePort();
  factory = {
    cfg,
    store,
    createRun: async (request: CreateRunRequest) => {
      const repo = store.getRepoBySlug("local/test");
      if (!repo) throw new Error("repo missing");
      return store.createRun(repo, request);
    },
    answer: () => [],
    cancelRun: (id: string) => {
      store.updateRun(id, { status: "cancelled" });
      return true;
    },
  } as unknown as Factory;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function command(name: string, options: Record<string, string | undefined> = {}, userId = "owner") {
  const replies: { content: string; ephemeral: boolean | undefined }[] = [];
  await port.onCommand?.({
    name,
    options,
    userId,
    defer: async () => {},
    reply: async (content, ephemeral) => {
      replies.push({ content, ephemeral });
    },
  });
  await Bun.sleep(0);
  return replies;
}

async function build(): Promise<Run> {
  await command("build", { repo: "local/test", prompt: "Make a very useful change" });
  const run = store.listRuns()[0];
  if (!run) throw new Error("run missing");
  return run;
}

const names = (definitions: readonly ApplicationCommandDataResolvable[]) =>
  definitions.map((definition) => ("name" in definition ? definition.name : ""));

test("registers /show in place of /run with the same required id option", async () => {
  const mounted = mountDiscord(factory, port);
  await Bun.sleep(0);
  expect(names(port.definitions)).toEqual(["build", "runs", "show", "cancel"]);
  expect(names(DISCORD_COMMANDS)).not.toContain("run");
  const show = port.definitions.find((definition) => "name" in definition && definition.name === "show");
  expect(show).toMatchObject({
    name: "show",
    type: ApplicationCommandType.ChatInput,
    options: [{ name: "id", type: ApplicationCommandOptionType.String, required: true }],
  });
  await mounted.stop();
});

test("/show replies with the run details /run used to give", async () => {
  const mounted = mountDiscord(factory, port);
  const run = await build();
  store.askQuestion(run.id, "Choose?");
  store.updateRun(run.id, {
    status: "running",
    stage: "implement",
    title: "Updated title",
    prUrl: "https://example.test/pr/1",
  });
  expect((await command("show", { id: run.id }))[0]?.content).toBe(
    [
      `${run.id} · running · local/test`,
      "Stage: implement",
      "Title: Updated title",
      "Open questions: 1",
      "https://example.test/pr/1",
      `${factory.cfg.uiUrl}/runs/${run.id}`,
    ].join("\n"),
  );
  expect((await command("show", { id: "missing" }))[0]?.content).toBe("Unknown run ID.");
  await mounted.stop();
});

test("/show stays owner-only", async () => {
  const mounted = mountDiscord(factory, port);
  const run = await build();
  const replies = await command("show", { id: run.id }, "intruder");
  expect(replies[0]?.ephemeral).toBe(true);
  expect(replies[0]?.content).toContain("owner");
  expect(replies.some((reply) => reply.content.includes("Stage:"))).toBe(false);
  await mounted.stop();
});

test("the old /run name no longer shows a run", async () => {
  const mounted = mountDiscord(factory, port);
  const run = await build();
  const replies = await command("run", { id: run.id });
  expect(replies.some((reply) => reply.content.includes(run.title))).toBe(false);
  expect(replies.some((reply) => reply.content.includes("Stage:"))).toBe(false);
  await mounted.stop();
});
