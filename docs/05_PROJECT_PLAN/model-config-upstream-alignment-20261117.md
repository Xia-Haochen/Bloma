# 模型配置上游对齐实施记录

## 目标与基线

修复 Bloma 模型配置从表单、渠道存储到实际请求的一致性问题，不整体替换 Pi 桥接，不扩展 OAuth 产品范围。

- Bloma：当前 `sprint2` 工作区，保留既有未提交的生产流程文档修改。
- 上游：`https://github.com/proma-ai/Proma.git`，2026-11-17 通过 `git ls-remote` 与独立 fetch 核验 HEAD `86d9dfb511db4c1e3ffded3b6c3e312996f50cbf`，未切换上游工作树。另以本地 `bf3e98c` 核对历史实现。
- 参考文件：上游 `packages/shared/src/types/channel.ts`、`apps/electron/src/renderer/components/settings/ChannelForm.tsx`、`apps/electron/src/main/lib/channel-manager.ts`、`apps/electron/src/main/lib/adapters/pi-model-registry.ts`。
- 技术栈：Electron / React / Jotai / TypeScript / Vitest。

## 已告知的不足

1. Google 模型目录将显示名写入本项目实际调用所用的 `name`，可能发错模型；不能机械地把所有 `name` 改成上游的 `id`。
2. 供应商切换残留地址、模型、探测状态；通过 `channel_id` 隐式复用旧密钥未绑定目标。
3. UI 没检查 `FetchModelsResult.success`，未防过期请求回填，合并会丢元数据。
4. 界面不能设置已存在的最大输出限制；公共请求出口尚未统一应用显式输出限制。
5. Agent 默认与备用渠道未完整过滤运行时不支持的协议。
6. 智谱团队复合凭据可能被当作完整 Bearer 发出，连接测试仅凭可解析就宣称成功；Coding Plan 探测头与真实请求不一致。

## 实施步骤

1. 增加后端与 UI 红灯回归：模型 ID/显示名、元数据、密钥跨目标拒绝、旧请求回填、内层错误、输出限制、协议过滤和团队认证。
2. 为密钥复用增加共享的 provider/origin HTTP(S) 检查，并在探测、拉取、保存更新中执行；显式重新输入密钥仍允许用户接入新目标。
3. 保持 Bloma `name=请求模型 ID`、`id=本地标识` 的既有契约，增加独立 `display_name`；保留手动模型与能力覆盖，不整体迁移用户渠道文件。
4. 修复表单切换与请求生命周期，展示供应商原始错误，补输出上限输入；新拉取模型仍按 Bloma 原有约定默认启用，不照搬上游自动保存或权威清单删除行为。
5. 使用同一认证头构造器处理目录与推理，团队测试必须取得服务响应；默认/备用渠道只选择本项目 Agent 支持的协议。
6. 公共物理请求出口应用绑定 model+origin 的显式输出上限，保留 provider 硬限制、费用准入与计量。
7. 运行定向 Vitest、类型检查、生产构建，并尽可能验证真实隔离 Electron 窗口；如桌面能力不可用，明确区分替身 UI 与真实持久化覆盖。

## 角色 Agent 配置故障补充

用户补充“每一阶段的角色 agent 也不能正常配置”，并明确选择先处理**配置入口或保存故障**，不是重新定义阶段、编辑提示词或新增角色。因此本轮保留 `guide`（需求沟通）与 `programming`（界面与制作，共用 sketch/mvp）的现有产品分组。

已定位并修复：

