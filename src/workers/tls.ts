import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { join } from "node:path";
import { connect } from "node:tls";
import { protectPrivateFile } from "../util/private-reads.ts";
import { agentEnv, registerCredential, sh } from "../util/proc.ts";

export const fingerprint = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");
export async function certificate(home: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const keyPath = join(home, "key.pem"),
    certPath = join(home, "cert.pem");
  const release = protectPrivateFile(keyPath);
  try {
    if (!existsSync(keyPath) || !existsSync(certPath)) {
      if (existsSync(keyPath) || existsSync(certPath)) throw new Error("Incomplete worker TLS material");
      writeFileSync(keyPath, "", { flag: "wx", mode: 0o600 });
      await sh(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
          "-nodes",
          "-days",
          "3650",
          "-subj",
          "/CN=limitless-worker",
          "-keyout",
          keyPath,
          "-out",
          certPath,
        ],
        { cwd: home, env: agentEnv(), timeoutMs: 30_000 },
      );
    }
    chmodSync(keyPath, 0o600);
    const key = readFileSync(keyPath, "utf8"),
      cert = readFileSync(certPath, "utf8");
    return { key, cert, keyPath, fingerprint: fingerprint(new X509Certificate(cert).raw), release };
  } catch (error) {
    release();
    throw error;
  }
}

export function privateFile(path: string, value?: string) {
  const release = protectPrivateFile(path);
  try {
    if (value !== undefined) {
      const temp = `${path}.${randomUUID()}`;
      const releaseTemp = protectPrivateFile(temp);
      try {
        writeFileSync(temp, value, { flag: "wx", mode: 0o600 });
        renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
        releaseTemp();
      }
    }
    chmodSync(path, 0o600);
    return { value: readFileSync(path, "utf8").trim(), release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Verify the actual TLS socket before constructing any request containing credentials. */
export async function workerRequest(
  origin: string,
  path: string,
  body?: unknown,
  options: { pin?: string; token?: string; signal?: AbortSignal; timeoutMs?: number } = {},
) {
  if (
    (options.pin !== undefined && !/^[a-f0-9]{64}$/.test(options.pin)) ||
    (options.token !== undefined && options.pin === undefined)
  )
    throw new Error("A valid pinned coordinator fingerprint is required");
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Coordinator must be an HTTPS origin");
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(options.timeoutMs ?? 45_000),
  ]);
  signal.throwIfAborted();
  const socket = connect({
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 443),
    rejectUnauthorized: false,
  });
  const abort = () => socket.destroy(new Error("Worker request cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    const observed = await new Promise<string>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("secureConnect", () => {
        const raw = socket.getPeerCertificate().raw;
        if (!raw) return reject(new Error("Missing coordinator certificate"));
        const observed = fingerprint(raw);
        if (options.pin !== undefined && observed !== options.pin)
          return reject(new Error("Coordinator certificate fingerprint changed"));
        resolve(observed);
      });
    });
    const agent = new Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    const response = await new Promise<{ status: number; data: Buffer }>((resolve, reject) => {
      const req = request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path,
          method: body === undefined ? "GET" : "POST",
          agent,
          headers: {
            "content-type": "application/json",
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => resolve({ status: res.statusCode ?? 500, data: Buffer.concat(chunks) }));
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    return { ...response, fingerprint: observed, json: (): unknown => JSON.parse(response.data.toString()) };
  } finally {
    signal.removeEventListener("abort", abort);
    socket.destroy();
  }
}

export function registerWorkerToken(token: string) {
  registerCredential("LIMITLESS_WORKER_TOKEN", token);
}
