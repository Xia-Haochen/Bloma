# Bloma 组会技术实现核对说明终稿

配套[完整讲稿终稿](group-meeting-script-20261114.md)。生产代码基线为 `686c0af`，汇报覆盖 2026 年 10 月 14 日至 11 月 13 日。本说明依据当前代码核对，后续提交为文稿更新，用于理解实现、准备追问和限定结果口径。

**先核对当前主流程与汇报重点**

用户沿同一个 Bloma 主会话完成需求沟通、确认与制作。`handleLeanGuide` 负责准备阶段的结构化回复、澄清和任务单；确认后经 `enterDesktopLine` 把同一 session ID 传入 `runLeanProduction`。制作进入持续 Pi 循环。准备与制作有不同调用逻辑和可配置模型路由，共享产品会话身份与确认材料。

当前指令明确采用一个主负责人直接实现，只在工作独立且值得并行时委派。普通实现委派属于可选工具能力。本月扩展能力边界的重点是独立实验委派，讲稿以“关键未知→实验子 Agent→封存证据→主负责人集成复验”为主线。

入口见[需求与确认](../../main/guide/lean-guide.ts)、[制作入口](../../main/desktop/lean-production.ts)、[默认工程指令](../../main/software/agent-tools.ts)。

正常新项目的主线为需求回复或澄清与任务单→确认目标及适用的界面确认→主负责人持续制作→按需独立实验与集成→登记测试并由宿主实际验证→必要的候选审阅与问题处理→快速项目发布或长期里程碑待确认。失败返回当前制作上下文，成功后的收尾由宿主继续执行。

首个适用的正式验证入口，在缺少有效覆盖审阅时调用 `quality.ensureCoverage`。此时的 C 子会话 purpose 为 coverage，用于核对业务旅程与测试覆盖。候选通过后的审阅另有 candidate、binding 等用途。可选 B 则在制作前运行。各用途接在不同时间点，终稿以当前入口调用顺序解释。

调用位置见[verify_app 的 beforeVerify](../../main/software/verification-tool.ts)、[覆盖审阅](../../main/software/quality-review.ts)、[advanceCloseout 与长期里程碑分支](../../main/desktop/lean-production.ts)。

**核心机制　独立实验子 Agent 怎样扩展能力边界**

主 Agent 调用既有 `delegate_agent`，task 描述未知问题，experiment 携带 criterion 和可选 inputs。代码中的 explore 角色属于只读代码探索。可执行实验使用 implement/custom 或默认角色，并由 experiment 参数选择独立实验工具配置；显式 readOnly 和共享工程 writePaths 不能与该实验契约混用。

`createSoftwareCollaborationPolicy.prepare` 遇到 experiment 时转入 `createExperiments.prepare`。宿主创建 `PROMA_HOME/software-experiments/<project>/<child>/work`，复制指定输入，保存问题、判定条件、父子归属及主工程源码指纹。

`buildSoftwareAgentTools` 识别实验子会话后返回专用工具。文件操作通过 `runWithProjectRootOverride` 指向实验目录，提供读取、写入、编辑、搜索和 web_fetch；实验 run_command 复用命令执行器，传入实验 root、独立 dataDir 与取消信号，保存真实输出和退出码。当前每条命令最多六十秒，目录隔离的能力边界是工程组织与工具约束，进程仍具有当前用户权限。

`record_experiment_result` 接收 method、finding、verdict 和 artifacts。supports/refutes 要求存在运行记录，保存时标记 interpretation=agent_claim。平台封存产物副本及 SHA-256，并返回 product_verified=false。继续编辑或运行会使当前结果指针失效，历史证据保留。

父会话通过 `read_experiment` 获取方法、运行记录、结论和封存代码，读取产物时再次校验哈希。主工程变化用 source_changed 标记，主负责人评估适用性后，通过正常文件工具集成并正式验证。结束时没有提交解释的实验会封存有界产物清单并标记 unverified。

这种机制允许围绕未知问题编写和执行新探针，平台组件只是可选资源。实验产物也可能只解决部分问题，实际功能边界由最终集成及验收结果确定。

实现见[实验工作区与工具](../../main/software/experiments.ts)、[委派入口契约](../../main/agent/delegation/delegation-tools.ts)、[实验工具接线](../../main/software/agent-tools.ts)。历史证据见[探索实验实施与真实复测](exploration-harness-20261105.md)。

