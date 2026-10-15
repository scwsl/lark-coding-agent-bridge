# 发版（release）

Claude Code 与 Codex 共用的发版步骤（Claude Code 里的 `/release` 即执行本文）。推送 `vX.Y.Z` tag 会触发 `.github/workflows/release.yml`：

1. `notes`：`.github/scripts/release-notes.mjs` 校验 tag 与 `package.json` 的 `version` 一致，且 `CHANGELOG.md` 里有非空的 `## vX.Y.Z` 段落；
2. `ci`：复用 `ci.yml`，macOS / Ubuntu / Windows 三平台 test + typecheck + build（Windows 不维护、不阻断，见 `AGENTS.md`「质量门禁」）；
3. `release`：`pnpm pack` 打包，创建 GitHub Release，正文取 `CHANGELOG.md` 里该版本的段落，附上 tgz。tag 带 `-`（如 `v0.9.0-rc.1`）的标为 pre-release。

不发布到 npm：包名 `lark-channel-bridge` 属于上游。本机运行仍是主 checkout + `npm link`（见 `AGENTS.md`「本机运行形态」），发版不改变运行方式，也不需要重启。

## 版本号

semver，fork 从 `v0.8.0` 起独立编号：有新功能升 minor，只有修复升 patch。

## 步骤

1. 在 worktree 里（按 `AGENTS.md`「迭代流程」）准备发版提交：
   - `package.json` 的 `version` 改成 `X.Y.Z`；
   - `CHANGELOG.md` 在第一个版本段落之前插入 `## vX.Y.Z — YYYY-MM-DD`。内容面向使用者、写中文：按主题分组，写清现象和用法，不贴提交号清单。范围是上个 tag 到现在：`git log --oneline <上个 tag>..main`；
   - `node .github/scripts/release-notes.mjs vX.Y.Z` 预览 Release 正文。
2. `pnpm ci:local` 全绿（`tests/unit/docs/release-notes.test.ts` 会检查当前版本有对应的说明），提交 `chore(release): vX.Y.Z`，按 `docs/dev/ship.md` 合回 main 并推送。
3. 在主 checkout 的 main 上打注解 tag 并推送（`M=~/workspace/lark-coding-agent-bridge`）：
   - `git -C $M fetch -q origin`，确认 `git -C $M rev-parse main` 等于 `origin/main`，且 `HEAD` 就是发版提交；
   - `git -C $M tag -a vX.Y.Z -m vX.Y.Z && git -C $M push origin vX.Y.Z`。
4. 盯流水线：`gh run list -R mirsery/lark-coding-agent-bridge --workflow release.yml -L 1` 取 run id，`gh run watch <id> -R mirsery/lark-coding-agent-bridge --exit-status`。
5. 核对 Release：`gh release view vX.Y.Z -R mirsery/lark-coding-agent-bridge`，正文和附件都在。
6. 汇报：版本号、Release 链接、流水线结果（失败就贴失败的 job 和报错）。

## 失败了怎么办

- **Release 还没建出来**（`notes` 或 `ci` 失败）：在新 worktree 里修好、走完 ship，然后删掉旧 tag 重打——`git -C $M push origin :refs/tags/vX.Y.Z && git -C $M tag -d vX.Y.Z`，再回到第 3 步。
- **Release 已经建出来**：不删、不覆盖已发布的 tag，问题在下一个 patch 版本里修。

## 规则

- tag 只打在已推送的 main 提交上；只推 `origin`。
- 不 `npm publish`，不手动 `gh release create`（Release 只由流水线创建，保证每个版本都过了三平台 CI）。
