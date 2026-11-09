# Bloma 工程执行与验收职责收敛会话交接

日期：2026-11-09，Asia/Shanghai。下一会话目标是完成本文件的修复方案：统一运行时、测试修正事务、执行身份、证据读取与伙伴调度，再验证完整修复链路。**完整方案尚未实施；已有局部修复不等于方案完成。**

本文件是该任务唯一接手主入口。沿现有 `software-v1` 改造，复用制作者、完整 Pi 伙伴、独立审查、C/V、发布门禁、执行记录与费用账本。减少模型必须掌握的内部协议，不以增加提示词、工具数量或平行状态机替代职责收敛。

## 1 用户决定与授权边界

- 用户选择“校园社团协作桌面客户端＋本机服务端”，支持登录、管理员/成员角色、多人报名与同步；独立总预算30元，DeepSeek Flash、max思考，覆盖制作、伙伴及C/V。用户已亲自看到并认可草图。
- 由 Codex 亲自作为普通用户确认和操作，不运行外部模拟用户模型，不向普通用户需求注入平台协议或测试锚点。
- 用户随后明确要求“先停吧，整理一下全部的失败点”，继而要求探查全部根因、核实本地Electron、提出完整修复方案。最新指令是“准备会话交接完成这次修复方案”。
- 下一会话以完成工程修复为目标，先实施和验证离线部分。**付费试验保持暂停；交接不等于撤销停止指令。只有用户明确恢复后才可继续付费，并须重新核对渠道、余额、费率、账本、epoch及完整输入预留。**
- 不加额、不转移额度、不清unknown、不重置累计请求、不改历史拒绝为成功。不直接代修生成产品或冻结预期来使该试验通过。
- 只在当前Codex仓库推进，不改Proma、旧副本、SYNC-MANIFEST.json或持久记忆。相关批次验证后提交，不push；无需另建聊天或工作树。
- 保留用户原有 `production-workflow-v2-20261020.md` 两行未提交修改；hash-object应为 `53c7abb3aef8497d8b0522b8aab806c82b2ec164`，不得纳入本批提交。

## 2 当前快照

| 项目 | 交接核对值 |
| --- | --- |
| 仓库与分支 | `C:/Users/17359/OneDrive/Desktop/guide-agent-platform-sprint0`，`sprint2` |
| 实现基线 | `043734fd3755b49b41876951ed53329932825547`；本文件随后另有文档提交，实际HEAD以git为准 |
| 试验根 | `C:/Users/17359/.bloma-validation/monitor-campus-client-20261108-30rmb` |
| 项目ID | `1cead372-7d50-4949-8d1b-50d3f3d0463d` |
| 制作会话 | `observation-eda19ff7-abf8-4cab-baaf-9e370844a124` |
| 伙伴委派 / 会话 | `773e9726-091a-4af4-a537-146b9697361b` / `e5ab4cc9-aaf7-410e-a97d-99efcf29338b` |
| 项目状态 | active / generating_mvp / desktop-implement；无software_release_id，未完成C/V、正式发布或完整独立验收 |
| 停止标记 | 试验根下 `pause-generation` 存在，明确记录用户停止指令；不得自动删除 |
| 最终结束报告 | `campus/user-run-d2e1c580-216e-4952-851f-d7a2b174089b.json`，incomplete，2026-11-08 23:51:35北京时间结束 |
| 修正提案 | 8 rejected、1 pending；待审 `fc314b54-fbba-40a5-84eb-3036fadb162b`，停止导致待审，不是已批准 |
| 费用记录 | 430 reported、1 unknown，停止时无reserved |

产品根为试验根下 `home/agent-workspaces/default-software-builder/generated-projects/<项目ID>`。它与平台仓库不同；临时候选不是活动发布。所有分支、状态、金额和进程都是快照，接手后重读权威文件。

原30元策略不变。停止时账本已报告计价 `11.567816` 元，未知责任预留 `5.242880` 元，责任上界 `16.810696` 元，剩余 `13.189304` 元。并非精确实付金额，部分后续条目仍按高峰费率保守计价。最后账户余额34.33元、相对开始下降9.82元，账户变化不能替代逐请求账单。

