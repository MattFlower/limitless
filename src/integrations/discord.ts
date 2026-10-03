import {
  type ApplicationCommandDataResolvable,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
} from "discord.js";
import type { Factory } from "../app.ts";
import { ChatRequestSchema } from "../concierge.ts";
import type { Config } from "../config.ts";
import { type Profile, type Run, type RunStatus, TERMINAL_STATUSES } from "../core/types.ts";

export interface DiscordCommand {
  name: string;
  userId: string;
  options: Record<string, string | undefined>;
  defer: () => Promise<void>;
  reply: (content: string, ephemeral?: boolean) => Promise<void>;
}

export interface DiscordMessage {
  id?: string;
  guildId?: string | null;
  mentioned?: boolean;
  channelId: string;
  userId: string;
  content: string;
  bot: boolean;
}

export interface DiscordPort {
  start(
    onCommand: (command: DiscordCommand) => Promise<void>,
    onMessage: (message: DiscordMessage) => Promise<void>,
  ): Promise<void>;
  register(guildId: string, definitions: readonly ApplicationCommandDataResolvable[]): Promise<void>;
  createThread(channelId: string, name: string): Promise<string>;
  sendMessage(
    channelId: string,
    content: string,
    embed?: { title: string; description: string },
  ): Promise<void>;
  stop(): Promise<void>;
}

export const DISCORD_COMMANDS: readonly ApplicationCommandDataResolvable[] = [
  {
    name: "build",
    description: "Start a run",
    type: ApplicationCommandType.ChatInput,
    options: [
      { name: "repo", description: "Repository", type: ApplicationCommandOptionType.String, required: true },
      {
        name: "prompt",
        description: "What to build",
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: "profile",
        description: "Run profile",
        type: ApplicationCommandOptionType.String,
        choices: ["auto", "quick", "standard", "deep"].map((name) => ({ name, value: name })),
      },
    ],
  },
  {
    name: "runs",
    description: "List recent runs",
    type: ApplicationCommandType.ChatInput,
    options: [{ name: "status", description: "Filter by status", type: ApplicationCommandOptionType.String }],
  },
  {
    name: "show",
    description: "Show a run",
    type: ApplicationCommandType.ChatInput,
    options: [
      { name: "id", description: "Run ID", type: ApplicationCommandOptionType.String, required: true },
    ],
  },
  {
    name: "cancel",
    description: "Cancel a run",
    type: ApplicationCommandType.ChatInput,
    options: [
      { name: "id", description: "Run ID", type: ApplicationCommandOptionType.String, required: true },
    ],
  },
];

/** Gateway transport; all discord.js calls stay here. */
export class GatewayDiscordPort implements DiscordPort {
  private readonly client: Client;

