# lark-channel-bridge 开发约定

把飞书 / Lark 消息桥接到本机 agent CLI（Claude Code、Codex CLI）的 Node.js 服务。本文件是在这个仓库里改代码的权威约定，**Claude Code 与 Codex 共用**：Codex 直接读本文件，Claude Code 经 `CLAUDE.md` 导入本文件。用户向的安装、命令、配置说明在 `README.zh.md` / `README.md`，这里不重复。

维护要求：约定只写在这里，不要在 `CLAUDE.md` 或 `.claude/` 里另起一份；可执行的操作步骤写在 `docs/dev/`（两种 agent 都能读），`.claude/commands/` 只是指向它们的快捷入口。

## 仓库边界

- 这是 boss 自己的 fork，只有一个 remote：`origin` = `git@github.com:mirsery/lark-coding-agent-bridge.git`。上游已移除：不加回 upstream、不往上游推分支 / 开 PR / 提 issue。需求记录开在 `mirsery/lark-coding-agent-bridge`。
- 默认分支 `main`。提交信息、代码注释、PR 描述里不出现任何 AI 工具署名（`Co-Authored-By: Claude …`、`Co-Authored-By: Codex …`、`Generated with …` 之类一律不加）。

## 本机运行形态（改动怎么生效）

- 全局命令 `lark-channel-bridge` 是指向**主 checkout**（`~/workspace/lark-coding-agent-bridge`）的 `npm link`；各 profile 的 daemon（`ai.lark-channel-bridge.bot.<profile>`，以及 `--web-ui` 的 supervisor）只在启动时加载一次 `dist/`。
- 所以：改代码 → 在主 checkout `pnpm build` → 重启对应 daemon 才生效。`pnpm build` 会重写线上 `dist/`，**半成品不要在主 checkout 构建**（见下方迭代流程，用 worktree）。
- **重启由 boss 决定**：默认只构建不重启，回复里写明「需重启生效」。boss 明确要求时才重启，按 [`docs/dev/restart-bridge.md`](docs/dev/restart-bridge.md) 执行——CC（`claude` profile）和 Poki（`codex` profile）都跑在 bridge 里，重启自己所在的 profile 会杀掉当前这轮 run，必须脱离进程树延时执行。
- 判断 daemon 是否落后于代码：`lark-channel-bridge ps` 的「启动」时间 vs `git log -1 --format=%ci`。

## 迭代流程

每个改动按这个顺序走，不跳步：

1. **独立 worktree**：`git -C ~/workspace/lark-coding-agent-bridge worktree add ~/workspace/.worktrees/bridge-<topic> -b <type>/<topic> main`，再 `ln -s ~/workspace/lark-coding-agent-bridge/node_modules node_modules`。不在主 checkout 上直接改。
2. **先读再改**：读受影响模块和离它最近的测试。bug 先复现——agent CLI 的行为以真实输出为准，抓一份真实 stream 样本（Claude：`claude -p --output-format stream-json --verbose --model haiku`；Codex：`codex exec --json`），不要凭文档猜协议。
3. **测试先行**：回归测试要能在修复前失败；新行为配 unit / integration 测试（工具见「测试」）。
4. **门禁**：`pnpm ci:local`（= `git diff --check` + `pnpm test` + `pnpm typecheck` + `pnpm build`），全绿才算过。
5. **提交**：格式见「提交规范」。
6. **合入与构建**：按 [`docs/dev/ship.md`](docs/dev/ship.md)——ff 合回 main、push origin、在主 checkout 构建、清理 worktree。
7. **汇报**：改了什么、门禁结果（失败就贴失败）、是否需要重启。

## 质量门禁