398条已回报请求曾按核对后的官方适用时段追加计价凭据：16.529858元校准为8.265020元。原策略与entries的JSON值未改，unknown保留。凭据为 `reported-pricing-proof.json`、`reported-pricing-result.json`、`ledger-before-pricing.json`、`pricing-weekend-reviewed.html`。旧时段价目证据不能直接作为新请求准入依据。

## 3 已完成的局部修复

| 提交 | 内容 | 验证边界 |
| --- | --- | --- |
| `5b35ee5` | 完整持续监视伙伴，公开观察、独立工作区与同会话恢复 | 上一批受控Pi/Node/工具回归，不是校园客户端交付证明 |
| `be8c35b` | 驾驶器增加直接操作者interact，一次正常回复，原项目与累计账本 | 43项定向回归和类型检查；无额外模拟用户模型 |
| `a9e52e6` | 试验日志逐字符串脱敏后序列化，损坏历史保留并标记缺口 | 10项回归及类型检查；不是全平台脱敏已统一 |
| `7096d48` | 在隔离候选装入准确提案文本，不要求工作区先恢复旧测试 | 48项回归；另有真实浏览器验证准确试跑、工作区冲突保留及批准后仍须正式复验 |
| `043734f` | 取消实际收尾后封存终态，识别历史取消后的AGENT_CANCELLED回执 | 23项回归；正常/取消恢复同一Pi，拒绝新任务/普通结果/未结束/跨归属；类型、主进程构建、文档通过 |

日志位于平台 `run-artifacts/`：`operator-trial-*20261108.log`、`trial-json-redaction-*20261108.log`、`correction-probe-*20261108.log`、`monitor-cancel-recovery-*20261108.log`。重叠批次不能相加。旧故障注入的5秒等待在修改前也失败，见 `monitor-cancel-fault-baseline-20261108.log`；最终改为有界等待实际收尾，失败断言未放宽。

以上尚未解决完整事务提交、Electron项目绑定、诊断耦合和伙伴重复调查。不要重做这些局部修复，也不要把它们宣称为整体方案完成。

## 4 根因及源码地图

| 根因 | 已核对事实 | 主要文件 |
| --- | --- | --- |
| 运行时发现与项目使用分裂 | 宿主Electron实际为39.8.10；产物又安装33.2.0。第6次请求已查环境，但只收到Node/npm/Python。裸electron命令有宿主回退，npx和GUI只认项目安装；托管类型没有electron | `main/software/environment-tool.ts`、`runtime-bindings.ts`、`runtime-manager.ts`、`command-runtime.ts`、`electron-entry.ts`、`release-store.ts` |
| 手工修正单位不足 | 单文件、唯一old_text/new_text、各最多16000字符；脚本约42000字符，修复分散。补丁作用于冻结原文，工作区修复不会自动进入 | `main/software/test-correction-tools.ts`、`test-corrections.ts` |
| 缺失输入无法随提案补齐 | 提案只复制before.files，并要求前后文件集合相同；9份提案均只有1文件，工作区增加README/LAUNCH/native-inputs没有进入候选 | `test-corrections.ts`、`native-test-inputs.ts`、`native-test-runtime.ts` |
| 执行适配与业务预期绑定过紧 | 语法检查未发现未定义context/expect/assert；共享辅助逻辑随契约冻结，普通执行修复变成复杂审批 | `native-gui-tests.ts`、`native-gui-registration.ts`、`main/templates/tools/browser-test-runner.mjs` |
| 实例身份靠脚本补齐 | 固定BASE=4318误取另一开发服务凭据；重开新进程没重取密码；Electron context.newPage不支持 | `main/templates/tools/browser-context.mjs`、`main/software/debug-sessions.ts`、`command-runtime.ts` |
| 读取诊断依赖执行资格 | read_quality_findings先调用deliveryQualityBlock/qualityIdentity，脏测试可使读取抛GUI_NATIVE_TEST_SOURCE_CHANGED；截断摘要又被误当全部错误 | `quality-findings-tool.ts`、`verification-report.ts` |
| 裁定语义不清 | 代码无“全绿才批准”硬条件，实际裁定却常混合契约保持、操作可达、其他测试错误与产品失败；不能因此断言全部拒绝都错 | `test-correction-review.ts`、试验review文件 |
| 伙伴调度与版本分裂 | 普通工具开始/返回也唤醒；近期观察只有8条，长调查快照可能落后；伙伴大量命令读活跃产品绝对路径；双方及裁定共用串行模型队列 | `engineering-partner.ts`、`engineering-workspace.ts`、`main/agent/loop/query-queue.ts`、`main/desktop/lean-production.ts` |
| 活动不等于关闭阻塞 | 提案pending是登记成功，后续rejected未作为同一工具失败进入守卫；普通命令/修改仍算活动，跨续跑反复 | `main/agent/loop/work-progress.ts`、`main/software/quality-review.ts` |
| 基础层边界混用 | 正则脱敏处理编码后JSON；逻辑取消早于实际收尾；静态密码扫描命中示例/测试/清理脚本，随机化未同步重开与文档假设 | `verification-report.ts`、`process-manager.ts`、`main/agent/delegation/`、`main/verification/security-scan.ts` |
| 组合验证不足 | 小型修正夹具和单部件回归未覆盖多窗口、动态端口、随机凭据、重开、多处缺陷、新资源及分段修正的组合 | `tests/unit/software/test-corrections.test.ts`、`native-gui-tests.test.ts`、真实试验 |