**一　实验与其他子任务共用的委派底座**

正常制作入口先注册父循环上下文，包括模型查询接口、工具构造器、材料构造器、执行预算作用域，以及子会话事件回调。主 Agent 调用 `delegate_agent` 后，`startDelegation` 校验当前是否为父会话、并发是否已满、渠道覆盖是否被允许，再创建 `delegationId`、`childSessionId`、`AbortController` 和完成通知。

软件领域的 `prepareDelegation` 在启动前检查文件归属或准备独立工作区。通过后写入父子归属记录，发布委派开始事件，并启动子循环。调用方先拿到任务标识，后续通过委派等待、查询、停止和续接入口管理它。

`runChildLoop` 根据角色构造 system、task、materials 和 tools，再调用共用的 `runAgentLoop`，后者进入 Pi 运行时。首次普通委派用任务和角色材料建立子会话；`historyTurns` 只在相应续接路径传入。父子拥有各自会话记录，领域材料和受限实时事实可以由父级构造器提供。

结束时生成结构化交接和摘要，保留子循环结果，释放工作区权限并通知等待方。委派生命周期中的 `completed` 还需要结合 `loopStatus`、交接与实际验证结果判断任务完成程度。产品验收另有宿主凭据。

当前软件制作入口配置最大并发 2、普通子任务默认 24 轮、review 48 轮，并禁止委派时自行更换渠道或模型。子 Agent 的委派深度达到 1 后拒绝继续派生。参数描述的是当前配置，可以随工程演进调整。

实现入口见 [startDelegation 和 runChildLoop](../../main/agent/delegation/agent-collaboration.ts)、[父循环配置](../../main/desktop/lean-production.ts)、[工具装配](../../main/desktop/production-tool-assembly.ts)。

**二　Pi 和 Bloma 各自承担什么**

`runAgentLoop` 调用 `runPiSession`。Pi 提供模型与工具循环、会话持久化、重试和上下文压缩。Bloma 负责将自己的工具接入，并施加权限、预算、项目状态与交付约束。

会话文件路径由项目 ID、会话 ID、运行作用域和规范化工作目录共同计算，文件格式为 JSONL。恢复时检查会话归属及文件结构，同一路径已有运行实例时拒绝重复打开。尾部被中断的半行会保留原始副本后恢复，中间损坏会作为错误处理。

工具执行的副作用和模型会话写入可能发生在不同时间。进程中断后，`recoverInterruptedTools` 按工具调用 ID 和对应 assistant 记录查找宿主回执。有匹配回执就补回实际结果，缺失时将结果保留为未知并要求检查现场。这个机制降低重复执行文件写入等操作的风险。

实现入口见 [Pi 运行时](../../main/agent/loop/pi-runtime.ts)、[会话持久化与工具恢复](../../main/agent/loop/pi-session-store.ts)。Pi 属于采用的上游运行时，本月成果主要是集成及领域工程约束。

**三　补充能力　可选共享工程实现委派怎样限制写入**

`createSoftwareCollaborationPolicy` 保存当前任务的路径范围、只读标记和活跃状态。实现任务需声明 `writePaths`。路径经过绝对路径、越界路径、符号链接祖先解析及保留目录检查，Windows 下统一大小写后再检查目录和文件范围是否重叠。

工具执行前调用 `assertFileWrite`。子会话只能写自己的活跃授权范围；主会话写入活跃子任务拥有的范围也会被拒绝。新任务与活跃任务发生写入范围重叠时，派发失败。

普通共享工程子任务使用领域筛选后的文件工具，命令、调试和正式验证工具配置给 parent。`assertCommand` 检查活跃写入者，收齐写入后才允许主负责人运行。正式只读审阅还会冻结受管写入和命令。

这个边界由平台工具层执行。独立工程工作区和实验工作区有专门的准备逻辑与工具构造，能力需分别核对。共享工程委派无需为每个任务建立 Git 分支，具体分支、工作树隔离依对应运行模式。

实现入口见 [协作策略](../../main/software/collaboration-policy.ts)、[角色工具配置](../../main/software/agent-tools.ts)、[工程伙伴工作区](../../main/software/engineering-workspace.ts)。文件哈希写入保护属于另一层文件版本检查，可阻止基于旧读取内容继续写入。