  constructor(
    private readonly token: string,
    options: { client?: Client; onWarning?: (message: string) => void } = {},
  ) {
    this.onWarning = options.onWarning;
    this.client =
      options.client ??
      new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
      });
  }

  private readonly onWarning: ((message: string) => void) | undefined;

  private warn(context: string, error: Error): void {
    const message = `${context}: ${error.message}`;
    console.warn(`[discord] ${message}`);
    try {
      this.onWarning?.(message);
    } catch (logError) {
      console.error("[discord] warning persistence:", logError);
    }
  }

  async start(
    onCommand: (command: DiscordCommand) => Promise<void>,
    onMessage: (message: DiscordMessage) => Promise<void>,
  ): Promise<void> {
    this.client.on(Events.Error, (error) => this.warn("client error", error));
    this.client.on(Events.ShardError, (error, shardId) => this.warn(`shard ${shardId} error`, error));
    this.client.on("interactionCreate", (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      const command = interaction as ChatInputCommandInteraction;
      const options: Record<string, string | undefined> = {};
      for (const name of ["repo", "prompt", "profile", "status", "id"])
        options[name] = command.options.getString(name) ?? undefined;
      void onCommand({
        name: command.commandName,
        userId: command.user.id,
        options,
        defer: async () => {
          await command.deferReply({ ephemeral: true });
        },
        reply: async (content, ephemeral = true) => {
          if (command.deferred || command.replied)
            await command.editReply({ content: content.slice(0, 2000) });
          else await command.reply({ content: content.slice(0, 2000), ephemeral });
        },
      }).catch((error) => console.error("[discord] command:", error));
    });
    this.client.on("messageCreate", (message: Message) => {
      void onMessage({
        id: message.id,
        guildId: message.guildId,
        mentioned: this.client.user ? message.mentions.users.has(this.client.user.id) : false,
        channelId: message.channelId,
        userId: message.author.id,
        content: this.client.user
          ? message.content.replace(new RegExp(`<@!?${this.client.user.id}>`, "g"), "").trim()
          : message.content,
        bot: message.author.bot,
      }).catch((error) => console.error("[discord] message:", error));
    });
    await this.client.login(this.token);
    if (!this.client.isReady()) {
      await new Promise<void>((resolve) => this.client.once(Events.ClientReady, () => resolve()));
    }
  }

  async register(guildId: string, definitions: readonly ApplicationCommandDataResolvable[]): Promise<void> {
    if (!this.client.application) throw new Error("Discord application unavailable");
    await this.client.application.commands.set(definitions, guildId);
  }

  async createThread(channelId: string, name: string): Promise<string> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText)
      throw new Error("configured channel must be a guild text channel");
    const thread = await channel.threads.create({ name: name.slice(0, 100), type: ChannelType.PublicThread });
    return thread.id;
  }

  async sendMessage(
    channelId: string,
    content: string,
    embed?: { title: string; description: string },
  ): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel))
      throw new Error(`Discord channel ${channelId} is not writable`);
    await channel.send({
      content: content.slice(0, 2000),
      embeds: embed ? [embed] : [],
      allowedMentions: { parse: [] },
    });
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }
}

const validStatuses: RunStatus[] = ["queued", "running", "waiting_input", ...TERMINAL_STATUSES];
const profiles: Profile[] = ["auto", "quick", "standard", "deep"];

export function discordMissing(cfg: Config): string[] {
  return [
    !cfg.secrets.DISCORD_BOT_TOKEN && "DISCORD_BOT_TOKEN",
    !cfg.secrets.DISCORD_APP_ID && "DISCORD_APP_ID",
    !cfg.secrets.DISCORD_GUILD_ID && "DISCORD_GUILD_ID",
    !cfg.discordChannelId && "[discord] channel_id",
    !cfg.discordOwnerId && "[owners] discord",
  ].filter((value): value is string => typeof value === "string");
}