Electron的旧设计有明确意图：[2026-10-28说明](harness-runtime-reliability-20261028.md)禁止GUI以宿主运行时冒充缺失的项目依赖。应提供可声明、可验证、可复用、可快照的项目绑定，不能仅加隐式宿主回退。当前项目33.2.0不得自动换成39.8.10。

主报告仍有 `JSON.parse(redactSoftwareOutput(JSON.stringify(...)))`，上轮仅修驾驶日志不能覆盖同类风险。工程目录隔离不是OS安全沙箱；不得宣称任意命令已被强制禁止写产品。

## 5 完整方案的实施要求

### A 运行时与执行上下文

扩展既有ManagedRuntime/catalog/binding支持Electron。环境检查区分宿主已有能力与项目绑定能力，返回版本、来源、完整性与适用范围。优先复用兼容的已验证完整目录或归档，进入不可变私有缓存再绑定项目；不能引用可变工作仓库node_modules，不能只哈希exe漏掉资源/DLL/locale，也不能用打包Bloma主程序充当通用Electron。

普通命令、npx别名、GUI、验收、快照和交付共用解析入口；不兼容明确拒绝或准备匹配版本。项目版本声明优先，不隐式升级。执行上下文统一提供实际窗口、origin、独立数据目录、重开身份和证据目录。HTTP不猜4318；多窗口观察等待真实用户动作创建的窗口，不由宿主伪造窗口或登录。重启关闭本次拥有实例，保留数据，再从正常入口启动。

产品README/LAUNCH/资源从当前候选读取，测试夹具从冻结测试快照读取，分别绑定版本。宿主不通过清会话、关遮罩或复用主页面帮助产品通过。

### B 完整测试修正事务

保留现有提案入口，正常Agent接口改为提交测试入口、当前工作版本及理由，由宿主从冻结基线和完整候选计算差异。手工old_text/new_text仅兼容旧记录，不保留双套新提交流程。原子快照相关测试、夹具和输入，支持多文件修复与必要资源补充；保留案例、业务输入、断言和重开要求，明确新增、删除及受影响案例。

审查看到、隔离试跑使用、批准最终绑定必须是同一候选。工作区后续变化不改变待审输入；应用拒绝覆盖冲突编辑。被测产品文档不能因错误相对路径被当成另一个测试目录里的文件。超出审查承载范围时明确停止准备或按固定版本读取必要内容，不能截断后宣称完整审查；至少覆盖本次约42000字符脚本、多处助手缺陷和新增资源组合。

### C 冻结与独立裁定

继续完整冻结原生测试，不增加业务DSL或双份断言配置。执行前检查测试语法、作用域、输入完整性、入口/运行时和已知适配能力；不能等测试跑绿才冻结。通用执行能力稳定在宿主上下文，减少每个项目临时自写连接、窗口、重开和路径胶水；业务账号获取仍走真实产品或明确测试业务，不由宿主伪造。

