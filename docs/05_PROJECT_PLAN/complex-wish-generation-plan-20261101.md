# 复杂任务许愿式生成的能力核查与改进计划

日期：2026-11-01（Asia/Shanghai）。核查源码基线：`sprint2 / 09a39e6529a28fffb7200d008a0fcb238b83eea1`。本批为探查与计划，不实施下列运行时改动。

目标：用户描述整体愿望并确认关键业务取舍，Bloma 自主规划、分段制作、独立验证和持续维护。阶段交付可用、全局目标不丢失、旧数据与旧功能有保护；复杂性主要留在系统内部。

结论：保留 software-v1 的短任务单、持续 Pi、宿主验证及交付链。在其上补充项目级业务契约、可执行计划、跨阶段证据和有边界的自主推进。现有长期模式是“已确认范围的一轮制作 + 待办 + 阶段人工确认”，还不是完整的复杂项目执行器。首次闭环先做本机多模块应用；多人联网服务和云端运营属于另一层能力，不能因本机浏览器交付已存在就承诺已经支持。

## 1 核查方法与结论边界

- 从真实调用链核对需求提取、范围确认、长期状态、Pi、委派、能力组件、GUI/CLI 验收、质量台账、增量更新、发布及界面，而非仅按文件名判断实现存在。
- 入口交接为 [质量交接](session-handoff-quality-20261030.md) 顶部更新与 [Q1–Q4 方案](multi-agent-generation-quality-plan-20261030.md)。旧 Proma 主记忆的 Python 默认骨架、旧架构阶段及实验优先级不作为当前事实。
- 本次重跑 10 文件 / 55 项定向测试通过，见第 8 节。这证明相应本机机制与受控场景，不证明复杂真实愿望的一次成功率、付费模型收益或干净机器交付。
- 未修改用户原有 `production-workflow-v2-20261020.md`；没有启动生成任务或新增付费调用。
- “缺少”指本次所查现役链中没有相应结构化协议或接线；模型可能临时自行规划，这不等于宿主能持久执行和验证该计划。

## 2 现役流程与可复用能力

当前主链：`agent-dispatch → handleLeanGuide → stageLeanScope/确认 → UX确认或授权跳过 → runLeanProduction → Pi/委派/工具 → C/V和宿主验证/修复 → quick发布，或longterm封存候选并等待本阶段确认 → 用户选择下一轮待办或提出明确修改`。