**四　开发子任务与 C/V 审阅的调用关系**

实验及普通开发委派由制作 Agent 按需选择，默认正式实现由主负责人完成。`productionAgentTools` 对制作工具面移除直接安排正式审阅、应用测试修订等宿主职责，并从普通 `delegate_agent` 的角色枚举中去掉 review。宿主的收尾流程根据当前候选与证据安排 C/V，复用现有子会话运行时。

C 使用独立任务书、确认需求和候选资料，以及只读代码工具。V 获得经过归属校验的图片材料和观察事实。质量子会话使用专门的 system、材料和工具构造路径。当前 C/V 自动接线继承父级渠道，角色独立性主要由材料、会话和权限形成。

B 是可选的实现前 GUI 业务案例设计，存在单独配置和授权，当前入口要求其模型与主模型不同。它通过结构化模型调用设计案例，可能根据规模分批，与持续 Pi 子任务的运行形态有所区别。因此口述时称为独立设计角色即可。

风险选择读取已发布基线、质量记录和实际文件差异。没有完整基线、存在重要待核对问题或发生逻辑等变化时，采用完整审阅。纯样式缩减要求最多两份已有小 CSS 文件，且 AST 结构一致、仅允许的样式值改变。相同输入复用还需要目标、环境和有效证据一致。

实现入口见 [制作工具装配](../../main/desktop/production-tool-assembly.ts)、[质量审阅](../../main/software/quality-review.ts)、[协作选择](../../main/software/collaboration-selection.ts)、[独立案例设计](../../main/software/independent-design.ts)。

**五　候选身份和缺陷关闭怎样落实到数据**

质量身份的公共形状是 `source`、`target`、`environment`。各字段由源码与依赖、确认目标和运行环境等输入派生，规则版本另行参与审阅、绑定和检查。对外讲成“证据绑定具体候选及其验证条件”最准确。

工程外的 quality ledger 保存 reviews 和 findings。问题记录包含需求编号、预期来源、触发条件、证据、复现建议、候选身份，以及 checks。宿主生成问题 ID，模型提交的是疑点、争议或建议。静态误读和不适用问题可以通过有依据的独立审阅处理；需要动态验证的问题沿具体案例复验。

`settleObservedQuality` 接收正式验证结果，核对候选源码和当前规则，再寻找问题的具体案例绑定。实际失败形成对应记录，修复候选的同契约通过结合整体通过结果形成关闭依据。只有功能编号相同还不足以证明案例复现了那个问题。

原生 GUI 验证器在隔离数据和运行环境里启动应用。开启 restart 的套件依次执行 initial 和 reopened，重开阶段沿用该轮验收数据。宿主将实际 Node 测试事件与操作、断言记录解释为 passed、failed、unverified 和 not_run。

发布时，`sealSoftwareRelease` 校验候选与证据，`promoteSoftwareRelease` 更新活动版本。完成交付时，活动版本和项目完成字段在同一项目更新中提交。

快速项目在相关条件满足后进入 deliver；长期项目先 seal 候选并登记待确认里程碑，用户确认后才推进对应交付。需要干净环境而当前仅本机通过时，还有 trial/waiting_environment 分支。当前讲稿不把一份 verify_app PASS 直接称为已发布。

实现入口见 [质量数据结构](../../main/software/quality-ledger.ts)、[验证结算](../../main/software/quality-settlement.ts)、[原生 GUI 执行](../../main/software/native-gui-observer.ts)、[发布入口](../../main/software/release-store.ts)。

**六　测试修订怎样避免旧测试与新证据混用**

`proposeTestTransaction` 以登记的测试合同摘要为基线，将当前入口及可达支持文件封存为新版本，并记录修改前后摘要和确认预期。提案检查原案例集合。

`probeTestCorrection` 准备一次性候选，写入提案封存的精确字节，执行安全扫描和拟议测试，结束后再次检查源工程及候选字节。输出包括提案、候选、来源摘要和执行结果。独立评审同时看到历史基线和本提案的隔离执行，这两份材料各有明确用途。

独立裁定记录理由、预期来源与证据文件哈希。应用批准版本时再次校验实际文件，随后由正式验证入口重跑。批准修订仅授权对应测试修改，产品完成仍由后续验收判断。

