import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplicationCommandDataResolvable } from "discord.js";
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
  onMessage: ((message: DiscordMessage) => Promise<void>) | null = null;
  registrations: string[] = [];
  commandNames: string[] = [];
  posts: { channel: string; content: string; embed?: { title: string; description: string } }[] = [];
  threadNames: string[] = [];
  stopped = false;
  failStart = false;
  failThread = false;
  async start(
    command: (command: DiscordCommand) => Promise<void>,
    message: (message: DiscordMessage) => Promise<void>,
  ): Promise<void> {
    this.onCommand = command;
    this.onMessage = message;
    if (this.failStart) throw new Error("unreachable");
  }
  async register(guild: string, definitions: readonly ApplicationCommandDataResolvable[]): Promise<void> {
    this.registrations.push(guild);
    this.commandNames = definitions.map((definition) => ("name" in definition ? definition.name : ""));
  }
  async createThread(_channel: string, name: string): Promise<string> {
    this.threadNames.push(name);
    if (this.failThread) throw new Error("thread unavailable");
    return "thread-1";
  }
  async sendMessage(
    channel: string,
    content: string,
    embed?: { title: string; description: string },
  ): Promise<void> {
    this.posts.push({ channel, content, ...(embed ? { embed } : {}) });
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
}

let dir: string;
let store: Store;
let port: FakePort;
let factory: Factory;
let requests: CreateRunRequest[];
let cancellations: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-discord-"));
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
  requests = [];
  cancellations = [];
  factory = {
    cfg,
    store,
    createRun: async (request: CreateRunRequest) => {
      requests.push(request);
      const repo = store.getRepoBySlug("local/test");
      if (!repo) throw new Error("repo missing");
      return store.createRun(repo, request);
    },
    answer: (id: string, answer: string, by: string) => {
      const open = store.listQuestions(id).filter((q) => q.answer === null);
      if (!open.length) throw new Error("no open questions on this run");
      return open.map((q) => store.answerQuestion(q.id, answer, by));
    },
    cancelRun: (id: string) => {
      cancellations.push(id);
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
  await command("build", { repo: "local/test", prompt: "Make a very useful change", profile: "deep" });
  const run = store.listRuns()[0];
  if (!run) throw new Error("run missing");
  return run;
}

test("missing settings disable Discord and startup failure does not stop the factory", async () => {
  factory.cfg.secrets.DISCORD_BOT_TOKEN = "";
  const disabled = mountDiscord(factory, port);
  expect(disabled.note).toContain("DISCORD_BOT_TOKEN");
  expect(port.onCommand).toBeNull();
  factory.cfg.secrets.DISCORD_BOT_TOKEN = "token";
  port.failStart = true;
  const mounted = mountDiscord(factory, port);
  await Bun.sleep(0);
  expect(mounted.note).toBe("Discord enabled");
  await mounted.stop();
  expect(port.stopped).toBe(true);
});

test("registers guild commands and owner gate protects all commands", async () => {
  const mounted = mountDiscord(factory, port);
  await Bun.sleep(0);
  expect(port.registrations).toEqual(["guild"]);
  expect(port.commandNames).toEqual(["build", "runs", "run", "cancel"]);
  await port.register("guild", DISCORD_COMMANDS);
  expect(port.commandNames).toEqual(["build", "runs", "run", "cancel"]);
  for (const name of ["build", "runs", "run", "cancel"]) {
    const replies = await command(name, { id: "secret", repo: "local/test", prompt: "hi" }, "intruder");
    expect(replies[0]?.ephemeral).toBe(true);
    expect(replies[0]?.content).toContain("owner");
  }
  expect(requests).toHaveLength(0);
  expect(cancellations).toHaveLength(0);
  await mounted.stop();
});

test("build maps the request and persists the thread; thread failure leaves the run", async () => {
  const mounted = mountDiscord(factory, port);
  const run = await build();
  expect(requests[0]).toMatchObject({
    repo: "local/test",
    prompt: "Make a very useful change",
    profile: "deep",
    source: "discord",
    requestedBy: "owner",
    sourceRef: { kind: "discord", channelId: "channel" },
  });
  expect(run.sourceRef).toMatchObject({ kind: "discord", channelId: "channel", threadId: "thread-1" });
  expect(port.threadNames[0]?.length).toBeLessThanOrEqual(100);
  port.failThread = true;
  const replies = await command("build", { repo: "local/test", prompt: "another" });
  expect(replies[0]?.content).toContain("/runs/");
  const failedRunId = replies[0]?.content.match(/Run (\S+) queued/)?.[1];
  expect(store.getRun(failedRunId ?? "")?.sourceRef?.threadId).toBeUndefined();
  await mounted.stop();
});

test("stage and question updates route to the recorded thread, with bounded progress and one final embed", async () => {
  const mounted = mountDiscord(factory, port);
  const run = await build();
  const other = store.createRun(
    store.getRepoBySlug("local/test") as NonNullable<ReturnType<Store["getRepoBySlug"]>>,
    { repo: "local/test", prompt: "other", source: "cli" },
  );
  for (let i = 0; i < 20; i++) store.startStage(run.id, "implement", i);
  store.startStage(other.id, "prepare");
  store.askQuestion(run.id, "Which color?");
  store.updateRun(run.id, { status: "succeeded", prUrl: "https://example.test/pr/1" });
  store.updateRun(run.id, { title: "Updated title" });
  await Bun.sleep(0);
  const posts = port.posts.filter((post) => post.channel === "thread-1");
  expect(posts.filter((post) => post.content.startsWith("Stage:"))).toHaveLength(1);
  expect(posts.some((post) => post.content.includes("Which color?"))).toBe(true);
  expect(posts.filter((post) => post.embed)).toHaveLength(1);
  expect(posts.find((post) => post.embed)?.embed?.description).toContain("https://example.test/pr/1");
  expect(posts.find((post) => post.embed)?.embed?.description).toContain("subscription-equivalent");
  expect(port.posts.some((post) => post.channel === "channel")).toBe(false);
  await mounted.stop();
});

test("thread replies answer open questions only for the owner; listing and cancel handle edge cases", async () => {
  const mounted = mountDiscord(factory, port);
  const run = await build();
  const question = store.askQuestion(run.id, "Choose?");
  await port.onMessage?.({ channelId: "thread-1", userId: "intruder", content: "no", bot: false });
  await port.onMessage?.({ channelId: "thread-1", userId: "owner", content: "no", bot: true });
  expect(store.getQuestion(question.id)?.answer).toBeNull();
  await port.onMessage?.({ channelId: "thread-1", userId: "owner", content: "yes", bot: false });
  expect(store.getQuestion(question.id)?.answeredBy).toBe("discord:owner");
  await port.onMessage?.({ channelId: "thread-1", userId: "owner", content: "again", bot: false });
  await Bun.sleep(0);
  expect(port.posts.some((post) => post.content.includes("No question is open"))).toBe(true);
  expect((await command("runs", { status: "bad" }))[0]?.content).toContain("Invalid status");
  expect((await command("runs"))[0]?.content).toContain(run.id);
  expect((await command("run", { id: "missing" }))[0]?.content).toContain("Unknown");
  expect((await command("run", { id: run.id }))[0]?.content).toContain(run.title);
  expect((await command("cancel", { id: run.id }))[0]?.content).toContain("Cancellation requested");
  expect((await command("cancel", { id: run.id }))[0]?.content).toContain("already");
  expect(cancellations).toEqual([run.id]);
  await mounted.stop();
});

test("notify_all sends only non-Discord completion notices when enabled", async () => {
  factory.cfg.discordNotifyAll = true;
  const mounted = mountDiscord(factory, port);
  const repo = store.getRepoBySlug("local/test");
  if (!repo) throw new Error("repo missing");
  const run = store.createRun(repo, { repo: "local/test", prompt: "other", source: "cli" });
  store.updateRun(run.id, { status: "failed" });
  store.updateRun(run.id, { title: "still failed" });
  await Bun.sleep(0);
  expect(port.posts.filter((post) => post.channel === "channel")).toHaveLength(1);
  await mounted.stop();
});

test("persisted thread routing survives remount and notify_all defaults off", async () => {
  const first = mountDiscord(factory, port);
  const run = await build();
  await first.stop();
  port = new FakePort();
  const second = mountDiscord(factory, port);
  store.askQuestion(run.id, "After restart?");
  const repo = store.getRepoBySlug("local/test");
  if (!repo) throw new Error("repo missing");
  const other = store.createRun(repo, { repo: "local/test", prompt: "other", source: "cli" });
  store.updateRun(other.id, { status: "succeeded" });
  await Bun.sleep(0);
  expect(
    port.posts.some((post) => post.channel === "thread-1" && post.content.includes("After restart?")),
  ).toBe(true);
  expect(port.posts.some((post) => post.channel === "channel")).toBe(false);
  await second.stop();
});

test("config parses Discord channel and notify_all", () => {
  const configDir = join(dir, "parsed-config");
  mkdirSync(configDir);
  writeFileSync(
    join(configDir, "config.toml"),
    '[owners]\ndiscord = "owner"\n[discord]\nchannel_id = "channel"\nnotify_all = true\n',
  );
  const cfg = loadConfig({ home: join(dir, "parsed-home"), configDir });
  expect(cfg.discordOwnerId).toBe("owner");
  expect(cfg.discordChannelId).toBe("channel");
  expect(cfg.discordNotifyAll).toBe(true);
});
