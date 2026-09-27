import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApplicationCommandDataResolvable,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type Client,
  Events,
} from "discord.js";
import type { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { CreateRunRequest, Run } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import {
  type DiscordCommand,
  type DiscordMessage,
  type DiscordPort,
  GatewayDiscordPort,
  mountDiscord,
} from "../src/integrations/discord.ts";
import { chatFixture, proposalFields } from "./chat-support.ts";

class FakePort implements DiscordPort {
  onCommand: ((command: DiscordCommand) => Promise<void>) | null = null;
  onMessage: ((message: DiscordMessage) => Promise<void>) | null = null;
  registrations: string[] = [];
  commandNames: string[] = [];
  definitions: readonly ApplicationCommandDataResolvable[] = [];
  posts: { channel: string; content: string; embed?: { title: string; description: string } }[] = [];
  threadNames: string[] = [];
  threadDelay: Promise<void> | null = null;
  sendAttempts: { channel: string; content: string; embed?: { title: string; description: string } }[] = [];
  failFirstSummary = false;
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
    this.definitions = definitions;
    this.commandNames = definitions.map((definition) => ("name" in definition ? definition.name : ""));
  }
  async createThread(_channel: string, name: string): Promise<string> {
    this.threadNames.push(name);
    if (this.threadDelay) await this.threadDelay;
    if (this.failThread) throw new Error("thread unavailable");
    return "thread-1";
  }
  async sendMessage(
    channel: string,
    content: string,
    embed?: { title: string; description: string },
  ): Promise<void> {
    this.sendAttempts.push({ channel, content, ...(embed ? { embed } : {}) });
    if (embed && this.failFirstSummary) {
      this.failFirstSummary = false;
      throw new Error("summary send failed");
    }
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

test("gateway client and shard errors warn and later messages still arrive", async () => {
  const emitter = Object.assign(new EventEmitter(), {
    login: async () => "token",
    isReady: () => true,
    destroy: () => {},
  });
  const client = emitter as unknown as Client;
  const gateway = new GatewayDiscordPort("token", {
    client,
    onWarning: (message) => {
      store.addEvent({ runId: "integration:discord", type: "log", level: "warn", message });
    },
  });
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  const messages: DiscordMessage[] = [];
  try {
    await gateway.start(
      async () => {},
      async (message) => {
        messages.push(message);
      },
    );
    expect(() => client.emit(Events.Error, new Error("socket lost"))).not.toThrow();
    expect(() => client.emit(Events.ShardError, new Error("gateway lost"), 3)).not.toThrow();
    emitter.emit(Events.MessageCreate, {
      id: "message-1",
      guildId: "guild",
      channelId: "channel",
      author: { id: "owner", bot: false },
      content: "still connected",
    });
    await Bun.sleep(0);
    expect(warnings.mock.calls).toEqual([
      ["[discord] client error: socket lost"],
      ["[discord] shard 3 error: gateway lost"],
    ]);
    expect(store.listEvents("integration:discord")).toMatchObject([
      { level: "warn", message: "client error: socket lost" },
      { level: "warn", message: "shard 3 error: gateway lost" },
    ]);
    expect(messages).toMatchObject([{ content: "still connected" }]);
  } finally {
    warnings.mockRestore();
    await gateway.stop();
  }
});

test("registers guild commands and owner gate protects all commands", async () => {
  const mounted = mountDiscord(factory, port);
  await Bun.sleep(0);
  expect(port.registrations).toEqual(["guild"]);
  expect(port.commandNames).toEqual(["build", "runs", "show", "cancel"]);
  expect(port.commandNames).not.toContain("run");
  expect(port.definitions.find((definition) => "name" in definition && definition.name === "show")).toEqual({
    name: "show",
    description: "Show a run",
    type: ApplicationCommandType.ChatInput,
    options: [
      { name: "id", description: "Run ID", type: ApplicationCommandOptionType.String, required: true },
    ],
  });
  for (const name of ["build", "runs", "show", "cancel"]) {
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

test("stage and question events during thread creation reach the new thread once", async () => {
  const mounted = mountDiscord(factory, port);
  let releaseThread: (() => void) | undefined;
  port.threadDelay = new Promise<void>((resolve) => {
    releaseThread = resolve;
  });
  const building = command("build", { repo: "local/test", prompt: "early events" });
  await Bun.sleep(0);
  const run = store.listRuns()[0];
  if (!run) throw new Error("run missing");
  expect(store.getRun(run.id)?.sourceRef?.threadId).toBeUndefined();
  store.startStage(run.id, "prepare");
  store.askQuestion(run.id, "Early question?");
  releaseThread?.();
  await building;
  await Bun.sleep(0);
  expect(port.posts.filter((post) => post.content === "Stage: prepare")).toHaveLength(1);
  expect(port.posts.filter((post) => post.content === "Question: Early question?")).toHaveLength(1);
  await mounted.stop();
});

test("failed terminal summary send retries on a later terminal update", async () => {
  const mounted = mountDiscord(factory, port);
  const run = await build();
  port.failFirstSummary = true;
  store.updateRun(run.id, { status: "succeeded" });
  await Bun.sleep(0);
  store.updateRun(run.id, { title: "Updated title" });
  await Bun.sleep(0);
  expect(port.sendAttempts.filter((post) => post.embed)).toHaveLength(2);
  expect(port.posts.filter((post) => post.embed)).toHaveLength(1);
  store.updateRun(run.id, { title: "Again" });
  await Bun.sleep(0);
  expect(port.posts.filter((post) => post.embed)).toHaveLength(1);
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
  expect((await command("cancel", { id: run.id }))[0]?.content).toContain("Cancellation requested");
  expect((await command("cancel", { id: run.id }))[0]?.content).toContain("already");
  expect(cancellations).toEqual([run.id]);
  await mounted.stop();
});

test("show reports run details and unknown IDs without handling the old run command", async () => {
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
  expect(await command("run", { id: run.id })).toEqual([]);
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

test("authorized mentions share the concierge, display complete edited proposals and create one threaded run", async () => {
  const f = chatFixture();
  const cfg = f.factory.cfg;
  cfg.secrets = { DISCORD_BOT_TOKEN: "token", DISCORD_APP_ID: "app", DISCORD_GUILD_ID: "guild" };
  cfg.discordOwnerId = "owner";
  cfg.discordChannelId = "channel";
  const mounted = mountDiscord(f.factory, port);
  const conversation = "discord:guild:channel:owner";
  const mention = (content: string, id: string, overrides: Partial<DiscordMessage> = {}) =>
    port.onMessage?.({
      id,
      guildId: "guild",
      mentioned: true,
      channelId: "channel",
      userId: "owner",
      bot: false,
      content,
      ...overrides,
    });
  try {
    await Bun.sleep(0);
    for (const override of [
      { bot: true },
      { userId: "stranger" },
      { channelId: "unrelated" },
      { guildId: "foreign" },
      { guildId: null },
      { mentioned: false },
    ])
      await mention("build", "ignored", override);
    expect(f.specs).toHaveLength(0);
    const longPrompt = "all proposal details ".repeat(250);
    f.action({ type: "propose_run", ...proposalFields, prompt: longPrompt });
    await Promise.all([mention("build", "request-1"), mention("build", "request-1")]);
    expect(f.specs).toHaveLength(1);
    expect(f.factory.store.listRuns()).toHaveLength(0);
    let proposal = f.factory.concierge.history(conversation).proposals.at(-1);
    if (!proposal) throw new Error("missing proposal");
    await Bun.sleep(0);
    const proposalPosts = port.posts.filter((p) => p.channel === "channel");
    expect(proposalPosts.every((p) => p.content.length <= 2000)).toBe(true);
    const details = proposalPosts.map((p) => p.content).join("");
    expect(proposal.prompt).toBe(longPrompt.trim());
    expect(details).toContain(proposal.prompt);
    expect(details).toContain(`confirm ${proposal.id}`);
    expect(details).toContain("Profile: auto");
    expect(details).toContain("Repo: local/test");
    expect(details).toContain(`Title: ${proposalFields.title}`);
    const oldId = proposal.id;
    const edited = { ...proposalFields, title: "Discord revised", profile: "deep" };
    await mention(`edit ${oldId} ${JSON.stringify(edited)}`, "edit-1");
    const messageCount = f.factory.concierge.history(conversation).messages.length;
    await mention(`edit ${oldId} ${JSON.stringify(edited)}`, "edit-1");
    expect(f.factory.concierge.history(conversation).messages).toHaveLength(messageCount);
    proposal = f.factory.concierge.history(conversation).proposals.at(-1);
    if (!proposal) throw new Error("missing revised proposal");
    expect(proposal.id).not.toBe(oldId);
    expect(proposal.state).toBe("pending");
    await mention(`confirm ${oldId}`, "obsolete-confirm");
    expect(f.factory.store.listRuns()).toHaveLength(0);
    f.action({ type: "create_run", proposalId: proposal.id });
    await mention("yes I confirm", "ambiguous");
    expect(f.factory.store.listRuns()).toHaveLength(0);
    await Promise.all([
      mention(`confirm ${proposal.id}`, "confirm-1"),
      mention(`confirm ${proposal.id}`, "confirm-1"),
      mention(`confirm ${proposal.id}`, "confirm-2"),
    ]);
    const runs = f.factory.store.listRuns();
    expect(runs).toHaveLength(1);
    const run = runs[0];
    if (!run) throw new Error("missing run");
    expect(run).toMatchObject({
      title: "Discord revised",
      profile: "deep",
      source: "discord",
      requestedBy: "owner",
      sourceRef: {
        kind: "discord",
        conversationId: conversation,
        proposalId: proposal.id,
        threadId: "thread-1",
      },
    });
    expect(port.threadNames).toHaveLength(1);
    expect(port.posts.some((p) => p.content.includes(`/runs/${run.id}`))).toBe(true);
    const question = f.factory.store.askQuestion(run.id, "Which color?");
    f.action({ type: "status", target: run.id });
    await mention("status", "thread-status", { channelId: "thread-1" });
    expect(f.factory.store.getQuestion(question.id)?.answer).toBeNull();
    await mention("blue", "thread-answer", { channelId: "thread-1", mentioned: false });
    expect(f.factory.store.getQuestion(question.id)?.answer).toBe("blue");
    f.factory.store.startStage(run.id, "implement");
    f.factory.store.updateRun(run.id, { status: "succeeded" });
    await Bun.sleep(0);
    expect(port.posts.some((p) => p.channel === "thread-1" && p.content === "Stage: implement")).toBe(true);
    expect(
      port.posts.some((p) => p.channel === "thread-1" && p.embed?.description.includes("succeeded")),
    ).toBe(true);
    expect(f.factory.concierge.history("one").messages).toHaveLength(0);
  } finally {
    await mounted.stop();
    f.close();
  }
});
