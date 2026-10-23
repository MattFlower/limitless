import type { RouteSectionProps } from "@solidjs/router";
import { Route, Router } from "@solidjs/router";
import type { Component } from "solid-js";
import { Show } from "solid-js";
import { render } from "solid-js/web";
import { NavBar } from "./components/NavBar.tsx";
import { SidebarStatus } from "./components/SidebarStatus.tsx";
import { Chat } from "./pages/Chat.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { EvalDetail, Evals } from "./pages/Evals.tsx";
import { Land } from "./pages/Land.tsx";
import { Models } from "./pages/Models.tsx";
import { NewRun } from "./pages/NewRun.tsx";
import { Providers } from "./pages/Providers.tsx";
import { RunDetail } from "./pages/RunDetail.tsx";
import { Setup } from "./pages/Setup.tsx";
import { live } from "./store.ts";

const Shell: Component<RouteSectionProps> = (props) => (
  <div class="app">
    <aside class="sidebar">
      <NavBar />
      <SidebarStatus />
    </aside>
    <div class="app-main">
      <Show when={live.draining()}>
        <div class="draining-banner" role="status">
          Draining for deployment: active runs continue; new runs are queued until scheduling resumes.
        </div>
      </Show>
      {props.children}
    </div>
  </div>
);

render(
  () => (
    <Router root={Shell}>
      <Route path="/" component={Dashboard} />
      <Route path="/runs/:id" component={RunDetail} />
      <Route path="/new" component={NewRun} />
      <Route path="/land" component={Land} />
      <Route path="/evals" component={Evals} />
      <Route path="/evals/:id" component={EvalDetail} />
      <Route path="/setup" component={Setup} />
      <Route path="/models" component={Models} />
      <Route path="/providers" component={Providers} />
      <Route path="/chat" component={Chat} />
    </Router>
  ),
  document.getElementById("root") as HTMLElement,
);
