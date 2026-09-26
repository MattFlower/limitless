import type { Component } from "solid-js";

export const Chat: Component = () => (
  <div class="page">
    <div class="page-header">
      <h1 class="page-title">Chat</h1>
    </div>
    <div class="hint-banner">
      The chat concierge — turning free text into a confirmed run, right from here — arrives in milestone 3.
      For now, start runs from <span class="mono">New run</span> and track them on the{" "}
      <span class="mono">Dashboard</span>.
    </div>
  </div>
);
