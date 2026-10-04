import { A, useLocation } from "@solidjs/router";
import { type Component, createSignal, onMount, Show } from "solid-js";
import type { AuthSession } from "../../src/core/types.ts";
import { getSession, signOut } from "../api.ts";
import { ensureLiveStore, live } from "../store.ts";

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

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
    <nav class="nav">
      <A href="/" class="nav-brand">
        <span class="glyph">◆</span>
        limitless
      </A>
      <div class="nav-links">
        <A
          href="/"
          class="nav-link"
          classList={{ active: isActive(location.pathname, "/") && location.pathname === "/" }}
        >
          Dashboard
        </A>
        <A href="/models" class="nav-link" classList={{ active: isActive(location.pathname, "/models") }}>
          Models
        </A>
        <A
          href="/providers"
          class="nav-link"
          classList={{ active: isActive(location.pathname, "/providers") }}
        >
          Providers
        </A>
        <A href="/evals" class="nav-link" classList={{ active: isActive(location.pathname, "/evals") }}>
          Evals
        </A>
        <A href="/chat" class="nav-link" classList={{ active: isActive(location.pathname, "/chat") }}>
          Chat
        </A>
      </div>
      <A
        href="/new"
        class="nav-link nav-link-primary"
        classList={{ active: isActive(location.pathname, "/new") }}
      >
        + New run
      </A>
      <div class="live-dot-wrap" title={live.connected() ? "Live stream connected" : "Reconnecting…"}>
        <span class="live-dot" classList={{ on: live.connected() }} />
        {live.connected() ? "live" : "offline"}
      </div>
      <Show when={session()}>
        <button type="button" class="btn btn-sm" onClick={() => leave(false)}>
          Sign out
        </button>
        <button type="button" class="btn btn-sm" onClick={() => leave(true)}>
          Sign out everywhere
        </button>
      </Show>
    </nav>
  );
};
