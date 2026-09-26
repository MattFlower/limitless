import type { RouteSectionProps } from "@solidjs/router";
import { Route, Router } from "@solidjs/router";
import type { Component } from "solid-js";
import { render } from "solid-js/web";
import { NavBar } from "./components/NavBar.tsx";
import { Chat } from "./pages/Chat.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Models } from "./pages/Models.tsx";
import { NewRun } from "./pages/NewRun.tsx";
import { RunDetail } from "./pages/RunDetail.tsx";

const Shell: Component<RouteSectionProps> = (props) => (
  <>
    <NavBar />
    {props.children}
  </>
);

render(
  () => (
    <Router root={Shell}>
      <Route path="/" component={Dashboard} />
      <Route path="/runs/:id" component={RunDetail} />
      <Route path="/new" component={NewRun} />
      <Route path="/models" component={Models} />
      <Route path="/chat" component={Chat} />
    </Router>
  ),
  document.getElementById("root") as HTMLElement,
);
