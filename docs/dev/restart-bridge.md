# 重启 bridge daemon

Claude Code 与 Codex 共用的重启步骤（Claude Code 里的 `/restart-bridge` 即执行本文）。**只在 boss 明确要求重启时使用。** 重启会断开该 bot 上所有进行中的会话。

## 步骤

1. 确认要重启的 profile（boss 点名的，如 `claude`、`codex`；控制台是 `--web-ui`）；`lark-channel-bridge ps` 看在线 bot。自己所在的 profile 是环境变量 `LARK_CHANNEL_PROFILE`（CC 是 `claude`，Poki 是 `codex`）。
2. 看有没有别人的任务在跑：对每个 bot 的 PID，`ps -ax -o pid,ppid,etime,command | awk '$2==<PID>'` 列出子进程。除了自己这轮以外还有 agent 子进程在跑，就先汇报、等 boss 确认。
3. 先重启**不是自己所在**的 profile（比如 CC 重启 `codex`，或 Poki 重启 `claude`）：`lark-channel-bridge restart --profile <name>`，再 `lark-channel-bridge status --profile <name>` 确认「正在后台运行」且 PID 变了。
4. 重启自己所在的 profile（`LARK_CHANNEL_PROFILE`）时，直接执行会把当前这轮 run 一起杀掉，回复也发不出去。必须脱离进程树、延时执行，并在重启后自己回报结果：

   ```bash
   cat > /tmp/bridge-restart.sh <<'SH'
   #!/bin/zsh
   exec >/tmp/bridge-restart.log 2>&1
   old=$(lark-channel-bridge status --profile "$1" | awk '/进程 ID/{print $NF}')
   sleep 30
   lark-channel-bridge restart --profile "$1"
   sleep 8
   st=$(lark-channel-bridge status --profile "$1")
   new=$(echo "$st" | awk '/进程 ID/{print $NF}')
   if echo "$st" | grep -q "正在后台运行" && [ -n "$new" ] && [ "$new" != "$old" ]; then
     msg="$1 已重启完成。"
   else
     msg="$1 重启可能没成功，日志在 /tmp/bridge-restart.log。"
   fi
   lark-cli im +messages-send --as bot --chat-id "$2" --text "$msg"
   SH
   python3 -c "import subprocess,sys; subprocess.Popen(['/bin/zsh','/tmp/bridge-restart.sh',sys.argv[1],sys.argv[2]], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)" <profile> <当前 chat_id>
   ```

   30 秒延时是给本轮回复留出发送时间；`chat_id` 取 `bridge_context.chatId`。
5. 汇报：哪些已重启、自己所在的 profile 约 30 秒后重启并会在会话里回报结果。

## 规则

- 不用 `kill`、`launchctl bootout` 之类绕过 `lark-channel-bridge restart` 的方式。
- 不要改 `LARK_CHANNEL*` 环境变量来"绕过"当前 profile。
