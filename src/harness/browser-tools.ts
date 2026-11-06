// Keep this shared vocabulary independent of harness and gate-projection initialization.
// The pinned server also exposes RCE, routing and configuration tools. Grant only UI operations.
export const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_drag",
  "browser_wait_for",
  "browser_tabs",
  "browser_close",
  "browser_resize",
  "browser_handle_dialog",
  "browser_console_messages",
  "browser_network_requests",
  "browser_take_screenshot",
];