| 环节 | 已有实现与入口（仓库根相对路径） | 复杂任务中的复用方式与边界 |
| --- | --- | --- |
| 需求和范围 | `main/guide/lean-brief.ts`、`lean-guide.ts`、`lean-scope.ts`；`main/project/requirement-contract.ts` | 有稳定 F 编号、预期、约束、假设、范围差异与确认哈希。保留用户简洁确认界面；内部结构需扩展。 |
| 长期状态 | `main/software/longterm-state.ts`、`longterm-control.ts`、`longterm-message.ts`；`shared/types.ts` 的 LongtermProjectState | 有 revision、校验和、一个当前里程碑、候选历史、待办、决策、确认中断恢复。复用存储和生命周期，补项目计划与任务依赖。 |
| 长任务执行 | `main/desktop/lean-production.ts`；`main/agent/loop/pi-runtime.ts`、`pi-session-store.ts` | Pi 持久会话、压缩与恢复注入；父循环不再受旧 96 轮约束。无需另造 Agent 执行器。 |
| 现场和恢复 | `main/software/working-context.ts`、`run-state.ts`、`context-catalog.ts`；`main/desktop/production-context.ts` | 当前源码、操作、未决进程、错误、近期工具及费用索引已存在。新增模块/任务/决策索引，不复制全聊天。 |
| 预算和运行归属 | `main/desktop/lean-budget.ts`、`production-budget.ts`；`main/platform/llm/monetary-budget.ts` | 主子任务共享请求、输出、金额保护；心跳租约、取消、累计用量保留。分阶段不能通过新 operation 绕过总预算。 |
| 协作 | `main/software/collaboration-policy.ts`、`quality-review.ts`；`main/agent/delegation/` | 当前最多两并发、文件归属、写入互斥、集成者运行命令、审阅冻结。保持边界，补任务契约和依赖满足条件。 |
| 能力组件 | `main/software/component-contracts.ts`、`integration-capabilities.ts`、`capability-tools.ts` | 已有数据、队列、HTTP工作流、文件、查询、AI设置、分发等契约、版本、限制和测试入口。应检查适配和使用证据，而非重新造通用组件库。 |
| 工程检索及影响候选 | `main/software/repository-context.ts`、`change-impact.ts` | 已有文件事实、导入工程差异、JS/TS静态相对依赖分析和建议测试。补业务/数据/接口影响，不能把静态候选当完整语义图。 |
| 真实验收与质量闭环 | `main/software/verification.ts`、`independent-design.ts`、`independent-semantics.ts`、`independent-verification.ts`、`quality-ledger.ts`；`main/desktop/core-verification.ts` | 独立案例、GUI/CLI、正常启动、候选身份、C/V台账和宿主复测可复用。补跨功能业务不变量与分层验收。 |
| 旧行为保护 | `main/software/regression-baseline.ts`；`main/desktop/lean-gui-tool.ts`、`lean-cli-check.ts`；`main/software/native-gui-registration.ts` | 未变更需求的原输入/断言不能悄悄删除；允许修定位。需升级为跨里程碑累计的业务基线。 |
| 数据与版本 | `main/software/release-store.ts`、`data-update.ts`、`user-launch.ts`、`source-checkpoints.ts` | 有不可变候选、依赖快照、数据副本迁移/读回、备份恢复、用户启动切换及选定源码还原。代码检查点不等于业务数据恢复，也不等于验证通过。 |
| 产品交互与测量 | `renderer/components/LongtermProjectPanel.tsx`；`main/software/state-view.ts`、`harness-evaluation.ts` | 有待办、阶段确认、决策/版本记录及执行/验证/目标分离；有用量、干预和修复分类记录。扩展项目级进度和跨阶段测量。 |

需要明确的现有限制：产品 data-store 是本机 JSON，契约标明最多 32 MiB/2万记录；jobs 是本机单 owner；HTTP 组件不提供 OAuth 或公网托管。任意工程命令可以实现更复杂的产品，但平台尚不能因此宣称已有对应成熟能力和验收保障。

## 3 已定位的关键缺口