- 通过标准只有一个：`pnpm ci:local` 全绿。迭代中可以先跑 `npx vitest run <文件或目录>` 缩小范围，但交付前必须跑全量。
- 已知噪声：机器负载高时，spawn 真实子进程的用例（`tests/process/`、`tests/unit/agent/*` 里的 fake binary 读流测试）可能撞 vitest 默认 5s 超时。（`tests/integration/ui/server.test.ts` 曾经偶发的 `4999 >= 5000` 是测试自身的时钟先后问题，已修。）处理方式：单独重跑该文件；必要时在未改动的 main 上跑同一文件对照，确认与本次改动无关，并在汇报里写明。不许把失败说成通过。
- CI（`.github/workflows/ci.yml`）在 macOS / Ubuntu / Windows 三平台跑 test + typecheck + build。Windows 不维护、不阻断（`continue-on-error`，boss 2026-10-13 决定不修）：Windows 上约 40 个存量失败（文件权限位、路径分隔符、本地 git 远端）是已知的，不要去修，新改动也不要求 Windows 通过，Windows 那一列红了不算门禁失败。Windows 上 `claude` 是 `.cmd` shim、经 `cmd.exe` 启动：prompt 和系统提示词不能走 argv（`<` `>` 会被当重定向吃掉），一律走 stdin / 临时文件。
- 发版推 `vX.Y.Z` tag，由 `.github/workflows/release.yml` 复用同一套 CI，过了才建 GitHub Release（正文取 `CHANGELOG.md` 对应段落）；步骤见 [`docs/dev/release.md`](docs/dev/release.md)。改了 `package.json` 的 `version` 就要在 `CHANGELOG.md` 补同版本段落，否则 `tests/unit/docs/release-notes.test.ts` 不过。

## 架构地图

入口 `bin/lark-channel-bridge.mjs` → `dist/cli.js`（`src/cli/index.ts`，commander）。

| 目录 | 职责 |
|---|---|
| `src/cli/` | 宿主 CLI：`run` / `start` / `restart` / `ps` / `profile` / `migrate`，首次 bootstrap、agent 自动检测 |
| `src/runtime/` | profile 运行时装配、`run-executor`（提交 run、`done` 后回收进程）、supervisor、运行锁、在线 bot 注册表、adapter 工厂 |
| `src/agent/` | **agent 注册表 `registry.ts`**、各 agent adapter（`claude/`、`codex/`）、capability、模型目录、preflight、系统提示词 |
| `src/bot/` | 飞书消息入口 `channel.ts`（排队、合并、回复投递）、`run-flow.ts`（策略 + 恢复会话 + 提交 run）、云文档评论、进程池、卡片流 |
| `src/commands/` | 飞书内斜杠命令（`handlers` 表、`ADMIN_COMMANDS` 权限表） |
| `src/card/` | 卡片模板、运行卡渲染、配置卡、卡片回调签名与分发 |
| `src/session/` | per-scope `SessionStore`、`SessionCatalog`（按 scope+agent+cwd+策略指纹）、Claude / Codex 历史读取 |
| `src/policy/` | 访问控制（owner / admin / 名单）、run 策略、策略指纹 |
| `src/config/` | profile schema v2、root config 存取、keystore、v1→v2 迁移 |
| `src/scheduler/`、`src/meeting/`、`src/knowledge/` | 定时任务、会议机器人、跨会话记忆与 skill |
| `src/dream/` | 梦境整理：会话游标账本、输入选择、提案校验、草稿发布（Draft PR）、自动整理门槛、跨 profile 仓库锁 |
| `src/lark-cli/` | 每个 profile 私有的 lark-cli 配置投影与身份策略 |
| `src/ui/` + `web/` | Web 控制台 API（`src/ui`）与 React SPA（`web/`，`pnpm build:web` 产物内联进 `src/ui/generated/`，已 gitignore） |
| `src/daemon/` | launchd / systemd / schtasks 服务定义 |

## 不变量与踩过的坑

