import { homedir } from "node:os";
import { join } from "node:path";
import { browserCache, provisionBrowserMcp } from "../src/harness/browser-mcp.ts";

await provisionBrowserMcp(browserCache(process.env.LIMITLESS_HOME ?? join(homedir(), ".limitless")));
console.log("Pinned browser MCP cache ready");