普通案例使用独立可识别数据，连续业务流程显式组织。记录失败后再清理，不在断言前无条件关遮罩；前置失败导致后续未执行须明确原因，不能制造整串产品失败结论。

裁定分别回答“原契约是否保持”与“执行实际结果是什么”。修正遗漏、预期削弱、产品真实失败、其他测试错误和基础设施不可执行分别呈现。合法修正暴露产品缺陷时可进入正式复验，产品继续失败且禁止发布；批准修正不签发产品PASS。删除案例、降低断言或绕过行为仍严格拒绝。

### D 可读诊断与结构化证据

工程损坏时仍可读取历史/当前阻塞，不要求先通过执行准入；标明版本、失效、差异与适用范围。摘要先给完整失败分布和不同原因，再展开堆栈，遗漏可追溯。明确动作计数是已完成还是已尝试，不能从0 completed推出没有尝试。

统一结构化脱敏与序列化，先处理字符串再编码，覆盖报告、工具输出和试验记录。静态规则区分真实运行凭据风险、合成测试数据与脚本内容；任何豁免有明确范围和反例，不能整体关闭安全检查。

### E 伙伴与进展治理

伙伴保持完整Pi、同一child_session_id、自主工具、笔记和局部探针。全量公开审计保留，向伙伴供给带版本事实增量；重复读取/结果合并，原阻塞不变且无新事实时等待。关键发现先简短交接并绑定依据，旧探针不提升为当前通过，普通读取不反复转交相同长报告。

共享唯一费用准入。只有能承担并发预留才并发，暂被占用时等待释放、不误报永久耗尽；不足以并发时优先制作和必要复验，伙伴合并等待。探针默认用准确版本副本和自有数据；强制只读若作承诺，须真实受限执行和越界写入反例验证，不具备能力的命令拒绝，不能用提示词冒充OS隔离。

把提案拒绝和后置检查结果接入已有无进展机制，登记成功/无关修改不算关闭阻塞；不同真实失败不误停，不另建计数账本。停止调度、取消在途工作、排空进程和封存终态沿同一invocation处理，旧收尾不覆盖新运行，普通日志末行不是生命周期权威。

## 6 实施顺序与验收退出条件

| 批次 | 完成条件 |
| --- | --- |
| 1 运行时和实例 | 无外网复用兼容Electron，真实启动/重开/快照；不兼容或被改动资源拒绝；不同端口/数据/凭据不串实例 |
| 2 修正事务 | 完整多处多文件修复准确入包，必要资源可纳入；候选身份固定，工作区冲突和冻结预期保护保留 |
| 3 验收与证据 | 工程损坏仍能读完整诊断；合法修正与产品失败分离；报告不破坏JSON、不泄露凭据、不产生假通过 |
| 4 伙伴与生命周期 | 同一伙伴正常/取消恢复，处理迟到回执和新旧invocation；无新事实不付费空转，新关键证据及时交付，重复阻塞能停止 |
| 5 组合验证 | 先在校园反例隔离副本免费复现并证明修复；用户明确恢复后再沿同项目完成正式验收、C/V、发布和独立实机操作 |

各批必要检查通过后独立提交，保留回滚点、失败产物和日志。记录结构变更采用旧记录只读兼容或显式迁移，不重写拒绝决定或失败。先对照本地成熟实现/原仓库相关模块，核对来源版本和适配差异，不整体移植或重建旧架构。

必须具备的反例：不兼容Electron不能静默替换；删除案例/降低断言/换入口遗弃旧案例/跳过登录/清遮罩掩盖错误不能获准；旧PASS、错误实例和失效候选不能发布；批准提案或局部探针成功不能代替正式复验；暂停/恢复不清unknown、不重置费用；强只读承诺必须真正拒绝越界写入。

组合验收必须覆盖：多窗口桌面、动态端口、随机凭据、刷新与退出、完整重开、多处辅助函数修复、新增封存资源、多段恢复。受控模型、真实浏览器/Electron、真实付费模型、用户手测和干净机安装分别报告，测试重叠不相加。

## 7 真实证据与独立手测边界

试验根下：