1. 角色接口加载失败会静默隐藏整个区域：现在保留入口，显示错误并提供重新载入；过期读取不覆盖新结果。
2. 渠道 CRUD 后角色视图不刷新：现在更新可选项和已保存状态，同时保留尚未保存的角色草稿。
3. 禁用、无启用模型及不支持 Agent 协议的渠道仍能配置：现在不允许新选；旧失效主引用明确展示，允许恢复自动。
4. 保存端剥离无效引用后仍返回成功：角色保存改成整体校验通过才写盘，具体说明主渠道或备用渠道的问题；UI 不再用通用“缺少信息”掩盖该领域错误。历史类别级兼容接口仍保持原契约。
5. 严格校验会让隐藏的失效备用阻断保存：备用区现在保留已删除/不可用引用、提示原因并可单独移除，不要求清空其他角色。该项由独立只读审查提出，并经真实 Electron 复现及修复验证。
6. 旧 sketch/mvp 配置不同的 mixed 状态下，仅编辑备用可能覆盖主配置：未明确选择统一主渠道或统一为自动前，禁止编辑备用顺序。
7. `ready/completed` 的 software-v1 项目继续修改会误用 guide 渠道：新增统一的 `categoryForExecution`，按实际制作执行器选择 mvp；提交、恢复及 dispatch 使用同一规则。回归使用不同 guide/production 模型，并捕获传入制作执行器的实际 env，而非只检查下拉框。

### 当前配置语义与保留边界

- 路由仍选择渠道，实际模型为该渠道首个 enabled 模型；没有在本轮假装支持每阶段独立模型、拆分 sketch/mvp 或制作内部子角色独立换模。
- 保留“显式请求渠道 → 类别路由 → 全局默认”以及基础设施故障备用的优先级。当前 renderer composer 不发送显式 `channel_id`；不能把其认定为本次 UI 问题根因。
- 新设置对下次新执行或进入阶段生效，不热切换已启动的连续制作 loop。
- 旧设计/制作交接中解析失败时沿用上一 env 的兼容分支未在本轮重定义；正常渠道解析与本轮修复的已完成项目后续制作已覆盖，不能据此宣称所有失效交接策略均已重构。

## 不在本轮内

- Codex / Copilot / xAI OAuth、自动保存、完整新供应商迁移。
- 把支持目录查询的所有协议都宣称为支持 Agent，或整体照搬上游原生传输绕过 Bloma 费用/权限守卫。
- 实际付费请求、恢复实验预算、改写真实用户模型配置或上游工作树。

## 验证结果

- `npm run typecheck`、`npm run docs:check`、`git diff --check`：通过。
- `npm run build`：通过；有既有 npm 配置、lucide 指令忽略及大 chunk 提示，无构建错误。
- 定向回归：**23 个文件、258 项测试通过**，覆盖渠道目录/模型标识/上下文、输出限制及请求准入、认证、默认与备用、角色持久化与修复、设置页及现役需求/UX，以及 completed/ready 实际制作选路。不是全仓测试通过声明。
- `node scripts/verify-channel-config.mjs`：真实生产构建 Electron + preload + IPC，通过 **9 组集成检查**，包括安全存储、独立限制编辑、角色保存及刷新、失效备用局部修复、服务目标改变拒绝复用密钥、禁用渠道拒绝并明确显示。只向本地随机端口假服务发送两次 `/v1/models` GET，未调用真实模型。
- 脚本使用独占临时绝对 `PROMA_HOME` 与 Electron profile，退出后删除本次创建的临时目录；假密钥不明文出现在保存文件或返回的渠道数据中。真实用户渠道、实验账本及上游工作树均未改写。
- 证据：`run-artifacts/channel-config-20261117/report.json`、`channel-editor.png`、`role-routing-unavailable.png`；定向测试、类型检查及构建日志在 `.cache/model-config-*.log`，均为忽略的运行产物。
- 验证分层：Vitest 使用测试安全存储适配器；Electron 检查使用真实 main/preload/IPC 与系统安全存储。Playwright 的 Electron 页面操作不是 Cua/操作系统级桌面验收；本机未提供 Cua。未验证真实提供商账号、订阅额度、付费生成、安装包或干净机器交付。

## 协议解耦架构（Qwen / 自定义渠道修复）

### 问题与根因