| 编号/优先级 | 代码证据与现状 | 对复杂愿望的影响 | 需要补什么 |
| --- | --- | --- | --- |
| G1 P0 | `LEAN_BRIEF_PROMPT` 明确要求“不展开对象、规则、流程或三类状态图谱”；parseLeanBrief 把需求置为 P0。 | 多模块共享对象、状态变化、权限与计算规则主要依赖模型临时推理；功能清单难以表达业务整体。 | 用户短摘要 + 内部项目业务契约；每个规则保留来源、假设状态和影响范围。 |
| G2 P0 | `ensureLongtermState` 用整份当前 brief 的 positioning/requirements 建立里程碑；backlog 来自建议。 | 没有“整体已承诺目标—当前交付子集—后续必需工作”的结构；很难自动拆分并防止漏项。 | 产品目标与阶段执行范围分离，稳定需求映射、必需后续任务和可选灵感分离。 |
| G3 P0 | 现役 LongtermProjectState 无任务依赖/模块契约/完成证据引用；委派按写路径与指令运行。 | 文件互不重叠仍可能接口不兼容；模型任务结束不代表下游依赖可用。 | 持久任务图、契约版本、依赖状态及宿主验证后的完成转换。 |
| G4 P0 | `longtermPendingDecision` 每阶段需确认；`handleLongtermMessage` 对已交付的“继续”要求选择下一轮；`adopt_backlog` 再次确认。 | 原有流程刻意保护未授权范围，无法一次授权后连续推进既定复杂目标。 | 显式项目执行授权策略，区分内部任务、可试用里程碑、正式发布及高影响决策；不能简单删确认守卫。 |
| G5 P0 | 独立 B 案例最多12个、每案32步、单 feature；预期仅输入回显/逐字引用/未知；每功能必须 normal。 | 超过12项功能无法在当前 B 结构中逐项给正常案例；计算、关联、权限等跨功能规则表达有限。 | 分批案例、跨功能引用、可信计算/关系预期；冻结业务规则仍由宿主验证。 |
| G6 P1 | `change-impact.ts` 是有界JS/TS相对导入候选，明示动态加载/跨语言/数据/外部调用不完整；范围变更只列增删改。 | 加“审批”可能影响借还状态、历史数据、权限、通知，但当前没有业务层的完整影响计划。 | 需求—规则—模块—数据版本—案例—发布映射及变更影响报告。 |
| G7 P1 | working-state 有限现场摘要；longterm上下文只取最近20待办/12决策；总历史有100里程碑/100待办/200决策限制。 | 重要早期决策可能不进入当前上下文；长项目不能只靠扩大摘要和数组。 | 按当前任务检索有效决策、契约和依赖证据；归档分页，保留引用完整性。 |
| G8 P1 | `verificationFailure` 已分类；`recordSoftwareRepair` 同run同观察连续3次停止，跨续跑保存总次数。 | 能停住部分重复失败，但未形成持久的假设、诊断、方案切换和阶段预算分配。 | 受控诊断/修复记录、未改善判定、检查点恢复建议及重新规划入口。 |
| G9 P1 | 组件有版本/限制/本机契约证据，准备成功通常不等于业务可用；真实服务、ASR与安装另验。 | 高风险依赖可能到最后才暴露；“模块可加载”容易被误读为“产品能力可交付”。 | 实现前风险探针，分别标记资源就绪、接口通过、真实业务与目标环境通过。 |
| G10 P1 | 评估绑定一个固定目标，现有配对轴为 B-only；长期阶段确认后也发 delivery_final。 | 不能直接拿当前阶段成功或已有B对照报表评估整项目自主成功率。 | 项目/阶段/任务层级测量，保留总体未完成状态，另建多里程碑评估协议。 |

G1–G5 是首次复杂闭环的关键路径；G6–G10 随闭环增量接入。所有“没有”的判断限定为现役宿主机制，不能解读成模型完全没有这些能力。

## 4 推荐结构与约束

继续用一个制作/集成负责人、按需实施子任务及现有 C/V/B。规划作为结构化输入和宿主状态机进入同一条 software-v1 链，不固定增加一个经理模型，也不恢复旧 PRD/架构/裁判串行链。

建议引入以下最小数据关系（名称为拟议设计，不是已有API）：

| 对象 | 最少字段 | 权威与更新方式 |
| --- | --- | --- |
| ProductContract | revision、需求ID/来源、对象关系、规则/状态、约束、关键未知、默认假设 | 用户表达和确认是业务依据；Agent可提出结构化草案，宿主校验引用。技术默认可自主，新增业务承诺不得伪装默认。 |
| ProjectPlan | contract_revision、milestones、tasks、depends_on、需求覆盖、风险与探针、授权引用 | 宿主校验无环、无悬空依赖、全部必需需求有去向；缺少估算不伪造精确工期。 |
| ModuleContract | id/version、owned_paths、输入输出/错误、副作用、数据所有权、上下游、契约案例 | Agent提议，集成负责人统一；公共接口变更使依赖任务需要重新评估。不能从“互斥文件”推断接口正确。 |
| TaskRecord | id/revision、milestone_id、requirement_refs、输入契约、状态、attempt、证据引用 | proposed → ready → running → implemented → verified；blocked/cancelled保留。Agent只能报实现结果，宿主证据决定verified。 |
| ExecutionAuthorization | contract/plan边界、允许阶段、自动推进/发布策略、费用上限、外部副作用边界、撤销状态 | 明确用户授权，宿主持久化；当前“直接做/跳过草图”不自动成为无限阶段授权。 |
| ChangeImpactRecord | old/new revision、受影响规则/模块/数据/案例、未知项、迁移与恢复计划 | 静态分析与业务引用合并；不完整时保守扩展回归。代码变更不能由Agent自行声明所有旧证据继续有效。 |

