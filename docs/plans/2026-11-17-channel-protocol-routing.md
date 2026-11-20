# Channel Protocol Routing Implementation Plan

**Goal:** 按请求协议而非供应商品牌判断角色渠道可执行性，使现有普通 Qwen、OpenAI 兼容和自定义渠道能端到端执行 Agent。

**Architecture:** 共享层提供协议定义、穷尽的供应商默认映射与渠道有效协议解析；供应商只充当预设和兼容特例。main 用按协议注册的请求/流适配器，统一进入现有 streamSSE、权限与费用准入、用量记录。渠道可显式覆盖协议，旧文件不改写、没有 protocol 时按默认值解释；未知协议失败关闭。先完整支持 Anthropic Messages 与 OpenAI Chat Completions，Responses/Gemini 明确展示尚无 Agent 执行适配器，不假称实现。

**Tech Stack:** TypeScript / Electron / React / Jotai / Vitest / Playwright Electron。

**Workspace:** 在当前 checkout 延续本会话未提交修复，不复制或覆盖脏工作区。用户既有生产流程文档修改不动；不提交、不访问真实密钥、不发真实模型请求、不改变用户角色路由。

## Task 1 — 共享协议契约与失败回归

- Create `shared/channel-protocol.ts`；modify `shared/types.ts`。
- 新增 `ChannelProtocol`、可选 `protocol`（创建/更新 null=恢复默认）、探测与目录输入透传。
- 协议定义包含展示名及执行能力；默认映射覆盖 ProviderType，但不限制自定义地址或模型名。
- 先添加 `tests/unit/channel-protocol.test.ts`：Qwen/custom 普通聊天放行、旧默认行为保留、显式覆盖优先、非法协议拒绝、未实现协议明确不可执行。
- Run `npx vitest run --configLoader runner tests/unit/channel-protocol.test.ts --maxWorkers=2 --minWorkers=1`，先观察缺失实现红灯，再实现并验证绿灯。

## Task 2 — main 协议注册与配置/探测贯通

- Create `main/platform/upstream/providers/agent-protocol-registry.ts` 与协议 URL 工具。
- 注册 Anthropic/Chat 请求构建及 SSE 适配器；标准 Chat 不泄漏 Anthropic 私有 thinking/output_config，保留已验证厂商特例。
- Modify `main/platform/llm/channel-manager.ts`：协议校验、持久化、默认继承、URL规范、测试/目录分发；现有 provider 专用测试仅在实际协议匹配时使用。
- Modify `main/platform/upstream/providers/loop-query.ts`：通过注册表选择传输，保留 DeepSeek 图片兼容、超时、取消、重试、准入和计量。
- `buildSdkEnv` 携带明确协议；贯通 runtime-fallback、delegation-channel、independent-design/settings。
- 修改类别保存/默认/备用及独立验收，以完整渠道协议判定而非 provider 白名单。

## Task 3 — 配置 UI 与可解释的不可用状态

- Modify `renderer/components/ChannelSettingsPage.tsx`：请求协议选择及跟随默认；保存/编辑/测试/拉取均带协议；协议变化使在途结果失效。
- 角色选项不再静默藏掉未实现协议，显示禁用项及原因；可执行性与 main 共用共享契约。
- 保留模型元数据、未保存角色草稿、无效备用局部移除和凭据目标绑定。
- 添加 UI 回归：Qwen27B可选、任意模型ID可用、自定义协议覆盖、未实现协议解释、编辑往返及过期探测。

## Task 4 — 执行及守卫回归

- 新增真实 loopback HTTP/SSE 集成测试：Qwen/custom 的工具调用→工具结果回传→最终文本、交错工具参数、最终usage；Anthropic原链、协议覆盖、取消/错误/备用。
- 断言请求准入拒绝时无网络、账本准确记物理请求/用量、未知/未实现协议在请求前失败。
- 旧“openai 不支持”测试改用明确尚未实现的协议，不能删掉负面覆盖。
- Run relevant unit/acceptance plus `npm run typecheck` and `npm run build`。

## Task 5 — 隔离 Electron 验证、审查与交付

- 扩展/新建 `scripts/verify-channel-protocol.mjs`：独占临时 PROMA_HOME、profile、本地假服务，模拟现有 `qwen` 渠道缺 protocol 的 27B 数据。
- 验证角色可选→保存→刷新；显式协议编辑往返；经真实 main 的实际 loop 发送正确路径/鉴权/工具历史。不得用测试桥写入生产IPC或绕过费用守卫。
- 独立只读审查边界后修复重要问题；等待协作收敛。
- 更新 `docs/05_PROJECT_PLAN/model-config-upstream-alignment-20261117.md` 与必要的项目护栏；报告两种已执行协议与未实现协议的准确边界。
- 只清理本次拥有的临时实例，保留报告及用户环境；不自动提交 Git。

## 执行结果

全部任务完成。实现与证据见 `docs/05_PROJECT_PLAN/model-config-upstream-alignment-20261117.md` 的「协议解耦架构」一节；回归 29 文件 / 349 测试、隔离 Electron 5 组检查通过。协议矩阵与真实 HTTP 工具循环覆盖两个已实现协议，Responses / Gemini 保持失败关闭。
