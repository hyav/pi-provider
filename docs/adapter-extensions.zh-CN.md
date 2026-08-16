# Adapter Extension 设计

[English](adapter-extensions.md)

本文定义 Pi Provider 动态扩展适配器的公共契约，描述其使用方式、生命周期和故障隔离边界。

## 目标

用户与开发者可以通过以下方式扩展 Pi Provider 能力，无需修改 Pi Provider 的 `index.ts`：

1. 在 capability 目录中添加或删除 TypeScript 文件——可以在 Host 包内（内置 Adapter），也可以在 Pi 解析出的 agent 目录 `<agent-dir>/extensions/pi-provider/` 下（用户 Adapter）；
2. 安装另一个本地、npm 或 Git Pi 扩展包；
3. 执行 `/reload`。

新发现的 Provider、Status、Preflight 与 Tuner 在 reload 后自动并入同一个 Pi Provider Host 实例。活动会话内不支持不经过 reload 的热替换。

## 包布局

Pi Provider Host 包与独立的 Adapter 包均遵循标准 capability 目录约定：

```text
package-root/
  index.ts                 # Pi Provider Host（每个运行时唯一）
  providers/*.ts           # Provider Adapter Extensions
  status/*.ts              # Status Adapter Extensions
  preflight/*.ts           # Preflight Adapter Extensions
  tuners/*.ts              # Tuner Adapter Extensions
```

Host 还会在 Pi 解析出的 agent 目录下发现用户 Adapter，无需改动任何包：

```text
<agent-dir>/extensions/pi-provider/
  providers/*.ts           # 用户 Provider Adapter Extensions
  status/*.ts              # 用户 Status Adapter Extensions
  preflight/*.ts           # 用户 Preflight Adapter Extensions
  tuners/*.ts              # 用户 Tuner Adapter Extensions
```

先扫描内置 capability 目录，后扫描用户目录，因此同 ID 的用户文件会覆盖内置 Adapter。`createPiProviderExtension({ adapterRoot })` 用自定义根替换默认用户目录；内置目录始终被扫描。

Host 包仅向 Pi 声明根入口。根入口在启动和 `/reload` 时扫描自身 capability 目录，因此 Pi 将整个 Host 包显示为一个 extension，同时仍能通过增删文件扩展能力：

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

因此，`pi config` 只能整体启停 Host 包，不能单独启停其中的 capability 文件。需要独立启停的 Adapter 应放在独立 Adapter 包中。

独立 Adapter 包仅声明自身包含的 capability 入口。从 `@hyav/pi-provider` 导入辅助函数的 npm Adapter 包必须同时在 `dependencies` 与 `bundledDependencies` 中声明：

```json
{
  "name": "example-provider-adapters",
  "dependencies": {
    "@hyav/pi-provider": "^0.1.0"
  },
  "bundledDependencies": ["@hyav/pi-provider"],
  "pi": {
    "extensions": [
      "./providers/*.ts",
      "./status/*.ts",
      "./preflight/*.ts",
      "./tuners/*.ts"
    ]
  }
}
```

Host capability 目录中的文件与独立包中被通配符匹配的文件都必须默认导出（default export）Pi extension factory。独立 Adapter 包禁止重复声明或二次执行 Host 的 `index.ts`。

只有由 Pi 提供的核心 Host 包才应使用值为 `"*"` 的 `peerDependencies`。

## 文件契约

每个能力文件使用对应的 helper 导出单一适配器。`providers/`、`status/`、`preflight/` 下的内置 Adapter 遵循完全相同的写法，可作为参考模板：复制到 `<agent-dir>/extensions/pi-provider/` 后直接修改即可。只有 Charm Hyper 相关文件（以及 `preflight/openai-codex.ts`）额外依赖包内私有辅助文件，因此新增 Adapter 时建议以 `preflight/deepseek.ts`、`status/deepseek.ts` 或 `providers/` 下的简单文件为蓝本。