业务权威仍是确认后的契约；上述对象引用既有 PrdBackplane、候选、费用和台账，不能复制出第二套互相矛盾的需求/发布数据库。可先将结构化扩展附于现有长期状态，遇到文件规模再拆分页存储。

阶段执行范围必须包含本阶段新增/变化的目标与受影响的已交付行为；整体尚未实现的必需目标留在项目计划中，不能变成可选建议，也不能被删除来让本阶段通过。质量身份增加当前执行范围/契约版本；涉及业务语义的修订使相关证据失效。首次实现采用保守失效，细粒度复用必须另有证明。

项目状态要区分“当前轮停止/阶段可用/整体达成”。只有全体必需里程碑验证完成、重要缺陷闭合、交付条件满足，才标记整体目标达成。失败或预算耗尽保留上个可用发布和剩余清单。

计划重排与业务改意需要分开：在既有授权范围内重排技术任务，不必再次询问用户，但须保留计划修订并校验依赖；改变业务承诺、已批准阶段集合或外部副作用时，暂停受影响分支并确认。更新业务契约、计划引用与确认记录必须支持崩溃恢复，不能出现新计划引用旧授权、旧任务结果覆盖新契约的混合状态。

## 5 按依赖排列的实施批次

### C0 固定基线与复杂任务样本

目的：用已有机制跑出起点，避免依据架构想象全面改造。

- 复用 `harness-evaluation.ts` 的事件与用量来源；增加只读项目级汇总设计，不改变原 B-only 比较口径。
- 固定三类自然语言任务及外部业务验收：实验室器材闭环、资料导入/检索/纠错工作台、外部数据同步/去重/恢复。需求仅描述用户目标，不加入内部工具名和测试锚点。
- 每题包含后续需求变更、真实重开和中断恢复。至少保留一个未参与组件调优的变体，记录所有失败，不只统计完成项目。
- 先使用离线受控接口验证链路；真实生成所需模型/渠道/预算按当次条件另行配置。
- 验收：基线报告能区分模型质量、环境阻塞、平台故障与用户改意；阶段成功不会记为整体成功。

### C1 项目业务契约与阶段范围

依赖：C0样本与指标定义；无需等待大规模模型对照。

- 修改：`main/guide/lean-brief.ts`、`lean-guide.ts`、`lean-scope.ts`、`main/model/prd-backplane.ts`、`main/project/requirement-contract.ts`、`shared/types.ts`。
- 新增建议：`main/software/product-contract.ts`、`project-plan.ts`，提供严格解析、引用校验、版本和当前阶段范围投影。
- 简单任务继续现有短链。用户明确长期/多阶段，或出现多角色、跨模块状态、外部写入/迁移等风险时生成内部结构；不只用字数/功能数判断复杂度。
- 从同一份产品契约生成简短确认内容。合理默认保留依据及可修改性；关键未知允许先做不依赖它的工作，不能强行猜答案。
- 覆盖反例：要求10项能力，只做3项时其余7项仍是必需后续工作；更新规则保留F编号；无依据规则不能自动变成必需验收；简单任务不增加确认次数。
- 完成标准：需求完整映射到阶段，阶段的验收与整体状态不混淆；旧software-v1长期状态可无损读取/升级，不恢复退役流程。

### C2 持久任务图与接口集成

依赖：C1。这是第一条工程关键路径。