export class DiscordIntegration {
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  private readonly stageKeys = new Map<string, Set<string>>();
  private readonly progressCount = new Map<string, number>();
  private readonly lastProgressAt = new Map<string, number>();
  private readonly finalSent = new Set<string>();
  private readonly finalPending = new Set<string>();
  private readonly pendingThreadPosts = new Map<string, string[]>();
  private readonly noticeSent = new Set<string>();
  private readonly queues = new Map<string, Promise<boolean>>();
  private readonly mentionQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly factory: Factory,
    private readonly port: DiscordPort,
  ) {}

  start(): void {
    this.unsubscribe = this.factory.store.subscribe((msg) => {
      if (this.stopped) return;
      if (msg.kind === "alert" && msg.created && msg.alert) {
        const channel = this.factory.cfg.discordChannelId;
        if (channel) {
          const a = msg.alert;
          this.enqueue(
            channel,
            `Quota ${a.severity}: ${a.provider} · ${a.window} · ${a.utilization === null ? "utilization unknown" : `${(a.utilization * 100).toFixed(1)}% utilization`} · resets ${a.resetsAt === null ? "unknown" : new Date(a.resetsAt).toISOString()}. ${a.routing}`,
          );
        }
      } else if (msg.kind === "stage" && msg.stage.status === "running") {
        const run = this.factory.store.getRun(msg.stage.runId);
        if (!run) return;
        const key = `${msg.stage.name}:${msg.stage.round}`;
        const seen = this.stageKeys.get(run.id) ?? new Set<string>();
        const now = Date.now();
        if (
          seen.has(key) ||
          (this.progressCount.get(run.id) ?? 0) >= 8 ||
          now - (this.lastProgressAt.get(run.id) ?? 0) < 2_000
        )
          return;
        seen.add(key);
        this.stageKeys.set(run.id, seen);
        this.progressCount.set(run.id, (this.progressCount.get(run.id) ?? 0) + 1);
        this.lastProgressAt.set(run.id, now);
        this.toThread(run, `Stage: ${msg.stage.name}`);
      } else if (msg.kind === "question" && msg.question.answer === null) {
        const run = this.factory.store.getRun(msg.question.runId);
        if (run) this.toThread(run, `Question: ${msg.question.question.slice(0, 1850)}`);
      } else if (msg.kind === "run" && TERMINAL_STATUSES.includes(msg.run.status)) {
        const run = msg.run;
        const thread = this.threadId(run);
        if (thread && !this.finalSent.has(run.id) && !this.finalPending.has(run.id)) {
          this.finalPending.add(run.id);
          const url = this.runUrl(run.id);
          const description = [
            `Status: ${run.status}`,
            run.prUrl ? `PR: ${run.prUrl}` : null,
            `Cost: $${run.costUsd.toFixed(2)} real; $${run.costEquivUsd.toFixed(2)} subscription-equivalent`,
            `UI: ${url}`,
          ]
            .filter(Boolean)
            .join("\n");
          void this.enqueue(thread, "", { title: run.title.slice(0, 256), description }).then((sent) => {
            this.finalPending.delete(run.id);
            if (sent) this.finalSent.add(run.id);
          });
        } else if (
          run.source !== "discord" &&
          this.factory.cfg.discordNotifyAll &&
          !this.noticeSent.has(run.id)
        ) {
          this.noticeSent.add(run.id);
          const channel = this.factory.cfg.discordChannelId;
          if (channel)
            this.enqueue(channel, `${run.title.slice(0, 100)}: ${run.status} — ${this.runUrl(run.id)}`);
        }
      }
    });
    void this.port
      .start(
        (command) => this.command(command),
        (message) => this.message(message),
      )
      .then(() => this.port.register(this.factory.cfg.secrets.DISCORD_GUILD_ID ?? "", DISCORD_COMMANDS))
      .catch((error) => console.error("[discord] connection or registration:", error));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    await Promise.allSettled(this.queues.values());
    await this.port.stop();
  }

  private runUrl(id: string): string {
    return `${this.factory.cfg.uiUrl.replace(/\/$/, "")}/runs/${id}`;
  }
  private threadId(run: Run): string | null {
    return run.source === "discord" &&
      run.sourceRef?.kind === "discord" &&
      typeof run.sourceRef.threadId === "string"
      ? run.sourceRef.threadId
      : null;
  }
  private enqueue(
    channel: string,
    content: string,
    embed?: { title: string; description: string },
  ): Promise<boolean> {
    const previous = this.queues.get(channel) ?? Promise.resolve();
    const next = previous
      .then(() => this.port.sendMessage(channel, content, embed))
      .then(() => true)
      .catch((error) => {
        console.error("[discord] send:", error);
        return false;
      });
    this.queues.set(channel, next);
    void next.then(() => {
      if (this.queues.get(channel) === next) this.queues.delete(channel);
    });
    return next;
  }
  private toThread(run: Run, content: string): void {
    const thread = this.threadId(run);
    if (thread) this.enqueue(thread, content);
    else if (run.source === "discord") {
      const pending = this.pendingThreadPosts.get(run.id) ?? [];
      pending.push(content);
      this.pendingThreadPosts.set(run.id, pending);
    }
  }

  async command(command: DiscordCommand): Promise<void> {
    if (command.userId !== this.factory.cfg.discordOwnerId) {
      await command.reply("Only the configured owner can use Limitless commands.", true);
      return;
    }
    try {
      const { options } = command;
      if (command.name === "build") {
        const profile = options.profile ?? "auto";
        if (!profiles.includes(profile as Profile)) {
          await command.reply("Invalid profile.");
          return;
        }
        const channel = this.factory.cfg.discordChannelId;
        if (!channel) {
          await command.reply("Discord channel is not configured.");
          return;
        }
        await command.defer();
        const run = await this.factory.createRun({
          repo: options.repo ?? "",
          prompt: options.prompt ?? "",
          profile: profile as Profile,
          source: "discord",
          requestedBy: command.userId,
          sourceRef: { kind: "discord", channelId: channel },
        });
        await this.attachThread(run);
        await command.reply(`Run ${run.id} queued: ${this.runUrl(run.id)}`);
      } else if (command.name === "runs") {
        const status = options.status;
        if (status && !validStatuses.includes(status as RunStatus)) {
          await command.reply(`Invalid status: ${status}`);
          return;
        }
        const runs = this.factory.store.listRuns({
          ...(status ? { status: [status as RunStatus] } : {}),
          limit: 15,
        });
        await command.reply(
          runs.length
            ? runs
                .map((run) => `${run.id} · ${run.status} · ${run.repoSlug} · ${run.title}`)
                .join("\n")
                .slice(0, 1900)
            : "No runs found.",
        );
      } else if (command.name === "show" || command.name === "cancel") {
        const run = this.factory.store.getRun(options.id ?? "");
        if (!run) {
          await command.reply("Unknown run ID.");
          return;
        }
        if (command.name === "cancel") {
          if (TERMINAL_STATUSES.includes(run.status)) {
            await command.reply(`Run ${run.id} is already ${run.status}.`);
            return;
          }
          const cancelled = this.factory.cancelRun(run.id, `discord:${command.userId}`);
          await command.reply(
            cancelled ? `Cancellation requested for ${run.id}.` : `Run ${run.id} is already terminal.`,
          );
        } else {
          const questions = this.factory.store.listQuestions(run.id).filter((q) => q.answer === null);
          await command.reply(
            [
              `${run.id} · ${run.status} · ${run.repoSlug}`,
              `Stage: ${run.stage ?? "pending"}`,
              `Title: ${run.title}`,
              questions.length ? `Open questions: ${questions.length}` : null,
              run.prUrl,
              this.runUrl(run.id),
            ]
              .filter(Boolean)
              .join("\n")
              .slice(0, 1900),
          );
        }
      }
    } catch (error) {
      console.error("[discord] command:", error);
      await command
        .reply("Limitless could not complete that command.")
        .catch((replyError) => console.error("[discord] reply:", replyError));
    }
  }

  private async attachThread(run: Run): Promise<void> {
    if (this.threadId(this.factory.store.getRun(run.id) ?? run)) return;
    const channel = this.factory.cfg.discordChannelId;
    if (!channel) return;
    try {
      const threadId = await this.port.createThread(channel, run.title.slice(0, 100));
      this.factory.store.setRunSourceRef(run.id, {
        ...run.sourceRef,
        kind: "discord",
        channelId: channel,
        threadId,
      });
      this.enqueue(threadId, `Run ${run.id} started. Reply here to answer questions.`);
      for (const content of this.pendingThreadPosts.get(run.id) ?? []) this.enqueue(threadId, content);
      this.pendingThreadPosts.delete(run.id);
    } catch (error) {
      this.pendingThreadPosts.delete(run.id);
      console.error("[discord] create thread:", error);
    }
  }

  private async mention(message: DiscordMessage): Promise<void> {
    const conversationId = `discord:${message.guildId}:${message.channelId}:${message.userId}`;
    const previous = this.mentionQueues.get(conversationId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          const before = this.factory.concierge.history(conversationId).messages.at(-1)?.id ?? 0;
          const confirm = message.content.match(/^confirm\s+(\S+)$/i);
          const edit = message.content.match(/^edit\s+(\S+)\s+([\s\S]+)$/i);
          const input = confirm
            ? { type: "confirm", proposalId: confirm[1] }
            : edit
              ? { type: "edit", proposalId: edit[1], proposal: JSON.parse(edit[2] ?? "") }
              : { type: "text", text: message.content };
          const history = await this.factory.concierge.submit(
            conversationId,
            ChatRequestSchema.parse(input),
            {
              source: "discord",
              requestedBy: message.userId,
              channelId: message.channelId,
              messageId: message.id,
            },
          );
          for (const proposal of history.proposals) {
            if (proposal.runId) {
              const run = this.factory.store.getRun(proposal.runId);
              if (run) await this.attachThread(run);
            }
          }
          for (const reply of history.messages.filter((m) => m.id > before && m.role === "assistant")) {
            const proposal = reply.outcome?.proposal;
            let content = reply.content;
            if (proposal?.state === "pending")
              content += `\nProposal: ${proposal.id}\nRepo: ${proposal.repo}\nTitle: ${proposal.title}\nProfile: ${proposal.profile}\nPrompt: ${proposal.prompt}${proposal.allow?.length ? `\nAllow: ${proposal.allow.join(", ")}` : ""}\nMention me with: confirm ${proposal.id}\nTo edit, mention me with: edit ${proposal.id} {"repo":"...","prompt":"...","profile":"auto","title":"..."}\nEdits require fresh confirmation.`;
            if (reply.runId) content += `\n${this.runUrl(reply.runId)}`;
            for (let offset = 0; offset < content.length; offset += 1900)
              this.enqueue(message.channelId, content.slice(offset, offset + 1900));
          }
        } catch (error) {
          this.enqueue(message.channelId, `Chat error: ${(error as Error).message}`.slice(0, 1900));
        }
      });
    this.mentionQueues.set(conversationId, next);
    try {
      await next;
    } finally {
      if (this.mentionQueues.get(conversationId) === next) this.mentionQueues.delete(conversationId);
    }
  }

  async message(message: DiscordMessage): Promise<void> {
    if (message.bot || message.userId !== this.factory.cfg.discordOwnerId || !message.content.trim()) return;
    const run = this.factory.store.getRunByDiscordThread(message.channelId);
    if (message.mentioned) {
      if (!message.id || message.guildId !== this.factory.cfg.secrets.DISCORD_GUILD_ID) return;
      if (message.channelId !== this.factory.cfg.discordChannelId && !run) return;
      await this.mention(message);
      return;
    }
    if (!run) return;
    try {
      this.factory.answer(run.id, message.content.trim(), `discord:${message.userId}`);
      this.enqueue(message.channelId, "Answer recorded.");
    } catch (error) {
      if (error instanceof Error && error.message === "no open questions on this run")
        this.enqueue(message.channelId, "No question is open for this run.");
      else console.error("[discord] answer:", error);
    }
  }
}

export function mountDiscord(
  factory: Factory,
  port?: DiscordPort,
): { note: string; stop: () => Promise<void>; integration?: DiscordIntegration } {
  const missing = discordMissing(factory.cfg);
  if (missing.length)
    return { note: `Discord disabled: missing ${missing.join(", ")}`, stop: async () => {} };
  const integration = new DiscordIntegration(
    factory,
    port ??
      new GatewayDiscordPort(factory.cfg.secrets.DISCORD_BOT_TOKEN ?? "", {
        onWarning: (message) => {
          factory.store.addEvent({ runId: "integration:discord", type: "log", level: "warn", message });
        },
      }),
  );
  integration.start();
  return { note: "Discord enabled", stop: () => integration.stop(), integration };
}