- **agent 分支只走注册表。** 共享代码不写 `agentKind === 'codex'` 这类字面判断（隐含的 else 会把新 agent 当成 Claude）。`tests/static/contracts.test.ts` 会拦；只有 agent 自己的代码（`src/agent/`、codex 配置段所在的 `src/config/` / `src/cli/`、`profile-runtime.ts` 里的历史迁移）可以点名某个 agent。
- **一轮在 `done` 结束，进程不一定。** Claude 以 `--input-format stream-json` 运行：一轮结束时没有后台任务，adapter 关闭 stdin，进程自己退出（executor 按 agent 描述里的 `exitGraceMs` 等它退出（Claude 10s——stdin 关闭后即使没有后台任务也要 1–3s 才退出，2s 会误杀；Codex 30s——`turn.completed` 后它还要花 5–15s 写 memories / thread-state 的 sqlite，过早杀会丢 `/resume` 列表等数据），超时才杀；等待只在后台进行，回复在 `done` 时就发出，下一轮也不等旧进程）；还有后台任务（后台 Bash、后台子 agent、Monitor）时进程留着（`ProcessSession` / `RunExecutor` 的 linger，最长 30 分钟），后台任务触发的续跑轮经 `onBackgroundTurn` 作为补充回复发出，期间同一会话的新消息直接 `send` 进这个进程，不重开、不杀后台任务；运行参数（cwd、model、effort、权限、会话）不一致时才停掉重开。`/stop`、`/new`、`/cd` 会连后台任务一起停。Claude `--resume` 时若有上个进程残留的后台任务通知，会先吐一个 `num_turns: 0` 的 `result`——adapter 暂存它，不当成 `done`。相关测试：`tests/integration/executor/background-linger.test.ts`、`tests/unit/agent/claude-stream-json.test.ts`、`tests/process/claude-adapter.test.ts`。
- **Codex 走 `codex app-server`**（`src/agent/codex/app-server-run.ts`）：一个会话一个常驻进程，`send` 即 `turn/start`，`stop` 先 `turn/interrupt`；空闲按 `idleKeepAliveMs`（10 分钟）后 `endInput` 让它退出——这类「空闲保留」不算后台任务（`/status`、`/stop` 回复、重启通知都不提）。app-server 没有 `--ignore-user-config` / `--ignore-rules`，相关 profile（或 `codex.transport: "exec"`）在 `prepareRun` 里退回 `codex exec`；未经 `prepareRun` 的直接调用也走 exec。协议是 experimental，翻译层测试用的是真实抓包 `tests/fixtures/codex-app-server-turns.json`，升级 codex-cli 后先重新抓包核对。
- **用量按人记账**（`usage.json`，`UsageLedger`）：executor 在每轮的 `usage` 事件上记到 `SubmitRunInput.actor` 名下，后台续跑轮记到最近一次提交的人；Claude 的 `total_cost_usd` 是整个会话的累计值——`--resume` 时 Claude 从转录里最后一条 `cost-state` 恢复此前的总额，同一进程内再逐轮累加——adapter 在 spawn 前读出这条 `cost-state` 作为基线（`claude/session-cost.ts`），逐轮相减；Codex 的 `turn.completed.usage` 是整个 thread 的累计值，adapter 在 `prepareRun` 里从该 thread 的 rollout（`token_count`）读出此前的累计作为基线再相减；`inputTokens` 一律含缓存部分。`/usage` 只有管理员私聊才显示所有人。
- **非管理员的操作审批**（#6，默认关闭，profile 设 `approvals.enabled: true` 才开）：开启时批次里有非管理员的消息即为 gated run（`SubmitRunInput.gate`）。`ApprovalBroker` 管理待审批项（5 分钟超时拒绝，只有管理员能允许、发起人可取消，「本轮都允许」到下一轮失效），`ApprovalNotifier` 把卡片发给主人和管理员私聊、给发起人发等待卡（按钮走 `/approval` 命令）。Claude 用 PreToolUse hook：`bin/approval-hook.mjs` 经 profile 目录下的 `approval.sock`（`ApprovalSocketServer`）问 broker，连不上一律拒绝；hook 设置不了时退回 plan（只读）。Codex app-server 用 `approvalPolicy: untrusted` + 只读沙箱，审批请求交给 `RunApprovals.decide`；exec 兜底只读。gated 与非 gated 的轮次不共用进程（compat key）。只读工具白名单在 `approvals.ts` 的 `READ_ONLY_TOOLS`，其余（Bash、写文件、`mcp__*`…）都要审批。profile 的 `approvals` 配置段：`enabled` 只有显式 `true` 才开（`runNeedsApproval` 是判定是否 gated 的唯一入口，IM 与云文档评论共用），`allowCommands` / `allowTools` 是免审批清单（broker 每次请求现读，按词前缀 / `*` 匹配，`;`、重定向、命令替换照样要审批）。Codex 的审批请求把命令包成 `/bin/zsh -lc "…"`，判定前先用 `unwrapShellCommand` 取出里面的脚本。审计写 `audit.jsonl`（追加、0600、保留 90 天），`/audit` 仅管理员私聊。`/config` 的「非管理员操作审批」（`approvals_enabled`）只改 `enabled`、即时生效，清单只在配置文件里改。写 config.json 一律经 `serializeProfileConfig` 的字段白名单，profile 新增配置段要同时加进去（漏过 `approvals`：每次保存都把审批删掉）。
- **会话智能压缩**（`preferences.smartSession`，默认关，`/config` 可切）：新消息续用旧会话前，`run-flow` 用 agent 的会话探测（`src/agent/session-probe.ts`，从转录 / rollout 末尾读上次模型调用的时间和上下文大小）判定是否归档后开新会话（空闲 + 大上下文、长时间空闲、或上一轮回复末尾带 `[[NEW_SESSION: 摘要]]`），新会话首轮带 `<session_handoff>`；标记经 `stripControlMarkers` 从回复里去掉。标记请求落盘在 `pending-rotations.json`（`PendingRotationStore`，重启不丢），并记下它要关闭的会话句柄——下一条消息要续用的不是那个会话（中途 `/new`、`/resume`、`/cd`）就作废。**scope 还有活进程（后台任务 linger / 空闲保留）时不轮换**——executor 对不带会话句柄的提交会直接复用那个进程，轮换不但无效还会掐断后台任务；用户引用回复时也不轮换。压缩窗口经 `AgentRunOptions.compactWindowTokens` 下发，Claude 用 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`，Codex 的 app-server / exec 都用 `-c model_auto_compact_token_limit=…`（真实 `config/read` 探针见 `tests/fixtures/codex-app-server-compaction-config.json`）；关闭时保留 CLI 原生默认压缩策略。
- **Worktree 自动清理**（`preferences.autoWorktreeCleanup`，默认关，`/config` / Web 可切）：`WorkspaceStore.managedWorktrees` 只登记 `/worktree add` 创建的目录和分支所有权；`src/git/worktree-cleanup.ts` 每小时检查，默认闲置 7 天（`worktreeCleanupIdleDays`）。仅处理干净、无未跟踪/忽略文件、已合入默认本地分支、无跨 profile 工作区/定时任务引用的 worktree；主目录、锁定/分离 HEAD/切换分支目录不动，有任务/保留进程或保护信息读取失败就延后。移除不用 force；只删除新建分支，带预期提交号校验。disconnect 停定时器并等待当前检查结束；关闭开关在删除前再次检查。新增清理范围必须显式登记，不能扫描宿主的任意 worktree 自动纳入。
- **群聊 / 话题上下文**（`src/bot/chat-context.ts`）：飞书只推 @ bot 的群消息，所以群里每次开跑前用 `im.v1.message.list` 把 bot 没收到过的消息读回来，作为 `<chat_context>` 注入（系统提示词里有说明）。`planChatContext` 决定读哪段：scope 有游标就只读游标之后（`catch_up`，去掉 bot 自己的回复——list 接口里 bot 消息的 sender 是 app_id，按 `accounts.app.id` 比对）；没有游标也没有会话时，话题读整个话题（`topic_history`），普通群读最近 12 小时（`recent`）；有会话没游标（功能上线前的老会话）跳过一次。游标是该 scope 最近一批被接受的消息的 `createTime`，提交 run 成功后才前移，落盘在 `chat-context-cursors.json`（`ChatContextCursorStore`）。读取失败只记日志、不挡 run。thread 容器不支持 `start_time` / `end_time`，按时间过滤一律在本地再做一遍。
- **长任务完成提醒**（`src/bot/long-run-notice.ts`，`preferences.longRunNoticeMinutes`，默认 5，`0` 关）：飞书不推送消息更新，原地更新的回复卡在长任务结束时不会响。`runAgentBatch` 从提交 run（`runSubmittedAt`，含并发排队）计时，`finally` 里交给 `planLongRunNotice`：`done` / `error` / `idle_timeout` 才发，`interrupted` 不发；群里 @ 批次里的真人（`senderTypeOf === 'user'`，绝不 @ 机器人——会唤醒对方形成循环），私聊只在答案落在进度卡里（`answerIsNewMessage === false`）时发。发送失败只记日志。
- **共享 skill 库**（`src/knowledge/libraries.ts`，profile 配置的 `skills.libraries`）：每个库是 `skill-libraries/<name>/` 下的只读镜像，同步 = `fetch --depth 1 <ref|HEAD>` + `checkout --force --detach FETCH_HEAD` + `clean -fdx`，从不合并；首次拉取在 `<name>.tmp-*` 里做完再改名，启动时清掉残留的临时目录和配置里已没有的库的镜像（`sweepStale`）。`KnowledgeStore.addSkillSource` 把库的 skill 并在本 profile 自己的后面（同名先到先得），所以注入、`/skills`、定时任务拿到的是同一份索引；索引条目带 `source`，描述截到 240 字、整份索引有字数预算。扫描只认真实目录，`SKILL.md` 的 realpath 必须在镜像内（索引里的路径会交给 agent 去读）。`/skills lib` 是管理员命令（在 `handleSkills` 里单独校验，`/skills` 本身对所有人开放）；`add` 先拉取成功再写配置。写配置走 `config-ops.saveSkillsConfig`，`serializeProfileConfig` 已带上 `skills` 段。启动同步一次，之后按 `syncIntervalMinutes`（默认 60），改了间隔调 `reschedule()` 让正在等的那段立即按新值重排；disconnect 只给在途 fetch 5 秒。
- **知识库自动同步**（`src/knowledge/auto-sync.ts`，profile 配置的 `knowledge.syncIntervalMinutes`，默认 30，`0` 关）：知识目录是自己的 git 仓库（顶层就是该目录，嵌在别的仓库里的子目录不算）且有 `origin` 才同步，启动后 15 秒一轮、之后按间隔，每轮现读间隔。`sync.ts` 里 `bind` / `unbind` / `syncKnowledge` 都经 `serialized` 按目录排队，手动 `/knowledge sync` 赶上自动那轮就等它结束再完整跑一轮（不复用结果——它要带上期间写入的记忆）。`syncKnowledge` = 补 `.gitattributes`（`MEMORY.md` / `chats/*.md` `merge=union`）并**单独提交** → `commitAll` → `pull --rebase --autostash`（失败 `rebase --abort`）→ push，push 因对方刚推被拒时重拉重推一次；目录里有未完成的 merge / rebase / cherry-pick 时拒绝同步。union 只认工作区里已有的 `.gitattributes`：和冲突的追加放在同一个提交里，rebase 照样冲突（测试 `unions memory files when a bot that has no .gitattributes yet pushed first`）。失败每次 `log.warn`，连续第 2 轮自动同步失败时私聊主人一次（`controls.botOwnerId`，`channel.send(ou_*)`，取不到只记日志），恢复后补一句；手动同步的失败不计入、成功清零。改了间隔调 `reschedule()`（正在跑的那轮结束后自然按新值排，`0` → 正数也能重新起表）。disconnect 只给在途同步 5 秒。
- **Web 控制台的 skill 库 / 知识库**（`src/ui/knowledge.ts`，`/api/skills`、`/api/knowledge`）：库的增删同步与 `/skills lib` 共用 `buildLibraryConfig` 校验，知识库的 bind / unbind / sync 走 `sync.ts` 同一套函数，写配置走 `saveSkillsConfig` / `saveKnowledgeConfig`。目标 profile 由控制台托管（live）时用它的 `controls`（库管理器、`KnowledgeStore`、自动同步），改完间隔即时 `reschedule`；不是（本机 CC / Poki 是各自的 daemon）就只写配置、在磁盘上直接做 git 操作，非 live profile 的库管理器按镜像目录缓存在模块里（保留上次同步结果、并发拉取去重）。两个进程同时动同一个知识目录没有跨进程锁，最坏是一方撞 git lock / 未完成的 rebase 报错，下一轮自愈。
- **梦境整理**（`src/dream/`，`preferences.dream`，默认关，`/config` / Web 可切；#10）：手动触发（`/dream run`、Web 卡片）或自动整理（见下一条），`/dream` 是管理员命令且只在私聊可用。输入只来自 bridge 自己跑过的会话：`SessionCatalog.onUpsert` 把每个会话句柄记进 `dream-state.json`（catalog 每个身份只留最新会话，被替换掉的要靠这份账本），读取走 `src/agent/session-transcript.ts` 的注册表（Claude 转录 / Codex rollout，按句柄定位，不扫描），`cron:` / `meeting:` / `comment:` / `dream:` scope 不读。每个会话范围一次只读 run（`evaluateRunPolicy` 强制 read-only，结果不是 sandbox read-only + plan 就不跑；`nowait` 提交、跑完 `closeIdleScope`）。模型输出只是建议，`proposal.ts` 逐条校验来源 / 记忆 id / 凭证 / skill 名，`profile` 目标必须有管理员单独直接发言做来源，否则降为 chat；路径只由 `publish.ts` 按 scope + slug 推出、限定白名单。发布 = 新 clone → `dream/<批次>` 一次提交（关 hooks）→ 推新分支 → `gh pr create --draft`，不 force、不碰默认分支、从不合并；无写权限 / 固定 tag 或提交的库记为 skipped，`gh` 不可用留 `committed` / `pushed` 下轮续做。一轮分两段：所有目标先本地提交，全部成功才 `state.checkpoint`（一次写入里前移游标、标记候选已提、记 `checkpointAt`）；检查点之前任何失败 / 取消 / 抢占都 `discardDrafts` 整批作废（目标记 failed、去掉提交），不留半批；检查点之后才 push / 开 PR，中断了由下一轮 `resumePendingTargets` 续做、绝不重做。关开关在发布前会再查一次。每轮开始前按目标仓库的规范化远端（`canonicalRepoId`）在 `registry/locks`（`appPaths.userLockDir`，跨 profile 共享）拿 `proper-lockfile` 锁，拿不全就整轮不跑（`code: 'locked'`），CC 和 Poki 绑同一个库时靠它互斥。`/dream revert <批次>`：`gh pr view` 看合并状态，已合并的在 `reverts/<批次>/` 从默认分支新拉、`dream/<批次>-revert` 分支上 `git revert`（合并提交加 `-m 1`）后开 Draft PR，未合并的只提示去关 PR。
- **自动整理**（`preferences.dreamAuto`，默认关，`/config` / Web 可切，`dream` 也开着才生效；门槛在 `preferences.dreamTuning`，只能改配置文件）：不是定时任务，是「攒够了才做梦」。`DreamService` 每 `autoCheckMs`（30 分钟）跑一次 `checkAuto`，门槛按顺序：先 `schedule.ts` 的 `cheapDreamGate`（连续失败暂停 → 允许时段 → 本时段已跑过 → 失败退避 → 最短间隔），再 `isProfileBusy`（`channel.ts` 注入：有非 `dream:` 的活跃 / 保留 run 或排队消息）、最近 `minIdleMinutes` 内有对话、无远端、只读策略探测不过、材料（`measureNewInput` + `materialGate`，超过 `maxIntervalDays` 有新内容就够）、待审 PR（每个目标仓库 `gh` 数开着的 `dream/*` PR，数不到就用本地未发布草稿）、额度（`src/agent/quota.ts` 注册表：Claude `claude -p /usage`、Codex app-server `account/rateLimits/read`；只读，**绝不调用 reset credit**；读不到按 0.5 预算），开跑前再查一次 busy。每次检查只在结论变化时写进 `dream-state.json` 的 `auto.lastCheck`，`/dream` 和 Web 据此说明「为什么没跑」。自动 run 在检查点前让位给用户：`intakeMessage` 收到新消息调 `preempt`，另有 `watchdogMs` 看门狗；手动 run 不让位。失败（failed，或有输入却 deferred）计 `consecutiveFailures`，从第 2 次起退避 2^(n−1) 天，满 `maxAutoFailures` 暂停，任何成功的 run（含手动）清零。自动整理默认**不发任何消息**，结果只在状态里；配了 `dreamTuning.notifyChat` 才把每轮结果发到那个会话。
- **每日模式 / 课前学习 / 直推**（`preferences.dreamTuning` 的 `dailyAt` / `externalLibraries` / `publish: "push"` / `requireArgumentHint` / `quotaWindow` / `notifyChat` / `localSkillDirs`，都默认关）：`dailyAt` 让自动整理每天定时跑——时段变成 `dailyAt` 起 3 小时（`DREAM_DAILY_WINDOW_MINUTES`），`DreamService.armDaily` 另挂一个准点定时器，跳过最短间隔、材料、（直推时的）待审 PR 三道门；`quotaWindow: "week"` 让额度门只看「本周」窗口，每日模式额度超限时当天记为已跑、`notifyChat` 只通知一次。每轮先做课前学习（`external.ts`）：外部库浅克隆到 `dream/external/<name>`（只读、从不推送），按 `dream-state.json` 的 `external.<name>` 游标取变更的 Markdown（首次全量，超出 `maxInputChars / 2` 的留 `pending` 下轮），连同自己 skill 库的技能全文、缺 `argument-hint` 的名单、本机已装技能名（`localSkillDirs`）交给一次只读 run；外部内容只能写成 `notes/external/<topic>.md`（不进全局记忆，防外部注入），技能只能新建或更新自己库（`dreamTuning.skillLibrary`）里的，本机已有同名技能不新建；`requireArgumentHint` 时所有 skill 提案必须带 `argument-hint`。外部库游标随检查点前移，学习失败不动。`publish: "push"`：`prepareCheckout(..., { direct: true })` 不开分支，直接在默认分支提交（连同 `CHANGELOG.md` 一条，最新在前），检查点后 `pushDirect` 推默认分支，被拒时 fetch + rebase 一次再推、冲突留待下轮，从不 force；成功后 `afterPublish` 立即 `syncKnowledge` / 同步 skill 库镜像。`skillUpdates: "pr"`（默认随 `publish`）时只有新建的技能直推，修改已有技能的提案单独成一个目标（repo `skills:<库>:update`）走 `dream/<批次>` 分支 + Draft PR、不写 CHANGELOG；该库还有没审完的 `dream/*` PR（≥ `maxOpenPrs`）时这批修改记为 skipped、不标记已提，之后重新提出。知识注入多了 `notes` 索引（`external/` 加本会话的笔记，只有路径）。
- **过载保护**（`preferences.botOverload`，`chats` 为空即关、`["*"]` 为所有群，只能改配置文件）：列出的群里，一个批次全是 bot 发的消息（`senderTypeOf === 'bot'`，有真人就照常）时，`runAgentBatch` 开头先经 `BotOverloadGuard`（`src/bot/bot-overload.ts`）读额度（`readAgentQuota`，缓存 5 分钟）：本周窗口已用超过 `weekPercent` 且距重置超过 `weekGraceHours`，或 5 小时窗口超过 `sessionPercent` 且距重置超过 `sessionGraceHours`，就不跑模型，回复一张 `overloadCard`（开头 @ 提问 bot 的主人再加「等 ALL」——主人查 `botOwners` 映射表（bot 的 open_id / app id → 主人 open_id，`botOwnersOf`），查不到就只写「等 ALL」；绝不 @ bot，防互相唤醒）；同一个群 `cooldownMinutes` 内只发一张，其余静默丢弃。读不到额度一律放行。白名单：`exceptChats` 里的群不拦；批次里有 `exceptBots`（bot 的 open_id 或 app id，与 `senderId` 及原始事件的 `sender_id.open_id / app_id` 比对）发来的消息也不拦。
- **排队中的消息落盘**（`pending.json`，`PendingStore`）：重启 / 重连后 10 分钟内的自动补处理，更早的回一条通知请对方重发；重启时被停掉的后台任务也会在会话里说明。
- **新增斜杠命令要过三处**：`handlers` 表；是否进 `ADMIN_COMMANDS`；帮助卡（`src/card/templates.ts`）。别名（如 `/reset` 之于 `/new`）的权限要和本名一致：本名进了权限表，别名也要进，否则就是绕过。卡片按钮走 `runCommandHandler`，同样受管理员检查。
- **流式卡片收尾失败要补发答案**：SDK 的流式卡片中途更新失败只会变成 unhandledRejection，最后一次更新失败才让 `stream()` 报错——此时卡片停在半路、答案没上屏（长任务的工具面板常让飞书以 230099 拒卡：表格数超限 / 卡片生成失败）。`awaitRenderAwareStream` 的 `rescue` 负责补发：卡片模式只发答案本身，依次试原卡片原地更新 → 新卡片 → 纯 post；markdown 模式直接发 post。Codex（答案本来就单独发）不走 rescue；`target_revoked`（被回答的消息已撤回）不补发。测试：`tests/integration/bot/markdown-stream-startup-failure.test.ts`。
- **飞书审核**：消息可能被审核拒（错误码 230028），`reply()` 会退回一句中性文案；卡片里不要放完整邮箱（会被拒），账号只显示 `@` 前的用户名。
- **持久化状态**一律 `writeFileAtomic` + `mode: 0o600`（契约测试守护）。
- **测试隔离**：`tests/setup/clear-bridge-env.ts` 会清掉 `LARK_CHANNEL*` / `LARKSUITE_CLI_CONFIG_DIR`。在 bridge 会话里跑测试时别依赖真实 profile；读宿主配置的代码要显式置空这些变量，不要继承父进程。
- **共享 bot / card / commands 代码不 import `agent/codex` 内部**（契约测试），需要 agent 相关能力走 `src/agent/` 的中立出口。

## 新增一种 agent

注册表 `src/agent/registry.ts` 是唯一名单。步骤：

1. `AGENT_KINDS` 追加 id，`AGENT_DESCRIPTORS` 补描述（字段含义见类型注释：会话句柄、是否写 scope SessionStore、回复投递方式、图片参数、权限模型、系统提示词注入方式等）。
2. 跑 `pnpm typecheck`，编译器会逐个列出还缺条目的 `Record<AgentKind, …>`，目前是：
   - `src/runtime/agent-runtime.ts` → `ADAPTER_FACTORIES`（构造 adapter）
   - `src/agent/models.ts` → `MODEL_CATALOGS`（模型 / effort 选项、实际模型名展示）
   - `src/agent/account.ts` → `ACCOUNT_NAMES`（回复卡 Sponsor）
   - `src/commands/index.ts` → `RESUME_LISTS`（`/resume` 列表）
3. 新建 `src/agent/<id>/adapter.ts` 实现 `AgentAdapter`（`src/agent/types.ts`）：spawn CLI、prompt 走 stdin、按行解析输出并翻译成 `AgentEvent`；每轮结束恰好一个 `done`（或 `error`），`system` / `done` 事件带上描述里声明的会话句柄字段；实现 `waitForExit` 与带宽限期的 `stop`。
4. 测试：真实输出抓样本 → translator 单测；fake binary 读流测试（参照 `tests/unit/agent/claude-stream-json.test.ts`）；进程级契约测试（参照 `tests/process/`）。
5. 如果新 agent 需要自己的配置段（像 `codex.binaryPath`），在 `src/config/profile-schema.ts` 加类型、校验和默认值，bootstrap 在 `src/cli/profile-bootstrap.ts`。
6. Web 控制台的 agent 选择框和 effort 提示从后端读（`/api/onboard/state` 的 `agents`、配置里的 `effortHint`），不用改前端。

## 测试

- 分层：`tests/unit/`（纯逻辑）、`tests/integration/`（命令 / 消息流 / 存储，走 fake channel 与 fake agent）、`tests/process/`（真实 spawn 的 adapter 契约）、`tests/static/`（架构契约）。
- 常用工具（`tests/helpers/`）：`createFakeChannel`（记录发出的消息 / 卡片）、`createFakeAgent`（脚本化事件流）、`createTmpProfile`（临时 profile 目录）、`fake-executable`（假 CLI 二进制）。命令类测试照 `tests/integration/commands/commands-v1.test.ts` 的 harness 写。
- 断言用户可见文案时只断言关键短语，避免把整句文案钉死。

## 提交规范

```
<type>(<scope>): <中文一句话说明改了什么>

- 为什么改 / 修的是什么现象
- 关键实现取舍
- 新增或调整的测试
```

`type` 用 `feat` / `fix` / `refactor` / `test` / `docs` / `chore`；`scope` 取主要模块（`commands`、`claude`、`card`、`agent`、`preflight`…）。一个提交只做一件事。

## 运行时排查

- 在线 bot：`lark-channel-bridge ps`；单个 profile：`lark-channel-bridge status --profile <name>`。
- 日志：`~/.lark-channel/profiles/<profile>/logs/daemon/daemon-{stdout,stderr}.log`（人读）与 `logs/bridge-YYYYMMDD.jsonl`（结构化，按 `runId` / `traceId` 串起一轮）。
- Claude 会话转录：`~/.claude/projects/<cwd 编码>/<sessionId>.jsonl`，默认工作目录的会话在 `-Users-mac--lark-channel-workspaces-<profile>-default/` 下，`/cd` 过的在对应 cwd 的目录下。排查「消息被吞」「回复为空」先看这里的 `queue-operation` 与 assistant 记录。
- Codex 会话记录：`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`（`codex` profile 继承本机 `~/.codex`），按 thread id 找对应文件。

## 两种 agent 各自的入口

| | Claude Code（CC） | Codex（Poki） |
|---|---|---|
| 自动加载的约定 | `CLAUDE.md` → 导入本文件 | 本文件 |
| 交付 / 重启 / 发版 | `/ship`、`/restart-bridge`、`/release`（`.claude/commands/`，内容指向 `docs/dev/`） | 直接按 `docs/dev/ship.md`、`docs/dev/restart-bridge.md`、`docs/dev/release.md` 执行 |
| 权限护栏 | `.claude/settings.json` 的 deny 列表 | 无对应配置，按本文件「仓库边界」自律 |

改动约定时两边都要能用：不写只有一种 agent 才看得懂的步骤（例如只给 slash command 不给文档），新增操作流程先写 `docs/dev/`，需要的话再给 `.claude/commands/` 加一个指向它的入口。