最近的 `686c0af` 将安全扫描的文件、行号、类别和候选身份保留到评审输入。测试执行器记录当前案例最后一个受跟踪操作的名称、开始/完成/失败状态和时间，供进程超时后定位。它覆盖界面动作及部分 evaluate/wait 操作，业务对象状态还需实际断言或观察提供。

实现入口见 [测试修订](../../main/software/test-corrections.ts)、[隔离探针](../../main/software/test-correction-probe.ts)、[独立评审](../../main/software/test-correction-review.ts)、[执行器](../../main/templates/tools/browser-test-runner.mjs)、[报告投影](../../main/software/verification-report.ts)。

**七　持续工程伙伴和工具效率怎么解释**

伙伴沿独立工程工作区运行，通过公开行动及工具实际结果接收事实；运行中更新上下文，闲置且有新事实时续接原子会话。当前制作入口只有 `BLOMA_ENGINEERING_PARTNER === '1'` 时启用。制作收尾时暂停新增调查动作，待业务缺口返回制作后再依流程处理。该能力已实现并试验，作为可选配置，其真实收益需要按任务衡量。

另有由 `BLOMA_INTERACTION_EXPLORER === '1'` 启用的 UI 交互探索，用于从界面观察中查找问题。它与本文重点介绍的 experiment 技术探针、持续工程伙伴各有入口。讲稿的“能力探索”专指主负责人按关键未知委派的独立实验。

工具升级包括有界文件读取与分页、批量编辑、内容版本检查、进程输入和日志管理、TS/Python 语义查询，以及 DOM/UIA 观察。批量编辑报告每项应用结果和可能的部分成功，失败恢复需依这些事实处理。

TS/JS 查询基于 TypeScript language service。Python 基于 Jedi/parso，当前 capability 明确 diagnostics 为 syntax-only。两个后端都提供定义、引用等查询，诊断能力按各自实现说明。

固定工作流的受控对照使用真实 Pi 和工具执行、受控模型响应。ABBA 顺序为兼容、批量、批量、兼容。每轮文件调用 5→3、总调用 13→11、SDK 轮数 12→12。两个样本工具返回合计 615366→184296 B，下降约 70.05%；SDK messages 累计 2518630→1225244 B，下降约 51.35%。这里统计 messages 字节，供应商计费 token、缓存和费用需另测。耗时受冷启动影响，最后一份兼容样本还快于批量样本。

证据见[伙伴实施记录](engineering-monitor-20261108.md)、[工具对照索引](tooling-evidence-index-20261112.md)及[真实 Pi 工具工作流测试](../../tests/integration/pi-tooling-journey.test.ts)。

**八　会上引用数字时的核对表**

| 数字或结论 | 精确含义与来源 |
| --- | --- |
| 一个月 468 次提交 | 当前基线 HEAD 可达历史中，2026-10-14 至 2026-11-13 的提交数，包含文档和实验。适合背景统计。 |
| 六组 L2，每组一轮、14 场景 | 早期探索试验，业务全过 4/6，原生交付 5/6，两者同时满足 3/6。两个直接基线 14/14。详见[原报告](dispatch-experiment-report-20261017.md)。 |
| 多对象污染被独立案例发现 | 真实本地程序与受控 query 的回归，验证了案例及修复链路。详见[Q3 记录](quality-q3-implementation-20261030.md)。 |
| 视频能力探索 | 历史真实实验中，子 Agent 找到 imageio_ffmpeg 并生成拼接产物。16 次请求、21 次工具调用、14 条命令回执后达到该轮限制，未提交 record_experiment_result；停止后独立解码检查支持部分媒体结果。详见[探索复测记录](exploration-harness-20261105.md)。 |
| 工具字节量下降约 70% 和 51% | 两种调用形态的固定工作流合计，真实工具加受控响应，分别对应工具返回和 SDK messages。详见[工具索引](tooling-evidence-index-20261112.md)。 |
| 60 文件、605 项；Python 另组 17 项 | 指定历史代码 `90b636f` 的标准 check:offline 与另组 Python 验证。详见[工具交接](session-handoff-tooling-upgrade-20261111.md)。 |
| 工作台 17 项正式验收通过 | 修复后的本机候选，含外部工程介入。最新原始记录为仓库忽略目录中的 run-artifacts/workbench-third-acceptance-repair/formal-04.json。 |

