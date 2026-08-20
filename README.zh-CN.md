# pi-provider

[English](README.md)

为 [Pi](https://pi.dev) 提供 Provider 扩展工具包，用于注册 LLM Provider、发现模型目录、调优请求，以及查看缓存或显式刷新的账户状态，同时保留 Pi 原生 Footer。

[适配器契约](https://github.com/hyav/pi-provider/blob/main/docs/adapter-extensions.zh-CN.md) · [支持策略](SUPPORT.md) · [参与贡献](CONTRIBUTING.md) · [更新记录](CHANGELOG.md) · [安全策略](SECURITY.md)

## 核心能力

- 由一个 Pi Provider Host 统一负责注册、Status、Preflight、实时检查和请求 Tuner
- 由单一 Pi 入口在 `/reload` 时发现 Provider、Status、Preflight 和 Tuner Adapter 文件
- 通过缓存回退、有界后台刷新和失败保留提供可靠的模型目录
- 优先采用 Provider 价格元数据，并可由 OpenRouter 补全价格和质量指标
- 显式诊断：缓存 `/status`、免费 `/status refresh` 和可能计费的 `/status check`
- 内置 Charm Hyper、DeepSeek、Google Gemini、OpenAI Codex、OpenCode Zen 和 OpenCode Go 集成
- Status/Preflight 适配覆盖 Pi 原生 Provider：Anthropic、GitHub Copilot、OpenRouter、Groq、xAI
- Status/Preflight 适配覆盖 Moonshot（Kimi）国际/国内平台与 Hugging Face 套餐/额度
- Status/Preflight 适配覆盖 Vercel AI Gateway（鉴权、模型目录与额度）
- 目录 Preflight 适配覆盖 Pi 原生 Provider：OpenAI、Anthropic、Mistral、NVIDIA NIM、Cerebras

## 安装

需要 Node.js 22.19.0 或更高版本、Pi，以及所用 Provider 的凭据。

```sh
pi install npm:@hyav/pi-provider
```


## 快速开始

1. 在 Pi 中配置凭据。Charm Hyper 接受 `HYPER_API_KEY` 或 Pi 的 `/login` OAuth 流程。
2. 选择模型，例如：

   ```text
   /model charm-hyper/deepseek-v4-pro
   ```

3. 查看缓存报告：

   ```text
   /status
   ```

使用 `/status refresh` 执行免费的端点、鉴权、目录和账户检查。只有明确接受一次真实模型请求及其可能产生的用量费用时，才使用 `/status check`。

## 常用配置

| 名称 | 必需 | 默认值 | 作用 |
|---|---:|---|---|
| `HYPER_API_KEY` | Charm Hyper API Key 鉴权需要 | 无 | 为内置 `charm-hyper` Provider 提供凭据；OAuth 用户可以使用 `/login` |
| `PI_CODING_AGENT_DIR` | 否 | `~/.pi/agent` | 修改 Pi agent 目录；公开 OpenRouter 元数据缓存在 `<agent-dir>/extensions/pi-provider/` 下 |

程序化集成可以通过 `createPiProviderRuntime()` 或 `createPiProviderHost()` 配置价格回退、价格策略、请求超时、元数据 URL 和缓存路径。程序化默认值会从 `PI_CODING_AGENT_DIR`（回退到 `~/.pi/agent`）解析 agent 目录，并保持 OpenRouter 元数据缓存落盘到 `<agent-dir>/extensions/pi-provider/`，与上表一致；Pi 入口会用 Pi 自身的解析覆盖它。使用自定义 capability 根目录的 Host 包可以调用 `createPiProviderExtension({ adapterRoot, dependencies })`。源码定义 [`PiProviderDependencies`](core/runtime-config.ts) 是权威依据。

## Adapter 发现（文件级即插即用）

内置 Adapter 随包发布，始终被扫描。用户 Adapter 放在 Pi 解析出的 agent 目录下，同样会被发现：

```text
<agent-dir>/extensions/pi-provider/
  providers/   # Provider Adapter 文件
  status/      # Status Adapter 文件
  preflight/   # Preflight Adapter 文件
  tuners/      # Tuner Adapter 文件
```


在目录中增删或修改文件后执行 `/reload` 即可重新发现，无需改动包；对现有文件的修改会重新从磁盘读取。用户 Adapter 在内置之后加载，因此同 ID 的用户文件会覆盖内置 Adapter（Host 保留最新注册并发出警告）。`createPiProviderExtension({ adapterRoot })` 用自定义根替换默认用户目录；内置目录始终被扫描。包内 `providers/`、`status/`、`preflight/` 下的内置 Adapter 就是采用这种写法的参考模板——复制一份改改即可（Charm Hyper 与 `preflight/openai-codex.ts` 还依赖包内私有辅助文件）。

Adapter 文件从 `@hyav/pi-provider` 导入 helper 和类型（加载器内部做了别名映射）：

```ts
import { defineProviderExtension } from "@hyav/pi-provider";
```

Adapter 文件不得运行时导入 Pi 的内置包（`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`@earendil-works/pi-ai`），仅 type-only 导入可以；agent 目录、存储凭据和 ANSI 文本包装器等运行时值由 Pi 入口注入。Helper、校验、冲突、reload 行为和生命周期边界见 [Adapter Extension 契约](https://github.com/hyav/pi-provider/blob/main/docs/adapter-extensions.zh-CN.md)。根目录 [`index.ts`](index.ts) 定义公开 TypeScript 导出。

## 使用须知

`/status` 离线运行，`/status refresh` 执行免费远程检查，`/status check` 会发送可能消耗配额的真实模型请求。配置的凭据只会发送给对应 Provider 端点，并且不会出现在 Status 输出中。

## 许可证

[MIT](LICENSE)