- 修改：`longterm-state.ts`、`lean-production.ts`、`collaboration-policy.ts`、`agent-tools.ts`、`production-context.ts`；新增 `project-scheduler.ts`、`module-contract.ts`（拟议）。
- 首版先支持单负责人按依赖顺序执行；再接现有最多两个子任务。独立模块可并行，共享数据/公共接口由集成者负责，集成/验证仍在父端执行。
- 下游只有在所需契约和前置验证有效时可进入ready；子任务“完成”只到implemented。更新依赖契约使相关任务和证据变为待重验。
- 状态写入受现有执行租约与revision约束；派发使用稳定任务/attempt标识。宿主重启先核对事实，不自动重放安装、迁移或外部写入。
- 覆盖反例：循环依赖、悬空任务、冲突路径、旧契约结果、并发迟到写入、取消后旧结果、派发前后崩溃、摘要称完成但未集成。
- 完成标准：三个模块按依赖完成集成；中断恢复后不重复已完成副作用；失败模块阻止依赖任务，独立任务在授权范围内可继续。

### C3 项目授权与连续推进体验

依赖：C1/C2。先有可靠状态与完成依据，再减少人工停顿。

- 修改：`longterm-control.ts`、`longterm-message.ts`、`confirmation-journal.ts`、`production-budget.ts`、`state-view.ts`、`LongtermProjectPanel.tsx`；补IPC类型及既有入口处理。
- 首版允许用户一次批准明确的阶段集合和总边界；内部任务自动推进。正式发布默认沿现有确认；若用户明确授权逐阶段自动发布，则按该策略执行并保留撤销入口。
- 区分用户暂停、等待业务决定、缺外部条件、预算停止和任务失败；恢复不能自动放宽授权。
- 项目级总预算约束阶段用量，预留验证与修复容量；B的独立用途/预算保持原边界。阶段切换不隐式刷新总额度。
- 覆盖反例：旧授权不能执行新范围；跳过草图不等于批准待办；取消阻止下一任务；预算耗尽不会“换阶段再花”；确认崩溃不能误发布。
- 完成标准：已授权的三个内部阶段连续推进，中途不为实现细节询问；新增重要业务决定只询问一次，准确说明影响与可继续部分。

### C4 跨模块业务验收与累计回归

依赖：C1；接入C2任务闭环，与C3可分开实施，但首个对外复杂版本须同时具备。

- 修改：`independent-semantics.ts`、`independent-design.ts`、`independent-verification.ts`、`quality-ledger.ts`、`verification.ts`、`regression-baseline.ts`及原生GUI登记/执行适配。
- 原生GUI脚本已能表达复杂操作，优先复用。扩展业务案例的多需求引用与规则来源；对计算/关系断言提供有界的类型化预期，不把任意生成脚本提升为业务权威。
- B按阶段/业务旅程分批设计并冻结，每批有限大小、稳定ID、版本及共享总预算；完整覆盖检查跨批聚合。保留每条争议，不因拆批取消旧失败或静默重发费用请求。
- 建立模块契约检查、跨模块业务旅程、阶段回归、最终累计验收四层；开发期选测不绕过正式交付门。
- 代表案例：器材借出后不能再被另一借用单占用；归还转维修后不可借出；修复后恢复可借；重开保留整个过程；是否允许这些操作以确认业务规则为准。
- 覆盖反例：超过12项需求分批仍无遗漏；两个模块单测通过但关联错误；一个阶段通过不清除另阶段缺陷；修改预期或用新案例ID不能掩盖旧失败。
- 完成标准：独立注入跨模块关联错误被发现并同规则复测关闭；旧阶段关键流程在新版本仍可通过。

### C5 变更影响和长期上下文

依赖：C1/C2/C4。

