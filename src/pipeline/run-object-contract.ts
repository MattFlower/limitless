export type ObjectFormat = "sha1" | "sha256";
export type PrivateObjectType = "commit" | "tree" | "blob" | "tag";
export interface RunObjectExportInput {
  repository: {
    path: string;
    /** Shared factory cache identity, also for linked worktrees. */
    lockPath: string;
    trust: "agent-controlled" | "factory-owned";
  };
  runScope: string;
  commits: readonly string[];
  objectFormat: ObjectFormat;
}
export interface RunObjectBundle {
  bytes: Uint8Array;
  requiredCommits: readonly string[];
  refs: readonly { name: string; oid: string }[];
  objectFormat: ObjectFormat;
}
export type RunObjectValidationInput = RunObjectBundle;
/** Read-only authority, valid only during inspect; the reader must not escape that callback. */
export interface PrivateObjectReader {
  /** Every physically imported object, including unreachable packed objects. */
  objects(): AsyncIterable<{ oid: string; type: PrivateObjectType }>;
  type(oid: string): Promise<PrivateObjectType>;
  /** Raw object content, without decoding or Git pretty-printing. */
  read(oid: string): Promise<Uint8Array>;
}
export interface RunObjectIO {
  export(input: RunObjectExportInput, signal: AbortSignal): Promise<RunObjectBundle | null>;
  /**
   * Validate Git structure and required closure before awaiting inspect in a live fresh quarantine.
   * Invalidate the reader when inspect ends, then check abort before success. Own cleanup in finally
   * for every outcome, including cancellation and inspection failure; settle only after cleanup.
   * No live quarantine handle is returned. Implemented separately from export in C09n.
   */
  validate(
    input: RunObjectValidationInput,
    inspect: (reader: PrivateObjectReader) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
}
