import type { RouteSectionProps } from "@solidjs/router";
import { Route, Router } from "@solidjs/router";
import type { Component } from "solid-js";
import { Show } from "solid-js";
import { render } from "solid-js/web";
import { NavBar } from "./components/NavBar.tsx";
import { Chat } from "./pages/Chat.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { EvalDetail, Evals } from "./pages/Evals.tsx";
import { Models } from "./pages/Models.tsx";
import { NewRun } from "./pages/NewRun.tsx";
import { Providers } from "./pages/Providers.tsx";
import { RunDetail } from "./pages/RunDetail.tsx";
import { live } from "./store.ts";

const Shell: Component<RouteSectionProps> = (props) => (
  <>
    <NavBar />
    <Show when={live.draining()}>
      <div class="draining-banner" role="status">
        Draining for deployment: active runs continue; new runs are queued until scheduling resumes.
      </div>
    </Show>
    {props.children}
  </>
);

render(
  () => (
    <Router root={Shell}>
      <Route path="/" component={Dashboard} />
      <Route path="/runs/:id" component={RunDetail} />
      <Route path="/new" component={NewRun} />
      <Route path="/evals" component={Evals} />
      <Route path="/evals/:id" component={EvalDetail} />
      <Route path="/models" component={Models} />
      <Route path="/providers" component={Providers} />
      <Route path="/chat" component={Chat} />
    </Router>
  ),
  document.getElementById("root") as HTMLElement,
);