- 修改：`change-impact.ts`、`repository-context.ts`、`working-context.ts`、`production-context.ts`、`longterm-state.ts`、`regression-baseline.ts`；新增业务影响映射（拟议 `business-impact.ts`）。
- 合并已有静态导入候选与需求/接口/数据/案例引用。增加审批等变更应能定位受影响流程，而不仅显示文件差异。
- 决策具有适用范围、依据、替代关系和状态；任务上下文取有效相关决策，不只取最近12条。提供分页历史和归档，不将全工程/全记录塞入每个会话。
- 数据升级复用 `data-update.ts`：预演迁移、旧数据副本读回、失败保留原版本。源码回退和数据回退分别处理，不能一键盲目恢复两者。
- 覆盖反例：早期关键规则跨压缩仍可检索；废弃接口不会出现在新任务材料；修改共享实体使所有消费者重验；迁移失败不损失原记录。
- 完成标准：已交付两轮后追加审批需求，系统给出有依据的影响范围并修改；原数据、历史记录与不受影响功能通过回归。

### C6 风险探针与有依据的修复

依赖：C1/C2；风险探针可在C1阶段先接最小版本。

- 复用 `component-contracts.ts`、能力检查/准备、`verification-diagnostics.ts`、`run-state.ts`、`source-checkpoints.ts`；增加任务级风险与修复记录。
- 技术不确定性高的路径先做最小真实探针，如连接实际协议、导入代表文件、准备并调用语音资源。资源准备/接口契约/真实服务效果/目标机器四种证据分开。
- 保存失败观察、假设、诊断动作、修复版本和结果；重复失败先换诊断，不无限重写。跨run跟踪同一问题，保留显式恢复意图和总预算。
- 组件超出数据量、并发或平台边界时升级实现方案，不假定现有JSON存储可直接支持多人系统。
- 完成标准：受控故障中能分辨测试适配、产品错误、依赖故障和外部未知；无改善时保留可用版本与剩余计划，不能自动降低验收要求。

### C7 整项目验证与逐步扩大能力边界

依赖：C1–C6首个闭环。

- 三类复杂任务分别验证从愿望到多轮交付、修改、重启和恢复；预登记外部验收标准与模型配置，保留未参与调优的任务。
- 指标：整体目标达成、首次可用阶段时间、最终缺陷、真实用户干预（区分主动改意/必要决定/平台求救）、无效修复轮数、回归/数据损失、总耗时和全链费用。每个指标分母包含失败/受阻任务。
- 初期样本用于定位瓶颈，不用三题声称可靠性达到某个百分比；是否扩展取决于真实成品和故障分布。
- 复杂本机应用稳定后，再另立多人联网能力批次：身份/权限、服务端事务与并发、OAuth/凭据生命周期、部署运维、服务监控/备份，以及多用户实际验收。不要把这批混进第一阶段。

## 6 首个可交付增量

建议先完成 C0/C1，然后以一个“器材登记—借还—维修”的本机产品贯通 C2/C3/C4 的最小实现，并带上 C5 的版本引用和 C6 的基本风险检查。此处是生成产品任务，不直接编写一个器材模板来替代生成能力。

内部里程碑示例：M1登记与可靠保存；M2借还与对象关联；M3维修与可借状态联动。先确认全部目标及关键规则，按阶段交付，追加“借用需审批”作为变更验收。性能、多人和远程服务没有在本轮确认就不额外加入。

这一增量必须同时证明：

1. 用户一次明确授权后，系统能执行既定内部阶段；范围外建议仍不进入制作。
2. M1可用时，M2/M3仍明确未完成；M2失败不撤销M1已发布版本。
3. 重启Bloma后可恢复计划、预算、任务及证据；既有有副作用的操作不重复执行。
4. 跨模块错误由真实操作发现，修复后保留此前成功行为。
5. 原有用户数据在升级失败时保留，成功后读回；源码恢复与数据恢复有独立依据。
6. 一般quick任务仍走原短链，无额外规划或确认负担。

这是首次工程范围。C5/C6剩余能力依据真实失败补齐，再进入C7扩展；不需要先建设通用知识图谱平台或全自动云运维系统。

## 7 复用与删繁原则

