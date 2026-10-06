# toolkitka

Small local tools for everyday work with Claude Code and Codex.

| Tool | What it does | Stack |
|---|---|---|
| [`uzalka`](uzalka/) | Tray app with your Claude Code and Codex usage limits | Tauri 2 (Rust + JS) |
| [`claude-router`](claude-router/) | Drop-in `claude.exe` that switches between your Claude accounts automatically when one runs low | Rust |
| [`chat-history-mcp`](chat-history-mcp/) | MCP server: local archive and full-text search of Claude Code, Codex, OpenCode and T3 Code chats | Node 22, TypeScript, SQLite |

```text
  uzalka  ── limits ──▶  claude-router  ──▶  claude.exe on the account with quota left
  (tray)    127.0.0.1                         (the chat moves along with it)

  chat-history-mcp  ◀── any MCP client: "what did we decide about X last week?"
```

The tools are independent. The router works best with Uzalka running, but can ask
Claude Code for the limits itself.

Built and used on Windows 11. Each folder has its own README with setup steps.

## License

MIT, see [LICENSE](LICENSE).
