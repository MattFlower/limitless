# Codex setup

Use a stable Limitless checkout with dependencies installed (`bun install`) and the daemon running
(`bun src/cli/main.ts serve`). Ensure Bun is on Codex's PATH. Run
`bun /absolute/path/to/limitless/src/cli/main.ts integrations install` to print setup instructions;
add `--write` to copy only the skill to `~/.agents/skills/limitless/SKILL.md`. Existing identical
skills are a no-op; differing skills are never overwritten. Configuration files are never edited.
Assets resolve relative to the Limitless code, independently of the caller's working directory.

Manually add to `~/.codex/config.toml`, replacing the path with your stable checkout:

```toml
[mcp_servers.limitless]
command = "bun"
args = ["/absolute/path/to/limitless/src/cli/main.ts", "mcp"]

[mcp_servers.limitless.env]
LIMITLESS_URL = "http://127.0.0.1:7400"
```

The argument array preserves paths containing spaces. Do not point this at a temporary factory
worktree. `LIMITLESS_URL` overrides the daemon address; without it the stdio proxy uses
`http://127.0.0.1:${LIMITLESS_PORT ?? 7400}`. The proxy does not start a factory.

Alternatively configure Streamable HTTP instead of command/args/env:

```toml
[mcp_servers.limitless]
url = "http://127.0.0.1:7400/mcp"
```

This endpoint accepts only loopback connections with trusted origins and rejects Cloudflare tunnel
requests. See the [repository README](../../README.md#using-limitless-from-claude-code-and-codex)
for the full delegation and follow-up example, and the [Codex MCP documentation](https://developers.openai.com/codex/mcp)
for configuration details.
