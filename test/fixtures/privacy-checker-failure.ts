import { parentPort } from "node:worker_threads";

parentPort?.on("message", (message: { kind: string }) => {
  if (message.kind !== "run") return;
  if (process.env.PRIVACY_FIXTURE_THROW === "1") throw new Error("synthetic checker failure");
  process.exit(0);
});