工作台最新记录的 status、host_gui、speech、llm 和正常启动检查均通过。LLM 部分是回环协议检查，B 独立设计在该次记录中为 disabled。原生 GUI 检查包含重开。2026-11-13 本轮读取 projects.json，项目 9bbb0c6c-ca5a-4ccb-aa67-cd82090274d9 的 desktop_phase 为 desktop-implement，software_release_id 为空。汇报称修复后本机正式验收通过，交付收尾仍需完成。这是文稿核对时的状态快照。

**九　关键提交对应什么工程变化**

| 提交 | 变化 |
| --- | --- |
| d3a0d6d | 将生产 Agent 接入上游 Pi 会话 |
| df7fa0a | 软件优先流程与有界协作 |
| 0563497 | 独立代码审阅接入宿主问题验证 |
| c75738a | 视觉材料关联候选与宿主证据 |
| 69ff1ed | 独立案例依据与问题关闭 |
| 48f72c5 | 基于已验证基线和当前风险选择协作 |
| 43105ab、db22d82 | 独立实验委派与真实预览观察，保留未完成实验产物 |
| 40e9674 | 收敛交付资格、问题证据和发布更新 |
| 5b35ee5 | 持续工程监视伙伴 |
| e69bddc | 冻结完整测试修订候选以供审阅及精确应用 |
| acd15c7、add90a8 | 内容哈希保护的批量编辑、统一命令生命周期 |
| f91f8b5、686c0af | 区分历史基线与提案实测，保留探针失败及中断操作证据 |

本月主要是对既有委派能力的接入、强化和职责收敛。通用 Agent 委派与 Pi 运行时各有其已有基础。汇报中将候选绑定、角色权限、可复验问题关闭和可审查测试修订称为本项目工程特色；学术新颖性与真实质量增益仍需对应研究证据。

**十　终稿逐项核对表**

| 讲稿内容 | 当前实现依据 | 汇报口径 |
| --- | --- | --- |
| 需求与制作的关系 | lean-guide 的 begin 沿原 session_id 调用 enterDesktopLine；制作进入 runAgentLoop | 同一产品主会话，内部按阶段执行，模型路由可配置 |
| 默认实现负责人 | SOFTWARE_ENGINEERING_INSTRUCTIONS 明确默认一个负责人 | 主负责人直接实现，普通写代码委派属于按需能力 |
| 本月能力探索 | experiments 的独立目录、命令记录、产物封存与父级读取 | 关键未知驱动的实验、主负责人集成复验 |
| 模板和组件定位 | lean-production 明确组件为可选资源 | 查契约、调查、实验、集成，最终能力由实测确定 |
| 子会话约束 | registerParentLoopContext 的并发、渠道和深度检查 | 当前软件委派并发最多两个，深度一层，沿父级约束 |
| 审阅时机 | verify_app 的 beforeVerify、advanceCloseout、quality.completionAction | 覆盖审阅与候选 C/V 用途分开，宿主按条件安排 |
| 可选 B | prepareIndependentDesign 的 enabled、授权、GUI 和 distinct model 检查 | 实现前独立案例设计，按配置启用 |
| C/V 身份与材料 | quality-review、visual-review-material、quality-ledger | 角色材料和权限独立，C/V 当前沿父级渠道 |
| 测试修订 | proposeTestTransaction、probeTestCorrection、reviewPendingTestCorrections | 封存、隔离实测、独立裁定、精确应用、正式复验 |
| 产品缺陷关闭 | quality-settlement 及案例绑定检查 | 按具体问题与候选证据结算，失败原因保持可核查 |
| 持续工程伙伴 | BLOMA_ENGINEERING_PARTNER 显式开关 | 已实现并试验的可选能力 |
| 发布方式 | promoteSoftwareRelease、stageLongtermMilestone | 快速项目与长期项目分别说明 |
| 实验数字 | 各日期原报告与指定源码记录 | 历史调度、受控工具对照、本机产品验收各按原范围表述 |

文稿核对采用只读代码和已有证据，文稿提交包含两份组会文件。后续效果实验写为建议安排，最终验收数字对应已有报告及其版本。
