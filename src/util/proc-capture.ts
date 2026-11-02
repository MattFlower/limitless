import { AsyncLocalStorage } from "node:async_hooks";
import { type Provenance, privacyLimits } from "./privacy-boundary.ts";

export type CompleteCapture =
  | { provenance: Extract<Provenance, { kind: "complete" }>; stdout: string; stderr: string }
  | { provenance: Exclude<Provenance, { kind: "complete" }> };

/** Test instrumentation receives counts only, never captured text. */
export const processCaptureObserver = new AsyncLocalStorage<(retainedUnits: number) => void>();

export function completeOutputCapture() {
  const observe = processCaptureObserver.getStore();
  const text = { stdout: "", stderr: "" };
  const ended = { stdout: false, stderr: false };
  const decoders = {
    stdout: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }),
    stderr: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }),
  };
  let provenance: Provenance = { kind: "complete" };
  let units = 0;
  const discard = (next: Provenance) => {
    provenance = next;
    text.stdout = text.stderr = "";
    units = 0;
    observe?.(text.stdout.length + text.stderr.length);
  };
  const fail = () => discard({ kind: "legacy-unknown" });
  return {
    fail,
    push(stream: "stdout" | "stderr", bytes?: Uint8Array) {
      if (bytes === undefined) ended[stream] = true;
      if (provenance.kind === "legacy-unknown") return;
      let decoded: string;
      try {
        decoded = decoders[stream].decode(bytes, { stream: bytes !== undefined });
      } catch {
        fail();
        return;
      }
      // Even after overflow, validate subsequent bytes and EOF without retaining text.
      if (provenance.kind !== "complete") return;
      if (decoded.length > privacyLimits.inputUnits - units) {
        discard({ kind: "cut", truncated: true });
        return;
      }
      text[stream] += decoded;
      units += decoded.length;
      observe?.(text.stdout.length + text.stderr.length);
    },
    finish(unknown: boolean): CompleteCapture {
      if (unknown || !ended.stdout || !ended.stderr) fail();
      return provenance.kind === "complete" ? { provenance, ...text } : { provenance };
    },
  };
}
