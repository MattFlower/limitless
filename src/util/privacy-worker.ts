import { parentPort } from "node:worker_threads";
import { privacyWorkerHandler, privacyWorkerReady } from "./privacy-checker.ts";

if (!parentPort) throw new Error("The privacy worker entry runs only as a worker thread");
privacyWorkerHandler(parentPort as Parameters<typeof privacyWorkerHandler>[0]);
parentPort.postMessage(privacyWorkerReady);