```ts
// providers/example.ts
import { defineProviderExtension } from "@hyav/pi-provider";

export default defineProviderExtension({
  id: "example",
  create: ({ fetch, now, modelDiscoveryTimeoutMs }) => {
    // factory 执行阶段仅返回同步可用的 fallback 或缓存目录；禁止阻塞网络请求。
    return createExampleProvider(fetch, modelDiscoveryTimeoutMs, now);
  },
});
```

其他目录分别使用 `defineStatusExtension`、`definePreflightExtension` 和 `defineTunerExtension`。身份元数据必须静态提供：

- Provider: `id`
- Status: `id`, `providerId`
- Preflight: `id`, `providerId`
- Tuner: `id`

Helper 会在实例化前校验静态身份描述符，并确认最终 Adapter 身份一致。Adapter ID 必须是非空、非空白且稳定的标识符；可以提供 named export 供程序化调用，但 default export 是 Host 内部 loader 与独立包 Pi loader 的共同契约。

## 生命周期

### 1. Extension Factory 阶段
Pi 在启动与 `/reload` 时重新执行 Host 根 extension factory。根入口先创建 Host，再按确定性路径顺序先扫描内置 capability 目录、后扫描用户目录（`<agent-dir>/extensions/pi-provider/` 或 `adapterRoot` 覆盖），加载每个当前存在的 `.ts` 或 `.js` 文件。所有 Adapter 在每次加载中共享同一模块缓存，因此被多个 Adapter 引用的文件只会执行一次。独立 Adapter 包仍由 Pi 根据自身 manifest 加载。适配器 helper 会：

1. 校验静态描述符；
2. 实例化 Adapter；
3. 通过 Pi Provider startup bridge 调用 Pi 的 `registerProvider()`；
4. 通过 `pi.events` 发布版本化注册信封（`version: 2`）；
5. 注册同步的 `session_start` replay handler。

Provider 必须在 factory 返回前完成 Pi 注册，确保初始模型选择和 `pi --list-models` 立即可用。动态 Provider factory 必须返回可同步使用的初始快照，不能在启动阶段阻塞网络请求。Status、Preflight 和 Tuner extension 在此阶段不会实例化 manager 或触发诊断网络请求。

### 2. `session_start` 阶段
Host 收到所有 Adapter 重放后构建当前会话注册表，按确定性规则初始化 Status、Preflight、Live Check 管理器与 Tuner 列表。独立的 Adapter factory 会并发实例化，同时保持注册依赖关系。

Host 的排序规则为：

- 每个 capability 命名空间内按 Adapter ID 排序；
- Tuner 先按递增 `priority` 排序，再按 Adapter ID 排序。

### 3. `session_shutdown` 与 `/reload`
上一个 Host 会取消未完成请求、清空缓存与诊断状态并解绑监听器。每个 Pi runtime 只支持一个活动 Host。`/reload` 重新执行根入口、扫描当前 capability 文件并构建全新 Host 实例：

- 新增文件在 reload 后生效；
- 修改的文件会重新从磁盘读取，因此编辑现有 Adapter 后 reload 即可生效；
- 删除的文件在 reload 后清理；
- 之前的 Status、Preflight 和 Live Check 状态不会泄漏到新 runtime。

## 校验与故障隔离

- 缺失 ID、空白 ID、身份不匹配、无效时钟配置将使对应模块失效；
- 重复 Adapter ID 或冲突绑定保留最新注册（用户适配器在内置之后加载，因此可覆盖内置）并发出警告，较早的条目被丢弃；
- Provider 冲突会清理动态覆盖，在存在原生 Provider 时恢复原生实现；
- 模块抛出异常、注册信封损坏或 default export 缺失仅隔离该模块，不影响其他健康适配器；加载失败使用 capability 相对路径报告，不暴露安装绝对路径；
- Status 和 Preflight Adapter 可以绑定由 Pi Provider 管理的 Provider 或 Pi 原生 Provider。无法解析的绑定只隔离对应 Adapter，并报告诊断警告。
