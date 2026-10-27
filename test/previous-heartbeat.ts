import { z } from "zod";
import { CLAUDE_VERSION, CODEX_VERSION } from "../src/harness/versions.ts";

// A literal copy of the heartbeat schema the release before Linux workers enforces (src/workers/protocol.ts
// at 5547f31): darwin only, no confinement field. Kept literal so a change to today's schema can't leak in.
const cli = (pattern: RegExp) =>
  z
    .object({
      version: z
        .string()
        .nullable()
        .transform((value) => (value && pattern.test(value) ? value : null)),
      loggedIn: z.boolean(),
    })
    .strict();
const Agents = z
  .object({ claude: cli(CLAUDE_VERSION).optional(), codex: cli(CODEX_VERSION).optional() })
  .strict();
export const PreviousHeartbeat = z
  .object({
    releaseSha: z.string().min(1).max(128),
    bunVersion: z.string().min(1).max(64),
    os: z.literal("darwin"),
    osVersion: z.string().max(128),
    cpuCount: z.number().int().positive(),
    ramBytes: z.number().int().positive(),
    freeSlots: z.number().int().nonnegative(),
    onAC: z.boolean(),
    idleSeconds: z.number().nonnegative(),
    jobs: z.array(z.string().uuid()).max(128),
    agents: Agents.optional(),
    privateStringsDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    updateWarning: z.string().max(4000).optional(),
  })
  .strict();
