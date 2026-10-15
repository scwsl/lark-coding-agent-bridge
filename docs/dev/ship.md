# 交付（ship）

Claude Code 与 Codex 共用的交付步骤（Claude Code 里的 `/ship` 即执行本文）。把当前 worktree 的已提交改动交付到主 checkout。前提：`pnpm ci:local` 已在该分支全绿，改动已按 `AGENTS.md`「提交规范」提交。

## 步骤

1. 确认状态：`git status --short` 为空（有未提交改动就停下，先提交或说明原因）；记下分支名 `B`（调用方指定的分支，默认 `git branch --show-current`）和 worktree 路径 `W`。
2. 主 checkout 记为 `M=~/workspace/lark-coding-agent-bridge`：
   - `git -C $M status --short` 必须为空，且 `git -C $M branch --show-current` 为 `main`；不满足就停下汇报，不要替别人的改动做决定。
   - `git -C $M fetch -q origin && git -C $M merge --ff-only origin/main`。
3. 让分支基于最新 main：在 `W` 里 `git rebase main`（有冲突停下汇报）；rebase 过就重跑 `pnpm ci:local`。
4. 合入：`git -C $M merge --ff-only $B`，然后 `git -C $M push origin main`。
5. 构建线上 dist：`cd $M && pnpm build`，确认输出里 ESM / DTS 都是 `Build success`。
6. 清理：`git -C $M worktree remove $W`（worktree 里的 `node_modules` 是软链，会一并移除）、`git -C $M branch -d $B`。
7. 汇报：提交号、门禁结果、「已构建，需重启生效」。**不要自行重启**，等 boss 发话后按 `docs/dev/restart-bridge.md` 执行。

## 规则

- 只用 fast-forward，不产生 merge commit；不 force push。
- 只推 `origin`（boss 的 fork），不碰任何其他 remote。