- `trace/timeline.md`、`trace/requests/`：逐请求及工具原始记录。`00152/00154/00156/00158.json`与对应-input文件为损坏原件，保留缺口。可解析物理发送research 218、orchestrator 198，不包含缺失记录及其他角色，不是成功率。
- `home/software-test-corrections/<项目ID>/state.json`及提案目录review文件：准确冻结前后文本、独立执行和裁定。前8次拒绝分别暴露漏调用点、遗漏其他作用域错误、可能掩盖行为、输入包不全、错实例凭据及补丁再次遗漏；不能把这些一概归为产品失败或裁判错误。
- `home/software-debug-data/<项目ID>/`：原生执行、计数、截图及隔离数据。“12个失败全是context”是错误概括，还包含登录等待、遮罩等；0个完成动作不证明未尝试。
- 最终结束报告见第2节；最终用户停止后的在途请求已收尾，未再续跑。
- `operator-client/launch.json`：独立候选 `88d6922451a16c4edff63b260a21312cdf7b16b759d51ed7c7facd44a06a76e6`，源摘要 `e4ab70ece8611c7b2b8b3d4082a1223941c76b8fbbb37da1c22327c1aed6436c`，不是活动发布，也不是停止时最新工作区。
- `operator-client/member-before-registration.png`、`admin-after-registration.png`、`cancelled-history.png`、`admin-checkin.png`：Codex亲手确认登录、建活动、Ctrl+N普通开窗后成员登录、角色隔离、报名同步、取消恢复、取消历史、重新报名及签到。并发、导入、完整关停重开及最终版本复验未完成；导出只到保存对话框，不宣称文件保存通过。

电脑操作使用computer-use技能的node_repl与 `@oai/sky`，不得拼临时Windows UIAutomation或自建协议。原生保存对话框的缓存/焦点曾异常；有用户输入时重观察，不能复用旧窗口/PID/端口。临时观察器在试验根和平台 `run-artifacts/campus-*`，不是生产入口，不可不核对就重跑。

旧游戏已由用户确认基本可玩并交付；校园失败不能改写其结论。不要重开旧涂鸦/静音、FX或UI重设计任务来替代当前目标。

## 8 下一会话开始步骤

1. 读本文件、[软件工程基线](../03_ARCHITECTURE/software-engineering-baseline.md)、[观察方法](observation-only-testing-20261105.md)，核对Git、保护文档、暂停标记、项目和账本，不发模型请求。
2. 按第6节分批实施离线工程，明确删除/合并哪些重复职责，避免保留矛盾路径。先以隔离fixture及当前失败材料证明运行时、完整修正事务和证据归属可用。
3. 在本文件维护批次状态与验证结果，不另造重复主方案。相关批次验证后提交，不push，不触碰用户保护文件。
4. 付费部分仍停；用户明确恢复后，先核对未决提案、项目和当前候选、实时余额/费率/原累计账本与guard，再冻结新运行包沿原项目接续。不能把pending/rejected手改成approved。

接手只读命令：

```powershell
git status --short
git log -6 --oneline
git hash-object docs/05_PROJECT_PLAN/production-workflow-v2-20261020.md
$repairTrialRoot = 'C:\Users\17359\.bloma-validation\monitor-campus-client-20261108-30rmb'
Get-Content "$repairTrialRoot\pause-generation"
Get-Content "$repairTrialRoot\campus\project.json"
Get-Content "$repairTrialRoot\monetary-policy.json.state.json" -Raw | ConvertFrom-Json |
  Select-Object -ExpandProperty entries | Group-Object status | Select-Object Name,Count
```

不要从旧env.ps1或历史prepare-user/interact命令直接启动试验。用户停止指令、原费用上限和完整输入预留优先于历史脚本。

本次交接仅修改主交接文档及仓库/计划/架构入口；未改运行代码、生成产品、试验账本或持久记忆，未发送付费请求。交接校验为 `npm run docs:check` 和 `git diff --check`；此前工程测试结果仅按第3节的原批次范围引用。

## 9 本轮离线实施进度（2026-11-09）

完整方案仍未完成；付费试验继续暂停。以下是可独立回滚的子批次，不能作为第6节全部退出条件已满足的证明。

