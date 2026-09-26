// A single shared clock signal so every live-duration / relative-time display in the app
// re-renders together, instead of each component running its own setInterval.
import { createSignal } from "solid-js";

const [now, setNow] = createSignal(Date.now());

if (typeof window !== "undefined") {
  setInterval(() => setNow(Date.now()), 1000);
}

export { now };
