# claude-magpie-remote

让 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) 连接另一台机器上运行的 [Magpie](https://github.com/yetone/magpie) 网关：通过 `magpie-remote login` 配置网关地址和 gateway key，选择一个模型，并在状态栏查看当前模型供应商的额度。

- **远程模型**：通过 Claude Code 的 gateway model discovery 将网关模型加入 `/model`。
- **额度显示**：状态栏显示当前模型供应商的窗口用量或余额，`/magpie-remote:usage` 查看额度。
- **可恢复配置**：登录时保存原设置快照，`magpie-remote logout` 还原插件修改。
- **零运行时依赖**：使用 Node.js 内置 API；支持 Node.js 18 及以上版本。

## 安装

添加 marketplace 并安装插件：

```sh
claude plugin marketplace add LiangNiang/claude-magpie-remote
claude plugin install magpie-remote@claude-magpie-remote
```

也可在开发或本地测试时加载仓库目录：

```sh
claude --plugin-dir /path/to/claude-magpie-remote
```

全局安装 CLI：

```sh
npm install -g claude-magpie-remote
```

## 配置 Magpie

在运行 Magpie 的机器上：

1. 开启 **设置 → 局域网共享（Share on local network）**。
2. 运行 `magpie gateway-key add` 创建一个 gateway key。
3. 记下 Claude Code 所在机器可访问的地址（例如 `http://192.168.1.20:3425`）和 key。

## 登录

```sh
magpie-remote login
```

交互式输入网关地址、gateway key、主模型和快速 / 后台模型。也可以用参数登录：

```sh
magpie-remote login http://192.168.1.20:3425 \
  --key sk-magpie-... \
  --model anthropic/claude-sonnet-4-6 \
  --fast-model anthropic/claude-haiku-4-5
```

登录会将连接信息写入 `~/.claude/settings.json`，并把状态栏脚本复制到 `~/.claude/magpie-remote/lib/`，避免插件缓存目录变化造成命令失效。自定义的 `statusLine` 不会被覆盖；可在原脚本中调用 CLI 显示额度。使用 `--no-statusline` 可跳过状态栏配置。

完成后重启 Claude Code。之后可用 `magpie-remote status` 查看连接，也可以在 Claude Code 中运行 `/model` 选择模型。

> Claude Code 自身对 gateway discovery 的模型 ID 有筛选：只将 ID 中包含 `claude` 或 `anthropic`（不区分大小写）的模型加入 picker。因此不符合筛选条件的 Magpie 模型不会出现在 `/model`，即使它们在 Magpie catalog 中。此行为由 Claude Code 实现，插件不能更改。

## 查看额度

状态栏会显示当前模型所属供应商的额度，例如 `codex 5h 32% · 7d 71%` 或 `deepseek ¥23.40`。同一供应商有多个账号时优先显示最近一次经网关服务的账号，`+N` 表示还有 N 个账号。

用量达到 75% 时变黄，达到 90% 时变红。额度缓存 60 秒，网关不可达时会使用同一地址的过期缓存。

查看全部供应商或筛选结果：

```text
/magpie-remote:usage
/magpie-remote:usage codex
/magpie-remote:usage balance
```

CLI 也提供相同功能：

```sh
magpie-remote usage
magpie-remote usage codex
magpie-remote usage --json
```

## 状态与退出登录

```sh
magpie-remote status
magpie-remote logout
```

退出登录会恢复首次登录前的配置并移除插件保存的状态和状态栏脚本。

## 开发

```sh
npm install
npm run check
npm test
```

对正在使用的 Magpie 做只读冒烟测试（只请求模型列表和额度，不发起对话）：

```sh
MAGPIE_URL=http://192.168.1.20:3425 MAGPIE_GATEWAY_KEY=sk-magpie-... npm run smoke
```

未设置 `MAGPIE_URL` 时冒烟测试会跳过。
