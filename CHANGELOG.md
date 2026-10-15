# 更新日志

本仓库是 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) 的 fork，从 v0.8.0 起独立编号。每个版本的段落会原样作为 GitHub Release 的正文，发版步骤见 [`docs/dev/release.md`](docs/dev/release.md)。

## v0.8.0 — 2026-10-13

fork 的第一个版本，基于上游 0.7.1（2026-08-31），包含此后 fork 上的全部改动。

### 会话与上下文

- **会话智能压缩**（`/config` 开关，默认关）：空闲太久、上下文过大，或 agent 判断事情已经做完时，自动归档旧会话并开新会话，新会话第一轮带上交接摘要；长会话会提前压缩。Claude 和 Codex 都支持。
- **群聊 / 话题上下文**：飞书只推 @ bot 的群消息，开跑前会把 bot 没收到过的群消息读回来作为背景。
- **跨会话记忆与 skill 目录**：`/memory`、`/skills`。知识目录可以绑定 git 仓库（`/knowledge bind`），除了 `/knowledge sync` 手动同步，还会按间隔自动同步（默认 30 分钟）；记忆文件按行合并，多个 bot 同时写不冲突；连续失败会私聊提醒主人。
- **共享 skill 库**：`/skills lib add <git 地址>` 按仓库加载 skill，多个 bot 共用一份只读镜像，定时拉取。
- `/status` 显示当前会话的上下文大小，并提示下一条消息是否会开新会话。

### 任务与运行

- 一轮结束后不再杀掉还在跑的后台任务（后台 Bash、子 agent、Monitor），后台任务触发的后续结果作为补充回复发出。
- 排队中的消息落盘，重启后 10 分钟内的自动补处理；重启不再留下一直转圈的卡片。
- **长任务完成提醒**：任务跑超过 5 分钟（可配置）时，结束后补一条会推送通知的回复。
- 流式卡片收尾失败时补发最终答案，长任务的回复不再丢失。
- `/cron` 定时任务，运行时带上原会话的记忆与 skill 索引。
- 任务成功后给触发消息加 DONE 表情；卡片模式也会加 Typing 表情。

### Codex

- 改用 `codex app-server`，同一会话复用一个进程。
- codex profile 可以选择模型与推理强度；`codex.env` 只给 Codex 子进程加环境变量（如代理）。
- 用量按本轮计算，不再重复计入；答完后正常退出，不再被强杀。

### 用量、权限与审批

- 按人统计 token 与估算费用：回复卡页脚显示本轮用量，新增 `/usage`。
- **非管理员操作审批**（默认关，profile 显式开启）：审批卡发到管理员私聊，按人审计（`/audit`），可配置免审批的命令与工具，`/config` 里可开关。
- 群可以限定成员白名单；`/remove group <群 ID>` 在私聊里也能用。

### 卡片与命令

- `/config` 改为分区彩色卡片，可编辑 effort 偏好，新增群管理面板（列出 bot 所在的群和每个群的管理方式）。
- `/help` 改为分区卡片。
- `/status` 能识别 git 仓库，新增 `/diff`、`/worktree`、`/pr`；`/worktree` 建的目录闲置且已合入后可以自动清理（默认关）。
- 回复卡页脚显示实际加载的模型版本，以及 Sponsor（当前登录的 Claude / ChatGPT 账号）；回复只有 `[[NO_REPLY]]` 时不发回复卡。
- Claude 模型列表改用 CLI 别名并读取账号缓存，新增 Opus 5.5、Fable 5.1 / 5，去掉 5 代以前的 Opus / Sonnet。
- `/coffee` 彩蛋。

### Web 控制台与宿主机

- Web 控制台改为 macOS Liquid Glass 风格，新增「任务」面板，可以查看和停止正在跑的任务。
- 新增 `lark-channel-bridge monitor` 终端实时面板：任务来源群和发起人，宿主机 CPU、内存、温度、磁盘读写与网络速率。

### 修复

- 恢复 Claude 会话时，残留的后台任务通知不再提前结束本轮；本轮费用不再算进整个会话的历史花费。
- Claude 答完后的退出宽限期放宽到 10 秒，不再误杀正在正常退出的进程。
- 保存配置时不再丢掉 `approvals` 段。
- 本机 lark-cli 探测不再继承父进程的 `LARKSUITE_CLI_CONFIG_DIR`。
- 读取话题上下文时请求 `user_card_content`，CardKit 2.0 卡片不再退化成兼容文案。
- 终止任务按卡片所在话题定位，兼容群模式识别滞后的情况。

### 开发

- agent 种类改为统一注册表，共享代码不再写死 Claude / Codex 二选一。
- 开发约定（`AGENTS.md`）由 Claude Code 与 Codex 共用；worktree 迭代流程、`pnpm ci:local` 门禁、交付与重启步骤放在 `docs/dev/`。
- 新增发版流水线：推送 `v*` tag 后自动跑三平台 CI，然后创建 GitHub Release。
