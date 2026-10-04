import { createStore } from "solid-js/store";
import { createRenderer } from "solid-js/universal";
import type { AuthSession, ProviderStatus, QuotaAlert } from "../src/core/types.ts";
import type { ProviderWorkload } from "../src/db/stats.ts";

// Solid's universal renderer exercises mounted reactive components without a browser or DOM dependency.
export interface TestNode {
  tag: string;
  text: string;
  props: Record<string, unknown>;
  children: TestNode[];
  parent?: TestNode;
}

export function node(tag = "root", text = ""): TestNode {
  return { tag, text, props: {}, children: [] };
}

export const {
  render,
  effect,
  memo,
  createComponent,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
  use,
} = createRenderer<TestNode>({
  createElement: (tag) => node(tag),
  createTextNode: (text) => node("#text", text),
  replaceText: (node, text) => {
    node.text = text;
  },
  isTextNode: (node) => node.tag === "#text",
  setProperty: (node, name, value) => {
    node.props[name] = value;
  },
  insertNode: (parent, node, anchor) => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = parent;
    parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, node);
  },
  removeNode: (parent, node) => {
    parent.children.splice(parent.children.indexOf(node), 1);
    node.parent = undefined;
  },
  getParentNode: (node) => node.parent,
  getFirstChild: (node) => node.children[0],
  getNextSibling: (node) => node.parent?.children[(node.parent?.children.indexOf(node) ?? -1) + 1],
});

const [providers, setProviders] = createStore<Record<string, ProviderStatus>>(Object.create(null));
const [alerts, setAlerts] = createStore<Record<string, QuotaAlert>>({});
export const live = { providers, alerts, runs: {}, connected: () => true };
export { setAlerts, setProviders };
export let liveStarts = 0;
export function ensureLiveStore() {
  liveStarts++;
}

let workload: ProviderWorkload[] = [];
let failure = false;
export let workloadReads = 0;
export function setWorkload(rows: ProviderWorkload[], fail = false) {
  workload = rows;
  failure = fail;
}
export async function getProviderWorkload() {
  workloadReads++;
  if (failure) throw new Error("Workload unavailable");
  return workload;
}
export const getStats = async () => null;
let authSession: AuthSession | null = null;
export function setAuthSession(session: AuthSession | null) {
  authSession = session;
}
export const getSession = async () => ({ session: authSession });
export const signOut = async () => ({ revoked: 1 });
export const updates: { id: string; enabled?: boolean; fast?: boolean }[] = [];
export async function setProviderEnabled(id: string, enabled: boolean) {
  updates.push({ id, enabled });
}
export async function setProviderFast(id: string, fast: boolean) {
  updates.push({ id, fast });
}

let elapsed = 0;
let nextTimer = 0;
const timers = new Map<number, { callback: () => void; ms: number; next: number }>();
export function setInterval(callback: () => void, ms: number) {
  const id = ++nextTimer;
  timers.set(id, { callback, ms, next: elapsed + ms });
  return id;
}
export function clearInterval(id: number) {
  timers.delete(id);
}
export function advanceTimers(ms: number) {
  elapsed += ms;
  for (const timer of timers.values()) {
    while (timer.next <= elapsed) {
      timer.next += timer.ms;
      timer.callback();
    }
  }
}
export const timerCount = () => timers.size;
