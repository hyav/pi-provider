# Adapter Extension 设计

[English](adapter-extensions.md)

本文定义 Provider Kit 动态扩展适配器的公共契约，描述其使用方式、生命周期和故障隔离边界。

## 目标

用户与开发者可以通过以下方式扩展 Provider Kit 能力，无需修改 Provider Kit 的 `index.ts`：

1. 在已安装包的对应 capability 目录中添加或删除 TypeScript 文件；
2. 安装另一个本地、npm 或 Git Pi 扩展包；
3. 执行 `/reload`。

新发现的 Provider、Status、Preflight 与 Tuner 在 reload 后自动并入同一个 Provider Kit Host 实例。活动会话内不支持不经过 reload 的热替换。

## 包布局

Provider Kit Host 包与独立的 Adapter 包均遵循标准 capability 目录约定：

```text
package-root/
  index.ts                 # Provider Kit Host（每个运行时唯一）
  providers/*.ts           # Provider Adapter Extensions
  status/*.ts              # Status Adapter Extensions
  preflight/*.ts           # Preflight Adapter Extensions
  tuners/*.ts              # Tuner Adapter Extensions
```

`package.json` 使用 Pi 官方清单规范。Host 包声明全部 capability 入口：

```json
{
  "pi": {
    "extensions": [
      "./index.ts",
      "./providers/*.ts",
      "./status/*.ts",
      "./preflight/*.ts",
      "./tuners/*.ts"
    ]
  }
}
```

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

被通配符匹配的文件必须默认导出（default export）Pi extension factory。独立 Adapter 包禁止重复声明或二次执行 Host 的 `index.ts`。

只有由 Pi 提供的核心 Host 包才应使用值为 `"*"` 的 `peerDependencies`。

## 文件契约

每个能力文件使用对应的 helper 导出单一适配器：

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

Helper 会在实例化前校验静态身份描述符，并确认最终 Adapter 身份一致。Adapter ID 必须是非空、非空白且稳定的标识符；可以提供 named export 供程序化调用，但 default export 才是 Pi loader 的契约。

## 生命周期

### 1. Extension Factory 阶段
Pi 在启动与 `/reload` 时重新执行所有 extension factory。适配器 helper 会：

1. 校验静态描述符；
2. 实例化 Adapter；
3. 通过 Provider Kit startup bridge 调用 Pi 的 `registerProvider()`；
4. 通过 `pi.events` 发布版本化注册信封（`version: 2`）；
5. 注册同步的 `session_start` replay handler。

Provider 必须在 factory 返回前完成 Pi 注册，确保初始模型选择和 `pi --list-models` 立即可用。动态 Provider factory 必须返回可同步使用的初始快照，不能在启动阶段阻塞网络请求。Status、Preflight 和 Tuner extension 在此阶段不会实例化 manager 或触发诊断网络请求。

### 2. `session_start` 阶段
Host 收到所有 Adapter 重放后构建当前会话注册表，按确定性规则初始化 Status、Preflight、Live Check 管理器与 Tuner 列表。独立的 Adapter factory 会并发实例化，同时保持注册依赖关系。

Host 的排序规则为：

- 每个 capability 命名空间内按 Adapter ID 排序；
- Tuner 先按递增 `priority` 排序，再按 Adapter ID 排序。

### 3. `session_shutdown` 与 `/reload`
上一个 Host 会取消未完成请求、清空缓存与诊断状态并解绑监听器。每个 Pi runtime 只支持一个活动 Host。`/reload` 重新扫描清单文件并构建全新 Host 实例：

- 新增文件在 reload 后生效；
- 删除的文件在 reload 后清理；
- 之前的 Status、Preflight 和 Live Check 状态不会泄漏到新 runtime。

## 校验与故障隔离

- 缺失 ID、空白 ID、身份不匹配、无效时钟配置将使对应模块失效；
- 重复 Adapter ID 或冲突绑定将被同时排除，防止因加载顺序造成隐式胜出；
- Provider 冲突会清理动态覆盖，在存在原生 Provider 时恢复原生实现；
- 模块抛出异常、注册信封损坏或 default export 缺失仅隔离该模块，不影响其他健康适配器；
- Status 和 Preflight Adapter 可以绑定 Provider Kit Provider 或 Pi 原生 Provider。无法解析的绑定只隔离对应 Adapter，并报告诊断警告。
