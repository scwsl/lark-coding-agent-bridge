# lark-channel-bridge

把飞书 / Lark 消息和本地 Claude Code 或 Codex CLI 打通的轻量 bot。用一条命令启动，扫码绑定 PersonalAgent 应用，然后在飞书里和本机编程助手对话，让它读图、处理文件、改代码。

[English README](./README.md)

关于能实现的效果，详情可以阅读[飞书文档](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e)

## 主要功能

- 在飞书私聊直接发消息，或在群里 `@bot`，把任务转给本机 Claude Code / Codex CLI。
- **流式卡片**：文本回复和工具调用实时更新在同一张卡片上。
- **COT 过程消息**：可选先发一条过程消息展示 agent 的阶段性文本和工具调用，再单独发送最终答案。
- **会话延续**：每个聊天、话题或文档评论有自己的会话，不会互相串。
- **排队与消息合并**：短时间连续发送的消息会合并处理；任务运行中收到的普通消息会排队到下一轮，`/new`、`/cd`、`/ws use`、`/stop` 这类命令可以中断当前任务。
- **多工作空间**：用 `/cd` 切换当前项目，用 `/ws` 保存和复用常用项目目录。
- **图片 / 文件**：直接发给 bot，bridge 下载到本地后交给本机 agent 处理。
- **卡片按钮**：`/help`、`/ws list`、`/status` 返回可点击的交互卡片。

## 前置条件

- Node.js **>= 20.12.0**
- 本机至少安装并登录一个 agent：
  - Claude Code：`claude`，安装说明：https://docs.anthropic.com/en/docs/claude-code/quickstart
  - Codex CLI：`codex`，安装说明：https://developers.openai.com/codex/cli
- 一个飞书 / Lark PersonalAgent 应用。首次启动的扫码向导可以帮你创建并绑定。

## 安装（本 fork：源码构建 + npm link）

