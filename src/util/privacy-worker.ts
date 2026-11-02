import { parentPort } from "node:worker_threads";
import { privacyWorkerHandler } from "./privacy-checker.ts";

const port = parentPort;
if (!port) throw new Error("The privacy worker entry runs only as a worker thread");
const side: Parameters<typeof privacyWorkerHandler>[0] = {
  postMessage: (v, t = []) => port.postMessage(v, [...t]),
};
port.on("message", (data) => side.onmessage?.({ data }));
privacyWorkerHandler(side);
