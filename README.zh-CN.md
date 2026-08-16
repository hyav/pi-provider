# @hyav/pi-provider

[English](README.md)

为 [Pi](https://pi.dev) 提供 Provider 扩展工具包，用于注册 LLM Provider、发现模型目录、调优请求，以及查看缓存或显式刷新的账户状态，同时保留 Pi 原生 Footer。

[适配器契约](docs/adapter-extensions.md) · [支持策略](SUPPORT.md) · [参与贡献](CONTRIBUTING.md) · [更新记录](CHANGELOG.md) · [安全策略](SECURITY.md)

## 核心能力

- 由一个 Provider Kit Host 统一负责注册、Status、Preflight、实时检查和请求 Tuner
- 通过 manifest 发现 Provider、Status、Preflight 和 Tuner Adapter，并在 `/reload` 后重新加载
- 通过缓存回退、有界后台刷新和失败保留提供可靠的模型目录
- 优先采用 Provider 价格元数据，并可由 OpenRouter 补全价格和质量指标
- 显式诊断：缓存 `/status`、免费 `/status refresh` 和可能计费的 `/status check`
- 内置 Charm Hyper、DeepSeek、Google Gemini、OpenAI Codex、OpenCode Zen 和 OpenCode Go 集成

## 安装

需要 Node.js 22.19.0 或更高版本、Pi，以及所用 Provider 的凭据。

```sh
pi install npm:@hyav/pi-provider
```

包有意发布由 Pi 加载的 TypeScript 源码，不是独立的 Node CLI。

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
| `PI_CODING_AGENT_DIR` | 否 | `~/.pi/agent` | 修改公开 OpenRouter 元数据缓存的基础目录 |

程序化集成可以通过 `createProviderKitRuntime()` 或 `createProviderKitHost()` 配置价格回退、价格策略、请求超时、元数据 URL 和缓存路径。源码定义 [`ProviderKitDependencies`](core/runtime-config.ts) 是权威依据。

可信包可以通过 manifest 中的 `providers/`、`status/`、`preflight/` 和 `tuners/` 条目添加 Adapter。Helper、校验、冲突、reload 行为和生命周期边界见 [Adapter Extension 契约](docs/adapter-extensions.md)。根目录 [`index.ts`](index.ts) 定义公开 TypeScript 导出。

## 使用须知

`/status` 离线运行，`/status refresh` 执行免费远程检查，`/status check` 会发送可能消耗配额的真实模型请求。配置的凭据只会发送给对应 Provider 端点，并且不会出现在 Status 输出中。

## 许可证

[MIT](LICENSE)
