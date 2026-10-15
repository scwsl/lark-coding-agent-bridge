# lark-channel-bridge — Claude Code 入口

仓库约定与 Codex 共用一份，写在 `AGENTS.md`，下面整份导入；不要在这里另写规则。

@AGENTS.md

## Claude Code 专用

- `/ship`、`/restart-bridge`、`/release`：`.claude/commands/` 下的快捷入口，步骤本体在 `docs/dev/`。
- `.claude/settings.json` 的 deny 列表是护栏（禁读 keystore / `.env`、禁 force push、禁加 remote），不是约定本身。
