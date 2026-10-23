import { A, useLocation } from "@solidjs/router";
import { type Component, createSignal, For, type JSX, onMount, Show } from "solid-js";
import type { AuthSession } from "../../src/core/types.ts";
import { getSession, signOut } from "../api.ts";
import { ensureLiveStore, live } from "../store.ts";

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

// 20×20 stroke icons; the link text names each destination, so the icons are decorative.
const ICONS: Record<string, () => JSX.Element> = {
  "/": () => (
    <>
      <rect x="3" y="3" width="6" height="6" rx="1.5" />
      <rect x="11" y="3" width="6" height="6" rx="1.5" />
      <rect x="3" y="11" width="6" height="6" rx="1.5" />
      <rect x="11" y="11" width="6" height="6" rx="1.5" />
    </>
  ),
  "/setup": () => (
    <>
      <path d="M3 6h14M3 14h14" />
      <circle cx="7" cy="6" r="2" class="nav-icon-knob" />
      <circle cx="13" cy="14" r="2" class="nav-icon-knob" />
    </>
  ),
  "/models": () => (
    <>
      <rect x="5" y="5" width="10" height="10" rx="2" />
      <path d="M8 2v3M12 2v3M8 15v3M12 15v3M2 8h3M2 12h3M15 8h3M15 12h3" />
    </>
  ),
  "/providers": () => (
    <>
      <rect x="3" y="3" width="14" height="6" rx="1.5" />
      <rect x="3" y="11" width="14" height="6" rx="1.5" />
      <path d="M6.5 6h.01M6.5 14h.01" />
    </>
  ),
  "/land": () => (
    <>
      <circle cx="6" cy="4.5" r="2" />
      <circle cx="6" cy="15.5" r="2" />
      <circle cx="14" cy="9" r="2" />
      <path d="M6 6.5v7M6 9c0 2 2 3 6 0" />
    </>
  ),
  "/evals": () => (
    <path d="M7.5 2.5h5M8.5 2.5V8l-4.3 7.3a1.5 1.5 0 0 0 1.3 2.2h9a1.5 1.5 0 0 0 1.3-2.2L11.5 8V2.5M6 12.5h8" />
  ),
  "/chat": () => (
    <path d="M5.5 3.5h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-5l-4 3v-3a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z" />
  ),
};

const LINKS: { href: string; label: string }[] = [
  { href: "/", label: "Mission control" },
  { href: "/setup", label: "Setup" },
  { href: "/models", label: "Models" },
  { href: "/providers", label: "Providers" },
  { href: "/land", label: "Land" },
  { href: "/evals", label: "Evals" },
  { href: "/chat", label: "Chat" },
];

const NavIcon: Component<{ href: string }> = (props) => (
  <svg class="nav-icon" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
    {ICONS[props.href]?.()}
  </svg>
);

export const NavBar: Component = () => {
  // The nav renders on every route, so this is the one place that guarantees the global
  // run/provider stream (and its connection indicator) is live regardless of which page the
  // user lands on first.
  ensureLiveStore();
  const location = useLocation();
  const [session, setSession] = createSignal<AuthSession | null>(null);
  onMount(() =>
    getSession().then(
      (r) => setSession(r.session),
      () => {},
    ),
  );
  const leave = (everywhere: boolean) => {
    if (everywhere && !confirm("Sign out every browser, including this one?")) return;
    const toLogin = () => window.location.assign("/login");
    void signOut(everywhere).then(toLogin, toLogin);
  };
  return (
    <nav class="nav" aria-label="Primary">
      <A href="/" class="nav-brand">
        <svg class="glyph" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path d="M9 1 17 9 9 17 1 9Z" />
          <path d="M9 5.5 12.5 9 9 12.5 5.5 9Z" class="glyph-core" />
        </svg>
        limitless
      </A>
      <A
        href="/new"
        class="nav-link nav-link-primary"
        classList={{ active: isActive(location.pathname, "/new") }}
      >
        <svg class="nav-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M7 1.5v11M1.5 7h11" />
        </svg>
        New run
      </A>
      <div class="nav-links">
        <For each={LINKS}>
          {(link) => (
            <A
              href={link.href}
              class="nav-link"
              classList={{ active: isActive(location.pathname, link.href) }}
            >
              <NavIcon href={link.href} />
              {link.label}
            </A>
          )}
        </For>
      </div>
      <div class="nav-footer">
        <div class="live-dot-wrap" title={live.connected() ? "Live stream connected" : "Reconnecting…"}>
          <span class="live-dot" classList={{ on: live.connected() }} />
          {live.connected() ? "Live" : "Offline"}
        </div>
        <Show when={session()}>
          <div class="nav-session">
            <button type="button" class="btn btn-sm" onClick={() => leave(false)}>
              Sign out
            </button>
            <button type="button" class="btn btn-sm" onClick={() => leave(true)}>
              Sign out everywhere
            </button>
          </div>
        </Show>
      </div>
    </nav>
  );
};