- 保留 Pi、现有委派、权限/费用和宿主证据体系；项目调度器只管理任务状态与选择，不另写模型循环。
- 项目业务契约补齐短任务单无法承载的信息；用户继续看简短结果，不承担内部技术方案确认。
- 旧 `main/desktop/dispatch-experiment.ts` 虽有 depends_on 与无环校验，但文件声明只读历史结构，`workflow-retirement.ts` 禁止其执行。可参考纯算法，不恢复实验调度/预算/角色链。
- 本地上游 `proma-upstream / bf3e98c` 的 `agent-session-context-prompt.ts` 已采用按索引渐进读取历史，可参考该检索方式；当前Bloma已有Pi恢复摘要，不用旧上下文注入替换新执行器。
- 不放开子任务任意命令、不增加默认并发、不用全员互审代替实际集成；如以后要求并行构建，应先实现独立执行环境和可验证合并。
- 不将历史100条上限、B的12案例上限直接全部调大；先做分页、批次及引用一致性，维持有界输入和总预算。
- 技术选择由系统承担；会改变业务承诺、真实数据、费用或发布边界的选择才进入明确用户决策。

## 8 本次验证与后续验收安排

本次命令：

```powershell
npx vitest run tests/unit/software/longterm.test.ts tests/unit/software/long-task-recovery.test.ts tests/unit/software/collaboration.test.ts tests/unit/software/release-update.test.ts tests/unit/software/regression-baseline.test.ts tests/unit/software/working-context.test.ts tests/unit/software/quality-review.test.ts tests/unit/software/independent-quality.test.ts tests/unit/software/product-workflows.test.ts tests/unit/guide/lean-guide.test.ts --maxWorkers=2 --minWorkers=1
```

结果：10文件、55项通过。包含真实临时文件/Pi受控查询、本机HTTP/GUI隔离执行、100条SQLite数据的失败迁移与恢复等测试；不是生产账号或真实付费模型的复杂生成对照。未做完整仓库测试、用户当前实例操作或干净机器安装验收。

后续每批先做协议/状态转换和失败注入，再做受控完整流程；阶段闭环后用真实模型任务及独立成品试用验证效果。真实费用测试先核对当时路由、费率、余额、完整输入预留和明确预算，不沿用历史实验额度。

建议新增的测试入口如下，均为拟议文件，不能当作已有覆盖：

| 批次 | 建议测试入口 | 核心验证 |
| --- | --- | --- |
| C1 | `tests/unit/software/product-contract.test.ts`、`project-plan.test.ts` | 需求来源、完整覆盖、稳定ID、阶段投影和业务修订失效；回归现有lean-guide/longterm。 |
| C2 | `tests/unit/software/project-scheduler.test.ts`、`module-contract.test.ts`；`tests/integration/software-project-recovery.test.ts` | DAG、契约变更、重复派发、租约丢失、崩溃恢复和真实文件集成。 |
| C3 | `tests/unit/software/project-authorization.test.ts`；扩展 `tests/unit/longterm-panel.test.tsx` | 范围和预算边界、暂停撤销；隔离Electron验证授权卡、进度与重开。 |
| C4 | `tests/unit/software/cross-module-acceptance.test.ts`；`tests/integration/software-milestone-flow.test.ts` | 分批独立案例、跨模块故障注入、旧阶段回归与整项目完成条件。 |
| C5/C6 | `tests/unit/software/business-impact.test.ts`、`project-repair.test.ts` | 有效决策检索、影响不完整时保守回归、迁移/修复失败保留。 |
| C7 | 新的项目级真实任务协议与独立产物验收报告 | 原始愿望到成品的完整结果，不以受控测试替代真实生成评价。 |

扩展时需要专项观察的容量边界：当前默认共享请求上限256、输出262144 token；子任务24轮；源码观察检查点最多3000文件/单文件8 MiB/总32 MiB；静态影响扫描最多1500个JS/TS文件。它们分别限制执行、观察与分析，不都是产品体积上限。先按代表任务记录命中情况，再决定按需分页、差量快照或配置调整，不统一取消保护。

文档交付检查：核对上述现有路径、拟议路径标记、相对文档链接、`git diff --check` 和既有 `npm run docs:check`。后者主要检查IPC约定，不替代本文语义和链接校验。