本仓库是 [`mirsery/lark-coding-agent-bridge`](https://github.com/mirsery/lark-coding-agent-bridge) 的定制 fork，包含卡片 Sponsor 署名、任务面板、联调帮助分组等 npm 包里没有的改动。**不要用 `npm i -g lark-channel-bridge` 安装**，否则跑的是上游发布版，本 fork 的改动全部不生效。

```bash
git clone git@github.com:mirsery/lark-coding-agent-bridge.git ~/workspace/lark-coding-agent-bridge
cd ~/workspace/lark-coding-agent-bridge
pnpm install        # prepare 脚本会顺带执行一次 build
pnpm build          # 构建 web 控制台 + dist/
npm link            # 全局 lark-channel-bridge 软链到本仓库
```

确认全局命令指向本仓库，而不是 npm 安装版：

```bash
readlink -f "$(command -v lark-channel-bridge)"
# 期望输出：~/workspace/lark-coding-agent-bridge/bin/lark-channel-bridge.mjs
```

> 如果用 nvm 管理 Node，`npm link` 装在当前 Node 版本的全局目录下。切换 Node 版本后需要重新 `npm link`，并同步更新 launchd plist 里的 node 路径。

## 首次启动

首次绑定 PersonalAgent 应用时在前台跑，并显式指定 profile 和 agent：

```bash
lark-channel-bridge run --profile claude --agent claude
```

第一次运行会进入扫码向导：

1. 终端渲染二维码。
2. 用飞书 App 扫码。
3. 选择或创建 PersonalAgent 应用。
4. 成功后配置写入 `~/.lark-channel/config.json`。

如果已经有 PersonalAgent app，可以加 `--app-id cli_xxx` 跳过创建应用流程，命令会提示输入 App Secret。Lark 国际版应用加 `--tenant lark`。

确认能在飞书里正常收发消息后，`Ctrl-C` 停掉前台进程，改用下面的后台服务。

## 本机启动方式

本机常驻两个 launchd 用户服务，都随登录自动启动，并由 `KeepAlive` 保活：

| launchd Label | 启动命令 | 作用 |
|---|---|---|
| `ai.lark-channel-bridge.bot.claude` | `lark-channel-bridge run --profile claude` | 飞书 bot「CC」，接 Claude Code |
| `ai.lark-channel-bridge.bot.supervisor` | `lark-channel-bridge run --web-ui` | 本地 web 控制台 |

两个服务都设置了 `LARK_CHANNEL_HOME=~/.lark-channel`，PATH 里带上 nvm 的 Node bin 目录。

首次安装服务：

```bash
lark-channel-bridge start --profile claude   # 生成并加载 ai.lark-channel-bridge.bot.claude
lark-channel-bridge start --web-ui           # 生成并加载 ai.lark-channel-bridge.bot.supervisor
```

日常查看与启停：

```bash
lark-channel-bridge status --profile claude
lark-channel-bridge restart --profile claude
lark-channel-bridge stop --profile claude
```

控制台端口每次启动随机分配，地址（含 token）记录在 `~/.lark-channel/ui.json`。用 `ui` 命令打开或打印：

```bash
lark-channel-bridge ui           # 在浏览器打开控制台
lark-channel-bridge ui --print   # 只打印地址
```

注意：`claude` profile 由自己的 per-profile daemon 托管，控制台拿不到它的运行锁，可能会把它显示为未运行。以 `status --profile claude` 和飞书实际收发为准，详见下文「Web 控制台」。

### 改代码后生效

daemon 只在启动时加载一次 `dist/`，改了源码必须先构建再重启：

```bash
cd ~/workspace/lark-coding-agent-bridge
pnpm build
lark-channel-bridge restart --profile claude
lark-channel-bridge status --profile claude
```

判断正在运行的 daemon 是否落后于代码：比较 `git log -1 --format=%ci` 和 `ls -la dist/cli.js` 的时间，构建早于最新提交就说明没生效。重启会让 bot 断线几秒，挑没有任务在跑的时候做，可以先在飞书发 `/show-tasks` 确认。

### 日志与数据

- bot 日志：`~/.lark-channel/profiles/claude/logs/daemon/daemon-{stdout,stderr}.log`
- 控制台日志：`~/.lark-channel/profiles/supervisor/logs/daemon/`
- 结构化日志：`~/.lark-channel/profiles/claude/logs/bridge-YYYYMMDD.jsonl`
- 会话与运行中任务：`~/.lark-channel/profiles/claude/sessions.json`、`runs.json`

## 后台运行

`run` 适合首次配置和前台调试。确认 bot 能正常收发消息后，先用 `Ctrl-C` 停掉前台进程，再用系统服务常驻后台：

```bash
lark-channel-bridge start
lark-channel-bridge status
lark-channel-bridge stop
```

服务层命令必须先全局安装，不能直接用 `npx`。daemon 的 launchd plist / systemd unit / Windows 任务会记录 bridge CLI 的路径；如果这个路径来自 npm 临时缓存，缓存清掉后 daemon 就起不来。`run` 用 `npx` 单次启动没问题。

服务层命令按 profile 注册，每个 profile 有独立服务：

```bash
lark-channel-bridge start [--profile <name>]
lark-channel-bridge stop [--profile <name>]
lark-channel-bridge restart [--profile <name>]
lark-channel-bridge status [--profile <name>]
lark-channel-bridge unregister [--profile <name>]
```

平台映射：
- **macOS**：launchd 用户代理 `ai.lark-channel-bridge.bot.<profile>`
- **Linux**：systemd 用户单元 `lark-channel-bridge.bot.<profile>.service`
- **Windows**：Task Scheduler 任务 `LarkChannelBridge.Bot.<profile>`，launcher 是 `.cmd`

daemon 日志在 `~/.lark-channel/profiles/<profile>/logs/daemon/`。

### 终端实时面板

在宿主机终端查看 bot 工作状态、当前任务、执行阶段和耗时，以及 CPU、内存、磁盘可用空间与运行时间。无需打开浏览器，支持 macOS 默认终端和 iTerm2。

![终端实时面板实际运行截图](docs/images/terminal-monitor.png)

```bash
lark-channel-bridge monitor --interval 5
lark-channel-bridge monitor --profile codex --interval 5
lark-channel-bridge monitor --once
lark-channel-bridge monitor --json
```

上面的示例每 5 秒刷新一次；省略 `--interval` 时默认每 2 秒刷新。

macOS 额外展示物理磁盘读写速率和物理网卡下载/上传速率，按采样间隔差值计算，排除回环和隧道重复计数；首轮采样或采集失败显示 `—`，I/O 采样最多每 5 秒一次。

macOS 上安装 `osx-cpu-temp`（`brew install osx-cpu-temp`）后，面板还会显示 CPU 温度 `TEMP`，最多每 5 秒采集一次；未安装、传感器不支持或采集失败时显示 `—`。无需 sudo。

布局随窗口尺寸调整：宽屏双列展示 bot，普通窗口纵向排列，窄窗口拆分宿主机指标；缩放窗口会立即重新排版。

每项任务右侧展示群名（或私聊）和发起人姓名，窄屏时另起一行。名称在任务启动时记录，刷新不调用飞书接口；旧任务或未解析到的名称显示待同步。升级后需重启 bridge 才开始记录新任务的来源。

正在工作的 bot 优先显示，长任务摘要会折行，长链接缩为末段标识。按 `q` 退出、空格暂停、`r` 刷新。`--interval <秒>` 支持 0.5–60 秒，`--no-color` 禁用配色。非交互终端自动输出一次快照，`--json` 提供完整状态。

面板只读取本机状态，无需重启 bot。CPU 根据相邻采样计算，首次显示等待；RAM 为非空闲内存，包含系统缓存。磁盘统计缓存 30 秒，未变化的日志复用解析结果，每次最多读取 256 KiB 日志尾部。任务阶段来自实际日志，不估算完成百分比；退出或过期的任务会标记为已中断。

### Web 控制台（`--web-ui`）

`--web-ui` 是上面单 profile 后台服务的**替代方案**，不是可以叠加使用的附加项。给 `start` 加上它，会启动一个"全机唯一"的 supervisor 进程，统一托管所有 profile，并提供本地 web 控制台来启动/停止/配置它们：

```bash
lark-channel-bridge start --web-ui
```

同一台机器上，两种模式二选一：
- **单 profile 后台服务**（`start [--profile <name>]`，不带 `--web-ui`）——就是上面几条命令建立的方式，没有 web 控制台。
- **Supervisor 控制台**（`start --web-ui`）——一个进程托管所有 profile，控制台展示的状态直接来自这个进程自身。

⚠️ **不要对同一个 profile 同时用这两种方式。** 如果某个 profile 已经有单 profile 后台服务在跑，这时又单独起了 `run --web-ui` / `start --web-ui`，控制台会尝试去接管这个 profile，但拿不到它的 runtime lock（已经被前一个进程持有），于是静默失败并把它显示为**未运行**——即便原来那个 daemon 其实还活着、还在正常收发消息。控制台目前只能感知自己托管的 profile，感知不到被其他进程保活的 profile。想用控制台的话，先停掉单 profile 后台服务（`lark-channel-bridge stop --profile <name>`），再让控制台来接管启动。

### 多 profile：分别运行 Claude 和 Codex

默认情况下，bridge 使用当前激活的 profile；可以通过 `profile use <name>` 切换。每个 profile 会维护独立的应用凭据、会话、工作目录和日志。只有在需要同时连接多个 PersonalAgent 应用，或分别运行 Claude 和 Codex 时，才需要创建多个 profile：

```bash
lark-channel-bridge start --profile claude --agent claude
lark-channel-bridge start --profile codex --agent codex
```

例如只重启 Codex bot：

```bash
lark-channel-bridge restart --profile codex
lark-channel-bridge status --profile codex
```

#### 用已有机器人新建 profile

如果机器人已经在飞书 / Lark 开放平台建好了（不走扫码创建），用它的 App ID 建 profile，再作为后台服务启动：

```bash
# 1. 先登录 agent CLI（以 Codex 为例；Claude 用 claude 自己的登录）
codex login --device-auth

# 2. 用已有应用建 profile。不要写 --app-secret：
#    命令会提示输入，Secret 不会留在 shell 历史里
lark-channel-bridge profile create codex \
  --agent codex \
  --app-id cli_xxxxxxxxxxxx \
  --workspace ~/workspace

# 3. 以系统托管的后台服务启动（登录后自启）
lark-channel-bridge start --profile codex

# 4. 查看状态
lark-channel-bridge status --profile codex
lark-channel-bridge profile list
```

执行第 2 步之前，先在开放平台确认：

- 已开启 **机器人** 能力。
- **事件订阅** 选 **长连接**，并订阅「接收消息」（`im.message.receive_v1`），否则机器人收不到任何消息。
- 这个应用 **没有被别的 profile 占用**。一个应用接两个 profile，两边会消费同一批事件，同一条消息会被回复两次。

Lark 国际版应用加 `--tenant lark`。日常管理和其他 profile 一样：`restart` / `stop --profile codex`，或用 `lark-channel-bridge ui` 打开网页控制台。

Codex 默认通过 `codex app-server` 运行：同一会话的后续消息交给已经启动的 Codex 进程，不用每条消息重新启动；进程空闲 10 分钟后自动关闭，`/stop` 通过协议干净地中断当前这一轮。profile 开启了 `ignoreUserConfig`，或者要靠 `ignoreRules` 挡住的 execpolicy `.rules` 文件存在时，会自动改用每条消息一个 `codex exec` 进程；也可以在 profile 的 `codex` 配置里写 `"transport": "exec"` 强制使用。

### 重启 `npm link` 出来的本地开发副本

如果 `PATH` 里的 `lark-channel-bridge` 是 `npm link` 到本仓库某个本地 checkout 的（`npm ls -g lark-channel-bridge` 显示的是软链到仓库目录，而不是一个带版本号的 npm 安装），那正在跑的 daemon 只反映它**启动那一刻** `dist/` 里的内容——Node 进程启动时把编译好的 JS 一次性加载进内存，不会热更新。之后改源码、甚至跑了 `pnpm build`，对这个已经在跑的 daemon 都不生效。

```bash
pnpm build                                    # 用当前源码重新编译 dist/
lark-channel-bridge restart --profile <name>  # 让正在跑的 daemon 重新加载
lark-channel-bridge status --profile <name>   # 确认起来了
```

最容易踩的坑是漏掉 `pnpm build` 这一步——单独跑 `restart` 只是拿磁盘上现成的 `dist/` 重新拉起 daemon，如果忘了先编译，加载的还是旧代码，而且不会报错提示你。想不重启就先确认是否过期：对比 `git log -1`（最新 commit 时间）和 `ls -la dist/cli.js`（上次编译时间）——编译时间早于最新 commit，说明该重启了。重启会让 daemon 的在线连接断几秒，launchd/systemd 服务里的 `KeepAlive` 会自动拉起，但最好挑一个手头没有任务正在进行的时间点执行。

## 命令速查

### 宿主 CLI

```text
lark-channel-bridge run [--profile <name>] [--agent claude|codex] [--workspace <path>] [-c <config>]
lark-channel-bridge migrate [--profile <name>] [--agent claude|codex]
lark-channel-bridge ps
lark-channel-bridge kill <id|#>
lark-channel-bridge --help
```

`profile use <name>` 会切换后续默认启动使用的 profile。需要同时跑 Claude / Codex 两个 bot、连接多套 PersonalAgent 应用，或做脚本化部署时，再使用这些 profile 管理命令：

```bash
lark-channel-bridge profile create claude --agent claude
lark-channel-bridge profile create codex --agent codex
lark-channel-bridge profile list
lark-channel-bridge profile use <name>
lark-channel-bridge profile remove <name>
lark-channel-bridge profile remove <name> --purge --yes
lark-channel-bridge profile export <name> [--output ./profile.json] [--force]
lark-channel-bridge profile export <name> --include-secrets --yes
```

`profile remove` 默认归档本地状态，也可以删除当前激活的 profile。若还剩其他 profile，会自动切到下一个；若这是最后一个 profile，会清空 root config，之后可以用同名重新创建。只有加 `--purge --yes` 才会永久删除。`profile export` 默认脱敏 app secret；只有加 `--include-secrets --yes` 才会导出敏感配置。

如果某个 profile 被建成了错误的 agent 类型，先 `stop` 或 `unregister --profile <name>` 清理对应后台服务，再 `profile remove <name>`，然后用正确的 `--agent` 重新创建。

### 飞书内斜杠命令

| 命令 | 作用 |
|---|---|
| `/new`, `/reset` | 清空当前会话 |
| `/cd <path>` | 切换工作目录并重置会话 |
| `/ws list` | 列出命名工作空间 |
| `/ws save <name>` | 把当前工作目录保存为命名工作空间 |
| `/ws use <name>` | 切换到命名工作空间 |
| `/ws remove <name>` | 删除命名工作空间 |
| `/resume` | 恢复同 agent、工作目录、权限模式兼容的历史会话 |
| `/status` | 查看 profile、agent、工作目录、会话（含当前上下文大小、上次对话时间，开了会话智能压缩时还会提示下一条是否自动开新会话）、lark-cli 身份和运行状态 |
| `/config` | 调整展示偏好、访问控制和 lark-cli 身份策略 |
| `/invite user @某人` | 允许用户私聊使用 bot |
| `/invite admin @某人` | 添加访问控制管理员 |
| `/invite group` | 允许当前群使用 bot |
| `/invite group restricted @某人...` | 允许当前群使用 bot，但只对 @ 到的人生效 |
| `/invite member @某人` | 把这个人加进当前群的专属名单 |
| `/invite all group` | 允许 bot 所在的所有群使用 |
| `/remove user @某人`, `/remove admin @某人`, `/remove group [群 ID]`, `/remove member @某人` | 移除访问控制条目；`/remove group <群 ID>` 按 ID（或末几位）移除指定的群，私聊里也能用 |
| `/stop` | 停止当前 run，也可点卡片停止按钮 |
| `/timeout [N\|off\|default]` | 设置或清除当前会话的 idle watchdog |
| `/memory [add\|forget\|clear]` | 跨会话记忆，`--global` 写到全局 |
| `/skills [show <名字>]` | agent 按需读取的 skill 索引 |
| `/knowledge [bind\|sync\|unbind]` | 记忆与 skill 的 git 同步 |
| `/practice [run\|cancel\|prs\|diff\|revert]` | 课堂精练：把已结束的会话整理成记忆 / skill 的 Draft PR（管理员私聊） |
| `/diff [staged\|<ref>]` | 查看工作目录的改动，patch 过长时附带完整文件 |
| `/worktree [add\|use\|remove]` | 管理任务级 worktree，会话自动跟着切 |
| `/pr [编号\|链接]` | 当前分支的 PR、CI 与评审状态 |
| `/cron add <时间> \| <任务>` | 新建定时任务 |
| `/cron list\|show\|run\|pause\|resume\|remove` | 管理定时任务 |
| `/ps` | 列出本机 bridge 进程 |
| `/exit <id\|#>` | 停止指定 bridge 进程 |
| `/reconnect` | 强制 WebSocket 重连 |
| `/doctor [描述]` | 执行低敏诊断 |
| `/usage [today\|week\|month]` | 用量统计（token 与估算费用）；每个人看自己的，管理员私聊可看所有人 |
| `/audit [N]` | 最近谁让 bot 执行了什么命令、改了哪些文件、审批结果（管理员，私聊） |
| `/help` | 帮助卡片 |

私聊不需要 @。群和话题群默认必须 `@bot`；`@all` 会被忽略。支持的云文档评论里 @bot 就会触发回复。

**群聊上下文**：飞书只把 @ bot 的那条消息推给它，群里其他人的讨论它本来看不到。所以 bridge 在群聊 / 话题里每次开跑前，会把它没收到过的消息读回来，作为背景附在提问前面：

- 第一次进某个话题：带上话题里已有的消息（最多 40 条）。
- 第一次在普通群里被 @：带上最近 12 小时内的最近 20 条。
- 之后每次：只补上它上次回复以后别人说的话（最多 30 条，不含它自己的回复）。

单条超过 4000 字会截断，总量超出时先丢最早的。读到哪里按会话记在 profile 目录的 `chat-context-cursors.json`，重启不会重复注入。私聊不需要这一步。

## 记忆与 skills

每个 profile 有一份跨会话的知识目录——你在一次对话里教会它的约定，不会因为会话重置就消失。

每轮运行都会注入一个 `<bridge_knowledge>` 块：

- **全局记忆**：这个 profile 下所有会话共享的约定。
- **会话记忆**：只属于当前会话／话题的上下文。两者冲突时以会话记忆为准。
- **skill 索引**：每个 `SKILL.md` 的名字、一句话描述和路径——**只有索引**。正文由 agent 在需要时自己打开，所以十几个 skill 每轮只花几十 token，而不是几千。

```text
/memory                       # 当前生效的记忆
/memory add <内容>            # 记到本会话
/memory add --global <内容>   # 记到全局（管理员）
/memory forget <id>
/memory clear [--global]
/skills                       # skill 索引
/skills show <名字>
```

能在某个会话里用 bot 的人都能写这个会话的记忆；全局记忆和知识仓库是管理员权限，普通成员也无法靠猜 id 删掉一条全局记忆。

### 存在哪里，怎么同步

```text
~/.lark-channel/profiles/<profile>/knowledge/
  MEMORY.md                 # 全局记忆
  chats/<scope>.md          # 按会话的记忆
  skills/<名字>/SKILL.md    # 可复用的指令
```

全是 `0600` 的纯 Markdown，随便哪个编辑器都能改——这正是设计目的：这个目录就是一个 git 仓库。

```text
/knowledge                       # 条数、远端、同步状态、自动同步情况
/knowledge bind <git 地址>       # 绑定远端并拉取已有内容
/knowledge sync                  # 立即同步：提交本地改动、拉取、推送
/knowledge unbind                # 解绑但保留本地内容
```

绑定是合并而不是覆盖，所以绑之前写的记忆不会丢。同一个仓库可以给多个 profile、多台机器共用，凭据用的还是那台机器上已有的 git 配置。`/status` 里有一行展示条数与同步状态。

- **自动同步**：绑定远端后，bridge 启动后不久同步一次，之后每 30 分钟一次（提交 → `pull --rebase --autostash` → 推送），所以共用一个仓库的几个 bot 不用手动 `sync` 也能看到彼此的记忆。间隔在 profile 配置的 `knowledge` 段改，`0` 表示关闭、只在手动 `/knowledge sync` 时同步；改完 `/reconnect` 或重启生效（在 Web 控制台改见下文）：

  ```json
  "knowledge": { "syncIntervalMinutes": 30 }
  ```

- **不会互相打架**：自动同步和手动 `/knowledge sync`、`bind`、`unbind` 在同一个目录里排队执行，不会同时动 git。两个 bot 恰好同时推送时，后推的一方会再拉一次重推。
- **记忆文件按行合并**：知识仓库里会自动加一个 `.gitattributes`（`MEMORY.md merge=union`、`chats/*.md merge=union`，已有内容保留、只补缺的行，单独提交），两个 bot 同时往同一个记忆文件末尾追加时两边的行都保留，不会冲突。代价是：一边删掉的记忆如果另一边同时在它附近追加了内容，可能会被合并回来。`MEMORY.md` 不带目录前缀，`notes/` 下同名的记忆索引也按这个规则合并。
- **Web 控制台**：「配置」页的「知识库」卡片能看远端、分支、领先/落后、未提交改动和自动同步状态，也能绑定 / 改绑 / 解绑远端、立即同步、改同步间隔。git 操作当场执行；间隔由控制台托管的 profile 立即生效，由别的进程托管的（单 profile 后台服务）写进配置、下次重启生效。
- **失败提醒**：每次失败都写日志；连续两轮自动同步失败时私聊 bot 主人一次（附 git 的第一行报错、知识目录路径，地址里的凭据会遮掉），恢复前不再提醒，恢复后补一句「已恢复」。有人手动 `/knowledge sync` 成功也算恢复。目录里留着没处理完的 merge / rebase 时不会自动同步，先处理完再说。

Claude 和 Codex 读的是同一份 skill 索引，一个文件同时服务两种 agent。

### 共享 skill 库

知识目录是一个 profile 自己的；想让几个 bot（比如 Claude 的 CC 和 Codex 的 Poki）共用同一批 skill，就把它们放进一个 git 仓库，作为 **skill 库** 加载。bridge 为每个库维护一份只读镜像，把里面的 skill 并进同一份索引，索引里的条目带 `source` 标明出自哪个库。

```text
/skills lib                                   # 已配置的库、同步状态、各自载入的 skill
/skills lib add <git 地址> [名字]              # 加一个库并立即拉取（拉不下来就不保存）
    [--ref <分支/标签/提交>] [--path <子目录>]
    [--only a,b] [--exclude a,b]
/skills lib sync [名字]                        # 立即同步
/skills lib rm <名字>                          # 移除，本地镜像一起删掉
```

- **布局**：skill 放在 `skills/<名字>/SKILL.md`；仓库里没有 `skills/` 就在根目录找，`--path` 可以指定别的目录；根目录直接就是一个 `SKILL.md` 的仓库算作一个 skill。frontmatter 支持带引号的值和 `>` / `|` 多行描述。
- **只读镜像**：同步是 fetch + 切到远端提交 + 清掉本地改动，从不合并。要改 skill 就去改库的仓库本身。
- **同名优先级**：本 profile 自己 `knowledge/skills/` 里的 skill 优先，其次是先加的库；被挡住的会在 `/skills lib` 里列出来。
- **同步**：启动时同步一次，之后每 60 分钟一次（`skills.syncIntervalMinutes` 可改，`0` 表示只在启动和手动 `sync` 时拉）。
- **权限**：`/skills lib` 只有管理员能用——库里的内容会直接成为 bot 的操作指令；`/skills` 查看对所有人开放。私有仓库用本机已配好的 SSH key 访问，不要把 token 写进地址（卡片和日志里的地址会遮掉凭据，但配置文件里是原样）。
- **配置**：存在 profile 配置的 `skills` 段：

```json
"skills": {
  "libraries": [
    { "name": "team-skills", "url": "git@github.com:acme/team-skills.git", "ref": "main", "exclude": ["old-skill"] }
  ],
  "syncIntervalMinutes": 60
}
```

镜像在 `~/.lark-channel/profiles/<profile>/skill-libraries/<名字>/`。每个 profile 各自配置、各自拉取，同一个库给几个 bot 用就在每个 bot 里各 `add` 一次。

也可以在 Web 控制台「配置」页的「Skill 库」卡片里管理：列出各库的提交、同步时间和载入的 skill（被同名挡住的划掉显示），添加（同样先拉取成功才保存）、单个或全部同步、移除、改同步间隔。拉取和删镜像当场执行；配置改动由控制台托管的 profile 立即生效，由别的进程托管的写进配置、下次重启生效——在那之前它若又拉回了已移除的库，启动时会把配置里没有的镜像清掉。


### 课堂精练（默认关闭）

会话里定下的约定、验证过的结论、做成功的流程，过后常常没人记得 `/memory add`。打开课堂精练后，管理员可以让 bot 回头把已经结束的会话整理一遍，把值得长期保留的内容做成**待审核的 Draft PR**：记忆和笔记进知识库仓库，skill 进共享 skill 库。合并之前什么都不生效，bridge 从不自动合并。

```text
/practice                 # 开关、目标仓库、每轮上限、自动整理为什么没跑、最近几轮结果、待审核 PR 数
/practice run             # 立即整理一轮，完成后在私聊里回复结果
/practice cancel          # 取消正在进行的整理（游标不动，下次重读）
/practice prs             # 整理开出的 PR 及其审核状态
/practice diff [批次]     # 某一批的差异（默认最近一次）
/practice diary [批次]    # 某一批的梦境日记：读了什么、归纳出什么主题、写进 / 整合 / 归档了什么
/practice revert <批次>   # 撤销某一批：已合并的开 revert Draft PR，未合并的告诉你去关 PR
```

- **开关**：`/config` 的「课堂精练」或 Web 控制台「配置 → 回复与运行」，默认关闭。关掉开关后正在跑的一轮在发布前会停下。`/practice` 只有管理员能用，而且只能私聊——一轮会读到所有会话的内容。
- **自动整理**（`/config` / Web 的「自动整理」，默认关闭，课堂精练开着才生效）：不是每天定时跑，而是**攒够了才精练**。bridge 每 30 分钟看一次，下面几条全满足才开一轮：在允许时段内（默认 01:00–07:00，每个时段最多一轮）；材料够（有新内容的会话范围达到 5 个，或新对话达到 6 万字）；距上次整理过了 3 天；上一批 PR 已经审完（每个目标仓库还开着的课堂精练 PR 少于 1 个）；profile 空闲（没有在跑、在排队的用户任务，最近 30 分钟没有新消息）；agent 账号额度没超过 80%。超过 14 天没整理时，有一点新内容也会跑。读不到额度时按一半的预算跑；从不消耗 Codex 的额度重置次数。自动跑的一轮在提交草稿前遇到用户发消息就让位（取消，下次重读），手动 `/practice run` 不让位。连续失败 2 次起按 2、4… 天退避，连续 3 次后暂停，手动跑通一次恢复。自动整理不发任何消息，结果和「为什么没跑」（比如「材料不足 3/5 个会话范围」「距上次整理 1/3 天」）在 `/practice` 和 Web 卡片里看。
- **读什么**：只读 bridge 自己跑过的会话（Claude 的会话转录、Codex 的 rollout，按会话句柄精确定位，不扫本机别的历史），只取每轮的用户请求和最终回答，不含工具调用和中间过程；定时任务、会议、云文档评论的会话不读。每个会话有游标，下一轮只读新增的部分；转录被改写时从头重读，已经提过的内容不会重复提。仍在进行（空闲不足 30 分钟）或正在运行的会话留到下一轮。
- **怎么整理**：每个会话范围（一个群 / 私聊 / 话题）单独开一个只读 agent 运行（Claude 用 plan 模式，Codex 用只读沙箱，开不成只读就不跑），只给它看这个范围自己的对话、全局记忆、本会话记忆和 skill 索引。Claude 和 Codex profile 都能用，用的是 profile 自己的 agent。
- **校验**：agent 的输出只是建议，写入前逐条校验——每条都要引用本次输入里真实存在的轮次；提升为全局约定必须有管理员本人在单独发言里直接提出，否则降级为只写进原会话；合并 / 冲突 / 过时只做标记（写进 `notes/<范围>/practice-review.md`），不改原条目；疑似密钥、令牌、凭证的条目直接丢弃，给 agent 的对话摘录里也先遮掉；文件路径由 bridge 按范围推出来，agent 不能指定路径。
- **怎么提交**：从远端最新状态新拉一份，在 `dream/<批次>` 分支上提交一次，推送这个新分支并开 Draft PR；不 force push、不碰默认分支、不跑仓库的 hooks。所有目标仓库都先在本地提交，全部成功后才记下检查点（游标前移、候选标为已提）；检查点之前任何一处失败或被取消，整批草稿作废、下次重读，不会出现半批 PR。检查点之后中断（重启、断网）的推送和开 PR 下一轮接着做，不会重复开 PR。PR 正文写明每条的理由、来源（会话、范围、轮次）、哪些被降级、哪些没采纳。不要的条目直接在 PR 里删，整批不要就关掉 PR，同样的候选不会再提；已经合并的用 `/practice revert <批次>` 开一个 revert Draft PR。
- **多个 bot 共用仓库**：两个 profile（比如 CC 和 Poki）绑了同一个知识库或 skill 库时，一轮开始前按仓库远端地址拿本机的锁，另一个正在整理同一个仓库就这轮不跑并说明是谁占着。
- **目标仓库**：沿用现有配置——知识库用 `/knowledge bind` 绑定的 `origin`；skill 新建到 `skills.libraries` 里唯一的那个库（有多个库时在 `preferences.dreamTuning.skillLibrary` 指定），更新则回到该 skill 所在的库。当前 `gh` 账号对某个库没有写权限、或库固定在 tag / 提交上时，跳过该库并在结果里说明。`gh` 不可用时草稿留在本地，下一轮先补推、补开 PR。
- **上限**（profile 的 `preferences.dreamTuning`，可选）：

```json
"dreamTuning": {
  "maxSessions": 20,
  "maxInputChars": 120000,
  "maxRunMinutes": 20,
  "minIdleMinutes": 30,
  "skillLibrary": "team-skills",
  "scopes": ["oc_xxx"],
  "window": "01:00-07:00",
  "timezone": "Asia/Shanghai",
  "minScopes": 5,
  "minInputChars": 60000,
  "minIntervalDays": 3,
  "maxIntervalDays": 14,
  "maxOpenPrs": 1,
  "maxAutoFailures": 3,
  "maxQuotaPercent": 80
}
```

`scopes` 填了就只整理这些会话范围。`window` 起止可以跨午夜（如 `22:00-06:00`），`timezone` 默认本机时区；`maxIntervalDays` 设 0 关掉兜底。这些只在配置文件里改，`/config` 和 Web 只有开关。本地记录（读到哪、开了哪些 PR，不含对话内容）在 profile 目录的 `dream-state.json`，草稿的工作副本在 `dream/` 下，只保留最近几轮。

Web 控制台「配置」页有「课堂精练」卡片：显示目标仓库、上限、自动整理的条件和上次检查结果、最近几轮结果（自动跑的带「自动」标记）和 PR 链接；控制台托管的 profile 可以直接「立即整理」/「取消整理」/「撤销」，别的进程托管的只显示状态，请在飞书里私聊发 `/practice run`、`/practice revert`。

## Git 能力

当会话的工作目录是 git 仓库时，bridge 不再对它一无所知。

- **`/status`** 多一行 git 信息：分支、与上游的偏离（`↑2 ↓1`）、未提交的内容，以及当前目录是不是一个 linked worktree。
- **`/diff [staged|<ref>]`** 把改动渲染成卡片：逐文件的 `+`/`-` 数、未跟踪文件，以及一段 patch 摘录。`/diff` 是全部未提交改动，`/diff staged` 只看已暂存，`/diff main` 看这个分支相对 `main`（从共同祖先算起）新增了什么。摘录放不下时，完整 patch 会作为 `.patch` 文件紧跟着发出来，随手就能拿去别处打开。
- **`/worktree`** 管理任务级 worktree。`/worktree add <分支> [起点]` 会在仓库**旁边**创建（`../.worktrees/<仓库>-<分支>`，不放在仓库里面，免得污染父仓库的 status 和文件扫描），然后把会话切过去并重置会话——和 `/cd` 是同一套约定。`/worktree use <分支|路径>` 在已有的之间切换，`/worktree remove <分支|路径> [--force]` 删除。主 checkout 和会话当前所在的那个都受保护。
- **`/pr [编号|链接]`** 展示当前分支的 PR：标题、`head → base`、评审结论、CI 汇总（含失败的 check 名字），还有一个刷新按钮。

`/pr` 走本机的 [GitHub CLI](https://cli.github.com)，用的是**你自己**的 `gh` 登录态，bridge 不需要也不保存任何 GitHub token。没装 `gh` 或没登录时会直接说明，而不是静默失败。其余能力只依赖 `git`；工作目录不是仓库时，一切照旧。

从聊天里传进来的 ref 会先做校验再交给 git，一条消息不可能变成另一个 git 命令。
## 定时任务

`/cron` 按计划执行一段 prompt，并把结果发回创建它的会话——每天巡检日志、发版前自检、或者一个真的会动手的提醒。

```text
/cron add 0 9 * * 1-5 | 总结昨天 CI 的失败
/cron add @daily | 扫一遍 error 日志，挑出新增的问题
/cron add in 30m | 看看那次部署完成没有
/cron add at 2026-10-01 09:30 | 起草月报
```

- **时间写法**：标准 5 字段 cron（分 时 日 月 周，支持列表、区间和 `*/步长`）、`@hourly` / `@daily` / `@weekly` / `@monthly` 别名，以及一次性的 `in <时长>` 和 `at <时刻>`。全部按宿主机本地时区计算。`|` 用来分隔时间和任务内容。
- **每个任务独立 scope**：任务跑在自己的会话 scope（`cron:<id>`）里，工作目录取创建时的当前目录，不会和聊天本身的会话互相干扰。加 `--continue` 可以让多次运行复用同一个会话，默认每次都是新会话。
- **结果投递**：结果以一条完成后的消息发出（卡片或 markdown，跟随 `/config`），不是实时流——任务触发时不一定有人在看。在话题里创建的任务会回到那个话题里。
- **权限**：`/cron` 仅管理员可用，并且每次触发都会重新校验创建者的权限——把某人移出名单，他留下的任务也会随之停摆。任务只能在创建它的会话里管理。
- **触发时机**：只有持有该 profile 的进程会 tick 调度器，所以任务不会重复触发；bridge 没在跑的时候不会执行。错过超过 6 小时的 cron 触发会跳过而不是补跑（笔记本睡过 09:00、10:00 醒来仍会执行）；一次性任务即使迟到也一定会执行。
- **失败处理**：失败会在会话里报出来，连续失败 5 次自动暂停任务，`/cron resume <id>` 恢复并清空失败计数。
- **中断**：`/cron pause <id>` 和 `/cron remove <id>` 会顺带中断该任务正在执行的那一次——定时任务跑在自己的 scope 里，聊天里的 `/stop` 够不到它。

任务按 profile 存在 `jobs.json`（见数据目录）。


## 回复展示与 COT

`/config` 可以调整三类展示选项：

- **消息回复方式**：`消息卡片` 流式更新最终回复；`纯文本` 在 run 完成后一次性发送。
- **工具调用显示**：控制最终回复卡片 / markdown 中是否展示工具块。
- **COT 过程消息**：`关闭` 只发送最终回复；`简略` 先用 COT 消息展示 agent 的过程文本和工具摘要；`详细` 还会展示工具参数和截断后的输出。

开启 COT 后，bridge 会把过程消息和最终答案拆成两条消息。过程消息用于追踪 agent 做了什么；最终答案仍由 agent 原始文本生成，bridge 不做启发式过滤。若 agent 把最终答案也作为普通流式文本输出，COT 过程消息中可能会出现对应片段。

### 长任务完成提醒

回复卡片在任务开始时就发出、之后原地更新，而飞书对消息更新不推送通知——跑了二十分钟的任务结束时，手机不会响。所以任务从提交到结束超过阈值（默认 5 分钟）时，bot 会在原消息下再回一条短消息：

- 群聊 / 话题：@ 发起任务的人（合并处理的一批里有几个人就 @ 几个，不 @ 机器人），写明完成还是异常结束、用了多久。
- 私聊：只有答案落在那张原地更新的卡片里时才补发；答案本来就单独发出（COT、纯文本模式，或 Codex）时已经有推送，不再重复。
- 用户自己 `/stop` 的任务不提醒。

阈值在 profile 的 `preferences.longRunNoticeMinutes`（分钟，`0` 关闭），只能改配置文件。

## 多个 Claude 订阅账户：额度用尽自动切换

Claude profile 可以挂多个订阅账户。当前账户的额度（5 小时窗口或本周）用完时，正在跑的任务自动换到下一个账户、续接同一个会话接着做；主账户额度重置后，新任务自动回到主账户。

- **账户**：`default` 是本机 claude CLI 自己的登录（钥匙串），永远排第一；备用账户是 `claude setup-token` 生成的长期令牌（一年有效），运行时以 `CLAUDE_CODE_OAUTH_TOKEN` 注入该次 claude 进程。只有凭据不同，配置目录、会话转录、设置、技能都还是 `~/.claude` 那一份，所以 `--resume` 能跨账户续接（跨组织时 CLI 会丢掉上一账户的 thinking 块，不影响对话）。
- **添加**：先在终端里执行 `claude setup-token`，浏览器里用**备用账户**登录，拿到令牌；再执行

  ```bash
  lark-channel-bridge claude-account add <id> --label <名字> --profile claude   # 不回显地粘贴令牌，或用管道 + --token-stdin
  lark-channel-bridge claude-account list --profile claude
  lark-channel-bridge claude-account remove <id> --profile claude
  lark-channel-bridge claude-account set <id> [--label <名字>] [--five-hour <百分比>] [--weekly <百分比>]   # 改名字 / 该账户自己的切换线（0 跟默认），不用重输令牌
  lark-channel-bridge claude-account lines --five-hour 98 --weekly 90   # 默认切换线
  lark-channel-bridge claude-account order <id> <id> …   # 调顺序，第一个是主账户
  ```

  `add` 先用 haiku 发一条极短的请求验证令牌（`--no-verify` 跳过）。令牌加密存在 profile 的 keystore（`claude-oauth-<id>`），清单在 `profiles/<p>/claude-accounts.json`（顺序即优先级，`switchAtPercent` 为切换阈值，默认 98）。运行中的 bridge 每次开跑前按文件修改时间重读，**增删账户不用重启**。
- **何时切换**：每轮 stream-json 里的 `rate_limit_event` 带着各窗口用量，记在 `claude-accounts-state.json`。开跑前选第一个两个窗口都低于阈值、也没有被拒的账户；跑到一半被拒（`rate_limit` blocked）时，扣下这次拒绝，换下一个有余量的账户 `--resume` 同一会话，并告诉模型从中断处继续（原消息附在后面）。所有账户都用尽时照旧暂停，自动续跑时间取最早恢复的那个账户。
- **按轮次选账户**：每个账户在 5 小时窗口和本周窗口各有一条切换线（账户自己设的优先，否则用默认）。第一轮按顺序用还没到线的账户；所有账户都到线后，第二轮再从主账户开始按顺序用，每个都用到被拒（额度耗尽）为止；全部耗尽才暂停，在最早恢复的那个账户重置时自动续跑。跑到一半时，Claude 每条消息只在第一次请求后报一次用量，若这次显示超线、且还有没到线的账户，就在下一个没有工具调用、子 agent、后台任务在跑的间隙换过去（新进程续接同一会话）；没有没到线的账户就留在原账户上继续用。单条消息跑得很长时，开头之后的消耗看不到，可能略微超线。换账户本身不耗额度，被拒的请求也不计费；换过去后新账户要把整段对话重读一遍（缓存不跨账户），这部分算新账户的。
- **展示**：回复卡的 `Sponsor:` 是实际付费的账户；中途切换时正文里会有一行「账户 A 额度用尽，已切换到 B 继续」。管理员 `/usage` 会在订阅额度下面列出各账户的用量和状态（▶ 为新任务会用的账户）。
- **额度门槛**：过载保护和课堂精练读到的额度取「余量最大的账户」——只要还有账户有余量，就不算过载。

## lark-cli 身份策略

每个 profile 都使用当前 profile 的 lark-cli 目录：`~/.lark-channel/profiles/<profile>/lark-cli`。agent 子进程会收到指向这个目录的 `LARKSUITE_CLI_CONFIG_DIR`，所以一个 profile 里的个人授权不会共享给另一个 profile。

默认策略是 `bot-only`：lark-cli 使用应用 / bot 身份，不访问个人资源。当用户为了日历、邮箱、云盘等个人资源完成授权后，当前 profile 可以切到 `user-default`，保留应用身份，同时允许已授权的用户身份。owner/admin 可以在 `/config` 查看或切换这个策略；`/status` 会用 `lark-cli: app` 或 `lark-cli: user-ready` 展示当前摘要。

## 工作目录

每个 profile 都可以有一个默认工作目录：`workspaces.default`。新建 profile 时可以传 `--workspace <path>` 作为初始目录；没传时 bridge 会创建一个 profile 托管的默认工作目录。

下面只是 profile 里的字段片段，不要整段覆盖 `config.json`；请改对应 profile 下的 `workspaces` 字段。

```json
{
  "workspaces": {
    "default": "/Users/me/.lark-channel-workspaces/claude/default"
  }
}
```

bridge 会检查所选目录存在、是目录，并且不是 `/`、Home 根、系统目录或临时目录根这类范围过大的位置。工作目录只是 agent run 的当前目录，不是文件系统 sandbox；agent 实际能访问哪些文件仍取决于本机 agent 进程及其权限模式。

## 权限模式

推荐给用户配置的是 `permissions.defaultAccess` 和 `permissions.maxAccess`。新 profile 默认两项都是 `full`，以保持 bridge 的本地工具、授权流程、文件写入等能力完整可用。如需收紧权限，可以改成 `workspace` 或 `read-only`；收紧后本地工具执行、登录 / 授权流程、文件写入等能力可能受限。

下面只是 profile 里的字段片段，不要整段覆盖 `config.json`；请改对应 profile 下的 `permissions` 字段。

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

模式映射：

| Bridge access | Claude permission mode | Codex mode |
|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` |
| `workspace` | `acceptEdits` | `workspace-write` |
| `read-only` | `plan` | `read-only` |

旧版 `sandbox` 字段仍可读取。bridge 保存 profile 后，会把该设置迁移为 canonical `permissions`。

## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.lark-channel/config.json` | root config，包含 profiles 和 active profile |
| `~/.lark-channel/active-profile` | 最近选择的 profile |
| `~/.lark-channel/profiles/<profile>/sessions.json` | 会话状态 |
| `~/.lark-channel/profiles/<profile>/sessions.json.catalog.json` | agent-aware 会话索引 |
| `~/.lark-channel/profiles/<profile>/knowledge/` | 记忆与 skills（可作为 git 仓库同步） |
| `~/.lark-channel/profiles/<profile>/skill-libraries/` | 共享 skill 库的只读镜像（`/skills lib`） |
| `~/.lark-channel/profiles/<profile>/jobs.json` | 定时任务（`/cron`） |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | 当前和命名工作空间绑定 |
| `~/.lark-channel/profiles/<profile>/secrets.enc` | profile 本地加密 secret |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | 当前 profile 的 lark-cli 目录 |
| `~/.lark-channel/profiles/<profile>/media/` | 附件缓存 |
| `~/.lark-channel/profiles/<profile>/logs/` | 结构化运行日志 |
| `~/.lark-channel/registry/processes.json` | 本机进程注册表 |
| `~/.lark-channel/registry/locks/` | profile lock 和 app lock |

设置 `LARK_CHANNEL_HOME=/path/to/state` 可以迁移整棵本地状态目录。`LARK_CHANNEL_LOG_DAYS` 可以调整日志保留天数。

## 访问控制

**聊天访问默认是私有的：开箱即用时，只有"你"能在私聊和群聊里用这个 bot。** 这里的"你" = 创建 / 拥有这个飞书应用的人（也就是扫码把 bot 建起来的那位）。bot 会自动从飞书查出谁是应用 owner，所以**一个人用聊天入口完全不用配置**——你私聊它、在任意群里 @它都正常工作，其他人的聊天消息会被静默忽略（bot 不会回"你没权限"，免得暴露自己的存在）。云文档评论按文档权限生效，见下文。

想让别的同事或某些群也能用，就把他们加进下面三类名单：

| 名单 | 控制谁 | 加入 | 移除 |
|------|--------|------|------|
| **允许私聊的用户** | 谁可以私聊 bot | `/invite user @某人` | `/remove user @某人` |
| **响应的群** | bot 在哪些群里响应（默认**群内所有人**，除非设了专属名单——见下文） | `/invite group`（当前群）/ `/invite all group`（bot 所在的全部群） | `/remove group`（当前群）/ `/remove group <群 ID>`（指定群，私聊可用，适合 bot 已被移出的群） |
| **管理员** | 谁能改设置、并能在任意群用 bot | `/invite admin @某人` | `/remove admin @某人` |

> `/invite`、`/remove` 这些命令只有**你（创建者）和管理员**能发。命令里 @ 的是**对方**（不是 @ bot），bot 会自动把 @ 解析成对应的人，你不用手动去找 ID。

### 只对群内部分人开放

`/invite group` 是把群开放给里面所有人。如果想开放这个群、但只对指定的几个人生效，用群专属名单：

```bash
/invite group restricted @Alice @Bob   # 一步完成：加群 + 设定专属名单
/invite member @Carol                  # 给已经是"仅名单"模式的群追加一个人
/remove member @Alice                  # 只移除这一个人
```

`/invite group restricted` 是原子操作——这个群只会处在"还没加"或"已加且已经限定到这些人"两种状态之一，中间不存在"先对所有人开放、名单还在加"这种过渡态；甚至可以不带任何 @ 直接执行，把群锁定成只有 admin/owner 能用，之后再用 `/invite member` 陆续加人。一个群只要有过专属名单（哪怕当前是空的），单独发 `/invite group` 不会让它重新对所有人开放——想恢复全员开放，得先 `/remove group` 再用普通的 `/invite group` 重新加。`/remove group` 也会顺带清掉这个群的专属名单。

### 两种"畅通无阻"的身份

- **你（创建者）**：不受任何名单限制——私聊、任意群、所有命令都能用，而且**永远锁不死自己**：哪怕名单配乱了，回到 bot 私聊发 `/config` 总能进来。在飞书后台把应用 owner 转给别人后，bot 也会自动跟着切换。
- **管理员**：能私聊、能用 `/config` 等管理命令，而且**不受"响应的群"名单限制**——无论群在不在名单里，bot 都会回他们。适合给一起维护 bot 的同事。

### 几种常见配置

- **只给自己用** → 什么都不用做，默认就是。
- **让某个同事能私聊 bot** → `/invite user @他`
- **让某个工作群里所有人都能用** → 在那个群里发 `/invite group`
- **让某个工作群开放、但只给里面几个人用** → 在那个群里发 `/invite group restricted @某人 @另一个人`
- **第一次配，想把 bot 已经在的群一次性全开放** → 发 `/invite all group` 一键拉取 bot 所在的全部群加入名单，之后再用 `/remove group` 删掉不想要的
- **再拉个人一起当管理员** → `/invite admin @他`

### 还需要知道的

- 改完**下一条消息**就生效，不用重启。
- **群里默认要先 @bot 才会回**（私聊不用 @）。这是另一个独立开关（`/config` →"群里需要 @ bot"），和上面的名单是两回事。
- 陌生人发消息一律静默丢弃，不会有任何回复。唯一的例外：有人在一个还没开放的群里 @bot，bot 会回一句友好提示，告诉他可以让管理员发 `/invite group` 开放这个群。
- 云文档评论按文档权限生效：能在支持的文档里评论并 @bot 的人可以触发回复。

### 非管理员的操作审批（默认关闭）

默认不审批：谁驱动的任务都按 profile 的权限直接运行。在 profile 配置里开启 `approvals.enabled` 后，除 bot 主人和管理员以外的人驱动的任务（私聊、群里 @bot、云文档评论；合并处理的一批消息里只要有非管理员的消息就算）：

- agent 可以随意读文件、搜索、查网页；**运行命令、写文件、调用外部工具（MCP）**之前，会把审批卡片发到 bot 主人和每位管理员的私聊，带「允许 / 本轮都允许 / 拒绝」。发起人那边会看到「等待管理员审批」，可以自己取消。
- 只有管理员能点「允许」；**5 分钟**无人处理按拒绝处理，agent 会被告知这一步没获批准。
- 每次审批结果和执行过的命令 / 改动的文件都按人记入审计日志（不开审批时命令和文件改动也照记）（profile 目录下 `audit.jsonl`，保留 90 天），管理员私聊发 `/audit [N]` 查看最近的记录。
- Claude Code 通过工具调用前的 hook 拦截；Codex 通过 app-server 自带的审批请求（沙箱只读、`approvalPolicy: untrusted`）。退回 `codex exec` 的 Codex profile 没有审批通道，非管理员的任务只读运行。

开关也可以在飞书里发 `/config`，在「运行与权限」的「非管理员操作审批」里切换，提交后立即生效。免审批清单只能改配置文件，在 profile 的 `approvals` 段（改完重启该 profile 生效）：

```json
"approvals": {
  "enabled": true,
  "allowCommands": ["python3 ~/.claude/skills/remote-tcpdump/scripts/tcpdump_client.py"],
  "allowTools": ["mcp__tdengine-*__query"]
}
```

- `enabled`：`true` 开启审批；不写或 `false` 为关闭（默认），非管理员的任务和管理员一样的权限，不弹审批卡。
- `allowCommands`：免审批的命令，按开头的几个词匹配（`~`、`$HOME` 会展开，词要整个对上），上例覆盖这个抓包脚本的所有子命令。`&&` / `|` 连起来的每一段都要么在清单里、要么本身只读；带 `;`、重定向、命令替换的照样要审批；经变量（`$C`）调用的脚本匹配不上。
- `allowTools`：免审批的工具名，`*` 匹配任意字符。写 `Bash` 等于放开所有命令，慎用。
- 免审批放行的操作同样记审计，`/audit` 里显示为「免审批清单」。

### 会话智能压缩（默认关闭）

bridge 默认一直续用同一个会话。会话越聊越长，每一轮（以及每一次工具调用）都要把整段上下文重读一遍；空闲超过 1 小时缓存过期后，再说话还要按写缓存的价格把整段上下文重写一次。在飞书里发 `/config`，打开「运行与权限」里的「会话智能压缩」（提交后立即生效），也可在 Web 控制台的「配置 → 回复与运行」中打开同名开关并保存。bridge 会：

- **空闲后自动开新会话**：新消息到来时，如果上次对话已经过去 1 小时以上且上下文超过 15 万 token，或者已经过去 8 小时以上，就不再续用旧会话，直接开新会话。
- **agent 判断事情做完时收尾**：agent 在最终回复末尾写 `[[NEW_SESSION: 一句话摘要]]`，bridge 把这个标记从回复里去掉，下一条消息从新会话开始。这个收尾请求存在 profile 目录的 `pending-rotations.json`，中间重启 bridge 也不会丢；如果下一条消息前已经 `/new`、`/resume` 或 `/cd` 换了会话，请求作废。
- **长会话提前压缩**（Claude Code / Codex）：默认设置 30 万 token；Claude Code 使用压缩窗口，Codex 的 app-server 和 exec 都使用原生自动压缩阈值。实际压缩时机仍受模型上下文上限约束。关闭开关会恢复 CLI 原生默认策略。

旧会话不会丢：照常归档，`/resume` 可以找回。新会话的第一轮会带上一段交接说明（上一段会话的摘要或最后一个问题），回复卡底部也会提示「已自动开启新会话」。会话还有后台任务在跑、或者用户用引用回复指着之前的消息时，不会切换。

阈值可以在配置文件里调（profile 的 `preferences`，改完重启该 profile 生效）：

```json
"smartSessionTuning": {
  "idleMinutes": 60,
  "minContextTokens": 150000,
  "hardIdleMinutes": 480,
  "compactWindowTokens": 300000
}
```

### Worktree 自动清理（默认关闭）

在 `/config` 的「运行与权限」或 Web 控制台「配置 → 回复与运行」打开「Worktree 自动清理」，保存后生效。bridge 每小时检查一次，通过 `/worktree add` 创建并登记的 worktree 默认闲置 7 天后才参与清理；已有的、或 agent 在终端自行创建的 worktree 不会自动纳入。

只清理已合入仓库默认分支的 worktree（优先使用 `origin/HEAD` 指向的本地分支，否则使用 `main` / `master`）。主工作区、锁定或分离 HEAD 的 worktree、切换过分支的目录，以及有改动、未跟踪或忽略文件的目录都会保留。其他 profile 的当前/命名工作区、默认目录和定时任务目录也受保护；有任务或保留进程时延后检查。不会强制删除。

清理 worktree 后，只删除 bridge 新建的分支；借用的已有分支保留。删除分支时校验提交号，期间有新提交则保留分支。清理记录写入 bridge 日志，不删除远端分支。可在 profile 的 `preferences` 设置闲置天数（1–365，默认 7）：

```json
{
  "autoWorktreeCleanup": true,
  "worktreeCleanupIdleDays": 7
}
```

依赖目录、构建产物等即使被 `.gitignore` 忽略，也会阻止自动清理；需要先自行移除。关闭开关会停止后续清理，已删除的 worktree 不会自动恢复。

### 高级：直接改配置文件

不想在飞书里点的话，`/invite`、`/config` 背后写的是 `~/.lark-channel/config.json` 中对应 profile 的 `access` 字段。空白名单表示这个名单没人，不表示所有人都能用。下面只是 profile 里的字段片段，不要整段覆盖 `config.json`：

```json
{
  "schemaVersion": 2,
  "profiles": {
    "claude": {
      "agentKind": "claude",
      "access": {
        "allowedUsers": ["ou_xxxxxxxxxxxxx"],
        "allowedChats": ["oc_xxxxxxxxxxxxx"],
        "admins": ["ou_xxxxxxxxxxxxx"],
        "requireMentionInGroup": true
      }
    }
  }
}
```

`allowedUsers` / `admins` 填用户 `open_id`，`allowedChats` 填群 `chat_id`。手动找 ID 最简单的办法：让对方给 bot 发条消息（群里就 @ 它一下），然后看当前 profile 的日志：

```bash
grep '"event":"enter"' ~/.lark-channel/profiles/<profile>/logs/bridge-$(date +%Y%m%d).jsonl | tail -5
```

每行都带 `chatId`（群 / 私聊 ID）和 `senderId`（用户 `open_id`）。手改完后**重启 bridge**，或在允许的 admin 上下文里发 `/reconnect` 让它生效。日常调整还是 `/invite` / `/config` 更省事，直接改文件主要用于部署脚本预填。

## 云文档评论

云文档评论不再需要单独绑定工作目录或维护文档白名单。支持的文档评论里 @bot 后，bridge 会在同一个评论线程里回复。评论运行复用文档级 session key；没有记录过文档 cwd 时回退到用户 home 目录。

## 常见问题

**bot 没反应 / agent 不回复**：通常是本机 `claude` 或 `codex` CLI 没登录，或者当前会话指向了不存在的工作目录。发 `/status` 看当前状态；`/new` 重开会话往往就好。

**agent 子进程假死（卡片停在最后一帧不动）**：支持 idle 探活。agent 一段时间没输出就会被 SIGTERM kill，卡片末尾会标出自动终止原因。默认关闭。开启方式：`/config` 设全局值（分钟），或 `/timeout 10` 只对当前会话生效；`/timeout off` 关掉当前会话的探活；`/timeout default` 清掉会话覆盖，回退到全局设置。

**图片发过去 agent 说看不到**：升级到最新版，0.1.0 之前的版本有文件名去重 bug。

## 测试与 CI

本地检查：

```bash
pnpm test
pnpm typecheck
pnpm build
```

`pnpm test` 包含 unit、integration 和 process-level adapter 测试。CI 在 macOS、Ubuntu、Windows 上执行 `pnpm install --frozen-lockfile`、`pnpm test`、`pnpm typecheck` 和 `pnpm build`。

改代码的完整约定（worktree 迭代流程、门禁 `pnpm ci:local`、架构地图、新增 agent 的步骤）见仓库根目录的 `AGENTS.md`（Claude Code 经 `CLAUDE.md` 导入，Codex 直接读取，两者共用一份），操作步骤在 `docs/dev/`。

## 可选：遥测（Telemetry）

默认情况下 bridge **不上报任何数据**：没有指标、没有日志离开你的机器，也不引入任何遥测依赖。下面这个钩子在你主动开启前完全是空操作。

想接自己的监控时，用环境变量指向一个 default export（或导出 `createAdapter`）`AdapterFactory` 的模块：

```bash
LARK_CHANNEL_TELEMETRY_MODULE=your-telemetry-package lark-channel-bridge start
```

该模块会收到每一条 `log.*` 事件，以及错误 / 指标钩子，转发到任何你想要的地方。接口从包根导出：

```ts
import type { AdapterFactory, TelemetryAdapter, TelemetryEvent } from 'lark-channel-bridge';

const createAdapter: AdapterFactory = (meta) => ({
  emit(event) {/* 上报事件 */},
  recordError(err, ctx) {/* 上报异常 */},
  recordMetric(name, value, tags) {/* 上报指标 */},
  flush(timeoutMs) {/* 冲刷缓冲事件 */},
});
export default createAdapter;
```

模块不存在、工厂函数不合法、或者 adapter 抛错，都会降级为空操作——遥测永远不会阻止 bridge 启动，也不会打断日志。

## 许可

[MIT](./LICENSE)

<img src="./assets/feedback-group-qr.png" alt="飞书反馈群二维码" width="360">