用户的 27B 渠道类型为 `qwen`、模型 `qwen3.8-27b` 已启用，但角色下拉仍不可选。根因不是保存故障，而是执行能力被固定成**供应商品牌白名单**：`isAgentProtocolProvider(provider)` 只接受 Anthropic Messages 家族与 `zhipu` 两家协议分支，其余品牌一律拒绝。同时传输层用 `providerType === 'zhipu' || deepseekVision` 选择 OpenAI Chat 适配器，因此即使把 `qwen` 加入白名单，也不能正确连上执行路径。

### 新边界

- 渠道新增可选 `protocol`：`anthropic-messages` / `openai-chat-completions` / `openai-responses` / `google-generate-content`。缺省不写文件，按供应商默认协议解释，旧 `bloma-channels.json` 不需迁移。
- `shared/channel-protocol.ts` 是协议单一真相源：协议标签、每个预设的默认协议、有效协议解析以及“是否存在 Agent 执行适配器”。`ANTHROPIC_PROTOCOL_PROVIDERS` 降级为由默认映射派生的旧兼容视图。
- `main/platform/upstream/providers/agent-protocol-registry.ts` 按协议注册请求构建与 SSE 适配器，穷尽类型保证 UI 不可能先放行 main 尚未实现的协议。当前登记两个协议；Responses / Gemini 明确失败关闭并显示原因。
- 传输层仍走同一个 `streamSSE`，因此请求准入、金额预留与结算、`requestGuard`、重试、usage 归一化、运行观测都未被新协议绕开。
- `buildSdkEnv` 保留既有 env 键，新增 `BLOMA_CHANNEL_PROTOCOL` 与 `BLOMA_CHANNEL_PROTOCOL_SOURCE`（`preset` 表示未显式选择）。协议随 env 贯通主路、构建期与请求期备用、显式委派、独立验收，无需每个调用方另传参数。
- 显式协议优先于品牌特例：只有未显式选择的 DeepSeek Anthropic 渠道遇到图片时才沿用既有 Chat 兼容切换；显式 Anthropic 的自定义网关不会被执行层偷换协议，也不会被小米等品牌的 URL 重写丢掉网关前缀。
- 厂商思考控制在两条通用协议下收敛：标准 Chat 不再携带 Anthropic `thinking` / `output_config` 或历史 `reasoning_content`，也不会因模型 ID 命中 GLM Flash 规则而在本地被拒；智谱/DeepSeek 的已验证特例仍保留在各自预设上。
- 角色可选性、IPC 保存校验、全局默认、备用链、委派与独立 B 统一使用 `isAgentChannel(channel)`；不可用项在 UI 中显示为禁用并给出具体原因，而不是静默消失。

### 同期修复的安全边界（审查发现，非本次新增）

`sse-reader` 与渠道探测原先使用 `fetch` 默认重定向：307/308 可让实际请求落到未经过 `requestGuard`、金额预留和计量的其它 host，并继续携带 `x-api-key`。现在模型请求与连接/目录探测都使用 `redirect: 'manual'`，以 `MODEL_REQUEST_REDIRECT_BLOCKED` 明确失败，不自动跟随。

### 验证

- 定向回归 **29 个文件、349 项测试通过**，包含新增的协议矩阵、旧配置兼容、探针与执行一致性、跨协议备用、显式委派/独立 B、真实 HTTP 工具续轮、重定向、计量与缺失 usage。
- `node scripts/verify-channel-protocol.mjs`：生产 Electron 渲染器/preload/IPC 加独立 Electron 主进程运行同源编译产物，通过 **5 组检查**；三个实际工具循环（qwen 默认 Chat、custom 显式 Anthropic、custom 清回默认 Chat）均完成两次物理请求、真实文件工具结果回传与完整 usage 记账。只访问本地回环假服务，未使用真实密钥或付费模型。
- `npm run typecheck`、`npm run build`、`npm run docs:check`、`git diff --check` 通过。
- 未验证：真实 Qwen/自定义账号的实际生成、Responses/Gemini 执行、原生 Cua 桌面验收、干净机器安装。用户真实 `bloma-channels.json` 未被改写；从代码看该 27B 渠道重启后即可直接选入角色。