### 1a 显式 Electron 绑定与完整目录校验

- 沿既有 ManagedRuntime/catalog/binding 增加 Electron；显式准备优先复用兼容项目目录或通用宿主 Electron 发行目录，复制到私有独立目录后实际探测版本。项目声明优先，不使用打包 Bloma 主程序，不连接网络下载，也不自动把33.2.0改成39.8.10。
- 裸 electron 和 npx electron 共用 electronEntry，调试、GUI与点选入口也使用同一项目绑定。删除裸命令的隐式宿主回退。环境检查分别显示项目绑定与宿主可供准备的发行目录，宿主发现本身不声称已验证。
- 全目录摘要覆盖资源、DLL、locale及物理asar，拒绝符号链接；执行与发布验证资源完整性。发布记录保存实际使用的绑定，不把当前可变绑定作为旧候选身份。
- 定向回归：原运行时/执行/依赖/发布22项通过，新真实Electron用例1项通过（启动、同数据重开、快照、不兼容版本和非exe资源篡改反例）；现有真实GUI调试与点选8项通过。类型检查和主进程构建通过。
- 初次新用例没有声明独立profile，Electron GUI进程启动失败；日志保留。按生产GUI路径增加独立profile后通过，未放宽业务断言。此观察不能单独确定Chromium退出的底层根因。
- 证据：run-artifacts/engineering-repair-runtime-20261109.log（含原失败）、engineering-repair-electron-profile-20261109.log、engineering-repair-runtime-gui-20261109.log、engineering-repair-runtime-types-final-20261109.log、engineering-repair-runtime-build-20261109.log。
- 未完成：运行上下文的动态端口/随机凭据/多窗口组合验证，校园反例隔离副本复现，完整修正事务、裁定与伙伴调度等后续批次。现有组件测试不能代替这些条件，也不是校园产品验收。

### 3a 准入失败时的只读诊断与结构化脱敏

- 复用现有quality ledger；执行身份/交付准入建立失败时，read_quality_findings仍返回带原身份的finding/review、历史验证摘要、提案状态和准入错误，明确current_identity_unavailable及usable_for_delivery=false。不修改原失败、拒绝或费用记录；中止信号仍传播。
- 报告预览、原始分页及verify_app正常输出采用逐字符串脱敏后JSON编码；试验记录复用同一serializeRedactedJson，不再维护独立序列化实现。凭据字段的字符串值也明确脱敏，保留原对象与数字/布尔/null类型。
- 定向12项回归通过（4文件）：诊断准入失败、嵌套JSON/转义/凭据、试验旧损坏记录保留，以及真实CLI验证、旧PASS失效、受控Agent修复交付。focused复验5项与此重叠，不相加。类型检查通过。
- 证据：run-artifacts/engineering-repair-diagnostics-20261109.log、engineering-repair-diagnostics-focused-20261109.log、engineering-repair-diagnostics-typecheck-20261109.log。
- 边界：这是第3批的诊断子项；修正裁定分离、完整失败原因分布、尝试/完成计数、安全扫描精确例外尚未完成。不能称为全平台脱敏已统一。

### 1a 补充：npm锁定版本与校园原运行时复用

- package-lock.json的Electron精确版本优先于package.json兼容范围；锁文件与声明不一致时明确拒绝。新增反例证明^33.2.0且锁定33.2.0时不能选择33.3.0。当前实现覆盖npm锁文件，未增加其它包管理器锁文件解析。
- Electron运行时用例2项通过，包含真实启动/重开/快照/篡改拒绝；另以SOFTWARE_RUNTIME_SOURCE_TEST只读指定校园项目原目录，在隔离PROMA_HOME导入其33.2.0发行目录并实际探测，源目录前后完整摘要一致，无fetch调用。未运行校园产品代码或更改原项目绑定。
- 证据：run-artifacts/engineering-repair-electron-lock-20261109.log、engineering-repair-campus-runtime-import-20261109.log、engineering-repair-lock-types-20261109.log。第一次外部源验证使用BLOMA前缀，被测试全局环境守卫清除而跳过；原日志engineering-repair-campus-runtime-20261109.log保留，不计作校园源验证通过。
