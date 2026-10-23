export * from "./providers-page-support.ts";
export const requests: {
  path: string;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}[] = [];
export const fetch = (path: string) =>
  new Promise<Response>((resolve, reject) => requests.push({ path, resolve, reject }));
const listeners = new Set<() => void>();
export const window = {
  addEventListener: (_event: string, fn: () => void) => listeners.add(fn),
  removeEventListener: (_event: string, fn: () => void) => listeners.delete(fn),
};
export const focus = () => {
  for (const fn of listeners) fn();
};
export const focusListeners = () => listeners.size;
export const redirects: string[] = [];
export const location = { pathname: "/workers", search: "", assign: (url: string) => redirects.push(url) };
