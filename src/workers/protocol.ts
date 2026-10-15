import { z } from "zod";

export const Heartbeat = z
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
  })
  .strict();
export type Capabilities = z.infer<typeof Heartbeat>;
export const Pair = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const Claim = z.object({ secret: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const timing = {
  heartbeat: 10_000,
  fresh: 30_000,
};
export type WorkerTiming = typeof timing;
