# Bloma 基础工具与工程能力升级实施计划

日期：2026-11-11（Asia/Shanghai）。核查基线：`sprint2 / 599ef1c74660e9960ee7c3a6970e3b0c81ce9ed9`。

状态：**2026-11-11 用户已授权按计划实施；批次进度与验证边界见第16节。** 原文档批次仅为调研授权，后续工程授权不包含付费实验、部署、push或恢复暂停产品。本文承接现役 software-v1，不替代当前交付契约与已有缺陷记录。

配套阅读：[Vide 源码借鉴与适配设计](vide-adoption-design-20261111.md)。最近已实现能力以 [质量收尾](session-handoff-quality-closeout-20261110.md)、[行动优先界面](session-handoff-ux-action-first-20261110.md)、[启动新鲜度](session-handoff-startup-freshness-20261110.md) 和当前源码为准；旧目录索引的“待实施”不覆盖这些结果。

## 1 目标与排序修正

目标是使负责人用更少往返获得准确事实，更可靠地编辑和执行，并将真实缺陷收敛到交付。基础工具调用应作为首批工程：已有工具不等于接口高效，也不等于当前执行路径实际利用了并发、增量和结构化信息。

原调研将基础命令与编辑放在较后，本次根据源码修正：**先改善搜索/读取/结果体积和安全调用调度，再扩展 GUI 与独立探索；语义代码服务、原生桌面和独立运行环境按任务需求推进。** 不预先承诺百分比收益。

- 补全：现有职责已经存在，但工具信息不足、重复、可恢复性或覆盖不完整。
- 拓展：引入新的运行目标或判断能力，例如完整 Windows UIA、LSP、独立交互探索和干净 Windows 执行器。
- 两类工作复用原负责人、Pi 会话、quality ledger、verification、release 和费用账本；不新增统一管理 Agent、第二套 PASS 或平行交付状态机。
- 不修改 Proma、旧源码副本、持久记忆和 SYNC-MANIFEST；不动用户未提交的 `production-workflow-v2-20261020.md`。
- 当前付费暂停及 unknown 责任保留。真实模型实验需新的明确总额授权，并核查 live selector、费率、账本和完整输入预留；本计划不是预算授权。

## 2 已核查事实及限制

| 编号 | 当前源码事实 | 影响与不能推断的结论 |
| --- | --- | --- |
| F01 | `main/agent/loop/pi-runtime.ts` 将 `activeSession.agent.toolExecution` 明确设为 `sequential`；自定义工具映射未传递 `parallelSafe` | 现役 Pi 工具串行。旧接口注释的并行上限不能作为现版本实际行为证明；尚未测出耗时占比 |
| F02 | `main/agent/tools/agent-tools.ts` 的 grep 最多50条文件/行号，不含行文；glob 是简化后缀筛选 | 搜索后常需另读文件；它不是完整 ripgrep glob 语义 |
| F03 | read_file 默认100行、最多500行；list_files 有深度/条数上限；读取全文再取行窗口 | 已有有界返回，但长行、分页与多文件调查仍需优化；文件总量与返回量不是同一限制 |
| F04 | edit_file 支持唯一片段替换、CRLF/LF匹配、校验及写租约；`write-lease.ts` 使用 mtime/size revision 和进程内租约 | 不缺精确编辑；批量修改、内容版本和多文件失败语义仍可增强。不能声称现有租约覆盖跨进程 |
| F05 | `execution-tools.ts` 同步命令尾部截断 stdout/stderr；异步 commandView 返回 output，退出后还返回 stdout/stderr | 存在重复返回及诊断截断机会；需实测哪些内容重复，不把所有返回都当重复 |
| F06 | `process-output.ts` 保留最多256条/约32768字符，单条最多16000字符 | 环形缓存不能提供被淘汰日志的完整追溯；新设计需明确保留期和磁盘上限 |
| F07 | `pi-runtime.ts` 包装使用共享 ctx、budgetUsed、feedback、receipt；当前 ctx.toolCallId 会在执行前赋值 | 并发不能只改一个开关，要先隔离调用身份、准入及收尾次序 |
| F08 | `ui-observation.ts` 默认40控件、1600字符正文、8000字符整体预算；完整 Playwright 脚本仍可深查 | 默认观察可能丢掉结构；不是断言所有复杂界面都无法操作 |
| F09 | `quality-review.ts` 中 C 为只读源码/审阅工具，V使用授权图片和事实；外部模拟用户链另在 scripts | C/V 不等于可自主驾驶的探索验收；已有模拟用户能力应先复用 |
| F10 | `repository-context.ts` 正则抽取候选；`change-impact.ts` 已用 TypeScript AST 解析静态相对导入 | 不重建已有 AST；进一步补符号语义、别名、类型诊断和跨语言 |
| F11 | `debug-sessions.ts` 已采集 console/pageerror/network，并关联动作/版本 | 继续补 IPC/存储/后端证据，不从零建日志系统 |
| F12 | 调试启动支持 browser/electron/webview；已有自有文件对话框 UIA 脚本、数据隔离与快照 | 并非通用 Windows UIA，也不是 OS 沙箱或干净机交付证明 |

本次属于静态源码调查与官方参考项目阅读；未运行新性能测试、未审计所有跨进程排列，也未复测历史产品。历史受控 Pi/GUI 结果可指导反例，不作为真实供应商效率数据。

## 3 架构落点

保留现有四层责任：

1. 负责人连续实现、运行与修复；独立判断只在有价值的边界开展。
2. 工具负责读取/编辑/执行/观察，返回事实及可追溯定位；不自行判定业务完成。
3. 宿主负责权限、预算、会话/进程身份、冻结合同、真实执行、独立审阅安排及结算。
4. 发布继续经过原唯一出口；新日志、索引和观察快照均不是通过账本。

工具升级优先扩展已有入口；参数含义保持明确。单文件与批量编辑共享同一写入原语，所有搜索共用路径边界，GUI适配共用同一 debug session 生命周期。是否新增工具名由独立操作语义决定，不以工具数量作为简化指标。

## 4 T0：基线计量与真实调用审计（补全，所有批次共同前置）

落点：`pi-runtime.ts`、现有工具观察事件、`harness-evaluation.ts`、trial request recorder；优先离线消费已有事件，不增模型调用。

- 测量工具起止、排队/执行时长、请求/返回字节、模型实际usage、每轮工具数、重复读取、重复启动、截断及错误恢复。工具字符串估算与供应商计费 tokens 分列。
- 关联原 operation/session/tool-call/source，不新建业务状态；分析报告存外部实验目录。诊断中敏感内容沿用脱敏，不能为计量扩大采集范围。
- 样本固定：多文件定位、跨文件修改、长构建、长日志排障、重复按钮/长表格、持久化/重开、Windows对话框、宿主中断恢复。补全样本与未参与调试的保留任务分开。
- 工具级受控实测与真实模型实验分别报告。现有账目不清零，旧失败不覆盖。

完成标准：每个待优化点都有可复现基线；能说明瓶颈是模型往返、工具耗时、输出膨胀还是错误重试。先记录绝对值，再选择收益目标，禁止拿测试条数替代提效。

## 5 T1：搜索、读取与工具结果（补全，首批优先）

落点：`agent-tools.ts`、`repository-context.ts`、`execution-tools.ts`、`process-output.ts`、`diagnostic-context.ts`、Pi结果包装。

### 5.1 搜索与读取

- grep 支持字面/正则、大小写、明确的路径/glob、上下文行、仅文件模式、结果游标和截断说明；一次搜索足够回答简单定位，不强制二次读取。
- 可优先复用 rg；若本机没有可受控的 rg，使用具备明确支持范围的回退实现，不静默改变glob含义。忽略目录、二进制、大文件和符号链接策略一致。
- read_file 增加字符/字节上限、超长行处理与续读定位；保留行号/内容版本。可在同一只读请求中读取有限个文件窗口，每项独立成功/失败，总输出有界。
- 列表/检索显式返回是否完整和续查入口，避免“前200个文件”被误当整个目录。
- 缓存以真实字节/查询身份校验，仅复用确定相同内容；不能把已读别名去重扩展成隐藏变更。

### 5.2 结果投影与日志

- 命令默认返回一次当前增量、状态、退出码、游标和诊断入口；退出时不重复附上已提供的全文，兼容旧调用时保留显式读取方式。
- 完整脱敏日志按原process身份保存在工程外，支持范围/搜索读取、保留期及大小上限。无法完整保留时明确缺口，不伪称“全文可取”。
- 模型侧返回简洁事实；人类详情和审计仍可追溯。不增加摘要模型；不删除原始执行证据以减少tokens。
- 稳定错误码对应有限的恢复动作；先归一同一命令的同步/异步结果语义，不强制把所有业务工具套入庞大通用协议。

反例：超长单行、重复同名文件、unicode/CRLF、分页期间文件变化、日志跨chunk密钥、首部错误被尾部淹没、退出重复读取、失效游标、文件越界。验收同时检查结果正确性及查明原因所需往返/字节。

## 6 T2：调用调度和命令生命周期（补全，首批后半）

### 6.1 安全只读并发

- 先按真实副作用重新审计 parallelSafe；read_file 会登记revision，并非绝对无状态。每次调用使用不可混淆的局部 toolCallId/context，事实按调用编号落盘。
- 使用当前 Pi 已有调度能力或薄适配；不得建立第二个 Agent loop。先核实安装的1.4.0接口及 sequential 工具标记，锁版本验证。
- 初期仅同轮、彼此独立、白名单只读调用并发，上限建议4但由基线决定；含写入、启动、停止、GUI动作、验证、委派、预算敏感操作的轮次保守串行。
- 预算在任务派发前统一预留/准入，取消阻止未开始项，已开始项按实际结果结算。保留每项失败，批次不能用最后一项成功覆盖前项错误。
- 工具结果顺序与原调用配对稳定；公共消息、伙伴观察、收尾判定在全部在途结算后执行。先测同轮并发，再考虑独立命令并行。
- 若 Pi 支持限制无法满足以上契约，先只提供有界只读批量接口，不直接全量开启parallel。

### 6.2 命令执行

- 同步和异步共用一条进程生命周期，调用等待时长与命令总时限分离；保持 argv 语义和现有超时保护。
- 默认短等待后交回同一process身份的方案先实测，避免强制每条短命令都多一次轮询。
- 进度等待采用有界事件等待；日志游标、EOF、取消和进程树清理复用已有实现。
- PTY仅在确有交互工具失败证据时扩展，普通构建不默认PTY。Windows编码、stdin/EOF、引号、子进程和取消要单独验证。
- 不自动重放未知副作用，不凭PID接管重启前进程，不把长任务完成回调变成新增模型轮询。

反例：四个读取的完成乱序、共享revision变化、取消时两个仍在途、准入余量只够一项、工具失败后后续写入、host重启、同编号重放、输出结束早于退出、正在构建时verify。检查真实Pi路径，不只调用工具函数。

## 7 T3：批量精确编辑与版本保护（补全）

落点：`agent-tools.ts`、`text-edit.ts`、`write-lease.ts`，复用原权限/冻结测试保护/写入校验。

- 首期同文件多片段：基于同一内容版本计算最终文本，验证一次、写入一次；重叠或歧义拒绝，不让模型多轮制造临时坏文件。
- 内容hash作为新接口的版本依据，兼容旧revision但不将mtime/size宣称为内容身份；异步校验后提交前重新核对。
- 可比较结构化 edits 与统一patch两种候选接口；以当前模型准确率和输入字节决定默认，不能仅因工具名叫apply_patch就认定更好。
- 多文件操作分后续：先全部路径/版本/修改预检；失败范围明确。没有崩溃恢复机制前不得承诺跨文件原子事务。优先有序应用并返回逐文件事实，不自动回滚他人改动。
- 不允许新批量工具绕过被冻结的原业务输入/断言、读写角色、授权范围或产品文件隔离。

验收：CRLF/混合换行、相邻片段、同名多命中、片段重叠、修改后同长度/时间戳变化、部分文件拒绝、提交前外部改写、取消/中断、父子会话冲突。比较一次真实跨文件改动的轮数、输入量、误改和修复成本。

## 8 T4：工具发现和上下文效率（补全，T1/T2之后）

当前 Pi 使用明确allowlist，排除了通用 `mcp__*`、codemode、tool_search；不直接移除这些限制。

- 核查每次实际发送的schema/系统提示大小；稳定工具定义保持顺序，避免无收益变动破坏缓存。
- 常用读写/执行/观察入口保持稳定；领域能力继续沿 read_production_context 按需读取。低频扩展若需动态激活，宿主在原allowlist内确定，按角色/会话/恢复版本核对。
- 先做只读批量和现有脚本接口；通用code-mode/REPL须有独立实验，不能绕过每项权限、预算、取消、路径和审计。任意JS执行不是免费替代方案。
- 压缩后恢复保留当前目标、候选、未决进程、有效决定与证据位置；不把缓存或记忆摘要签成当前事实。

完成标准：实际请求输入降低，能力未丢失；老会话/压缩/恢复后的工具可用性、撤销与角色隔离通过反例。动态schema若导致选择错误增加，应回退稳定集合。

## 9 G1/G2：界面语义与原生适配（补全+拓展）

G1落点：`ui-observation.ts`、`inspect-tool.ts`、`debug-sessions.ts`，复用原Playwright。

- 增加有界角色/名称/状态/层级快照、局部区域查询、搜索和续读；目标引用绑定当前观察，失效重新查找，歧义不点击第一个。
- DOM、截图和输入仍分清证据类型；覆盖iframe、可访问shadow DOM、虚拟列表、弹窗、重复行、Canvas视觉回退。未支持项明确返回能力缺口。
- 页面改变后动作先核对归属与定位；不要为便于工具操作要求生成产品添加特定业务控件。

G2落点：原native-window-isolation、native-file-dialog与debug session，新增Windows适配器，不另建生命周期。

- 参考winapp CLI的UIA树、AutomationId/控件类型、窗口HWND范围、歧义错误、等待和截图；先证明普通用户态选定应用，再扩大框架覆盖。
- 锁定本项目实际实例及进程树；UIA语义调用与真实输入分别记录。全局鼠标/键盘有独占租约，不能多人抢焦点。
- DPI、多窗口、模态框、最小化、UIA缺失、窗口销毁/句柄复用为验收反例。失败不得操作相邻用户窗口。
- 原生适配器缺失不伪造通过；保持原browser/electron可用。工具安装/打包/兼容性需有版本锁与回退。

## 10 Q1：独立交互探索与缺陷闭合（拓展）

复用 `scripts/software-observation-trial.ts`、simulated-user surface、隔离候选/测试数据和现有quality ledger；提取最小运行能力到主流程，避免生产依赖整个试验脚本。

- 输入为确认需求、候选版本、运行方式和已授权边界；主要从行为取证，不依赖制作方自评。
- 按风险开展短程探索：跨账号、取消再尝试、持久化重开、多窗口、错误恢复和边界输入；不要每次走全套新角色流水线。
- 探索者只操作自己的隔离实例，可提交复现步骤/预期/实际/证据；不能改产品、冻结预期、批准纠正或直接发布。
- 新问题接入原finding；可复现问题按现有独立绑定和真实复验结算。环境故障、产品缺陷、审美意见分列。未复现不得自动变成已关闭。
- 保留C/V职责；不因新增探索悄悄跳过当前必须的C/V。若后续需要调整风险选择，单独验证政策变化。
- 有界预算、终止与证据保留沿原operation；可选探索不能耗尽必要收尾资源。

验收：已知错误实现/修复实现成对样本、未知新反例、同版本重放、产品变化后旧证据失效、重复报告归并但不吞不同触发、探索中断、资金不足、修复后重开验证。必须跑通“发现→修复→独立复验→原发布出口”，不能只证明多报出几条意见。

## 11 C1：语义代码服务（拓展）

在 `inspect_repository` 下按需提供definition/references/diagnostics/symbol查询；先TypeScript/JavaScript与Python，再看真实任务扩大。复用现有AST影响候选，保留rg作为普通定位路径。

- 参考Serena的符号级接口；LSP后端按项目runtime和配置启动，索引内容版本明确，外部依赖/别名解析不足显式标记。
- 首期只读；重命名/符号编辑后续仍通过T3的路径、版本和权限约束。语言服务器本身不授予宿主额外写权限。
- 记录冷启动/增量索引成本；小工程不强制启用。引用查询不能替代完整正式验收。
- 验收含重导出、同名局部符号、路径别名、项目配置改变、缺依赖、服务器崩溃、语言混合。语义结果失效时不能继续当准确事实使用。

## 12 O1/E1：故障证据与可复现交付（补全+拓展）

O1：复用debug observation和diagnostics，按动作/时间/进程/候选查询console、network、backend stderr、IPC和存储事件。只在必要组件增加诊断埋点；先打通一个保存失败的完整证据链，再评估OpenTelemetry桥接。开发埋点及合成入口不能替代正常产品入口验收。

E1：复用runtime-manager、release-store、isolated-launch。定义固定候选包、依赖/运行时清单、测试数据、独立启动与证据回传；在干净Windows环境检查安装/启动/保存/重开/升级旧数据。参考WindowsAgentArena的环境重置/任务执行/结果检查分离，按本机能力选择VM或Windows Sandbox，不能把worktree或目录隔离称为OS沙箱。

故障矩阵：缺运行时、网络离线、中文空格路径、权限受限、原机器缓存消失、迁移失败、宿主关闭/重开、后台服务退出、输出证据丢失。旧数据保护及回滚必须实测。镜像、虚拟化支持、许可证和磁盘资源在实施前核实，不默认占用用户环境。

## 13 V系列：Vide借鉴范围

详见配套设计。纳入计划的范围：

- V1 框架运行时适配：启动/更新/元素/截图/错误/停止，共用现有debug会话，先增强Electron/Web，再按明确需求增加Flutter/TUI。
- V2 操作与工具结果展示：差异、长输出、进程状态、错误详情，沿现有public_message_id和行动优先界面扩展。
- V3 异步协作：定向问题、事实消息、会话续接，复用工程伙伴/Task/Assignment；用有效贡献和收尾成本评估。
- V4 会话连接与执行分离：先本机断连/重连和事件去重，远端daemon作为后续独立扩展。
- V5 worktree任务完整隔离：代码、数据、端口、浏览器profile、日志、测试资源一起绑定；合并后重新验收。
- V6 验证方法：复现优先和短交接通过现有事实入口表达，不移植整套强制角色/长Markdown协议。

## 14 批次依赖、完成标准与回退

| 批次 | 范围 | 依赖 | 交付物 / 退出条件 |
| --- | --- | --- | --- |
| B0 | T0 基线 | 无 | 受控任务/原trace分析、瓶颈排序、可重复测量 |
| B1 | T1 搜索/读取/结果 | B0 | 接口兼容、反例通过、有效调查的往返/输出对照 |
| B2 | T2 调度/进程 | B1 | 真实Pi混合工具、取消/预算/身份/恢复验证 |
| B3 | T3 编辑 | B1 | 同文件多修改及版本保护；多文件按明确语义单独放行 |
| B4 | G1 + V1/V2首期 | B1 | 复杂GUI可观察性、原入口真实运行和展示回归 |
| B5 | Q1 + V3 | B2/B4 | 同候选独立探索到原缺陷关闭/发布链 |
| B6 | C1 + T4 | B1/B2 | 语义查询和上下文成本实验，明确是否值得默认启用 |
| B7 | G2 + O1 | B2/B4 | 选定Windows框架、故障查询完整取证 |
| B8 | E1 + V4/V5后期 | B2/B7 | 干净Windows/重连/隔离集成；远端另定范围 |

“全部整理”不表示所有扩展同时开工。B0后可以据证据调整顺序，但不能跳过权限/预算/独立证据前置。各批按原配置框架做可关闭的策略或适配器；回退不删除日志、unknown、失败、finding或历史合同，不迁移旧记录为PASS。

实施每批必须：核实实时HEAD和未提交改动→最小实现→针对性反例/实际路径→适用的类型、文档及标准离线检查→核对保护文件→提交相关改动，不push。仅文档批次不运行整套GUI/付费测试。独立审查如需新增Agent须有当时明确授权，本文不是本会话自动派遣指令。

## 15 效果验证协议

工具优化先测确定性正确性和延迟；真实模型对照需单独授权，固定模型/思考档/总预算/任务/输入环境。对照顺序交错，冷/热缓存分别记录，避免把模型/供应商变更归因于工具。

主指标：完整任务自主交付、漏掉的真实缺陷、人工接管、修复到交付调用数、模型实际费用、总耗时。辅指标：工具往返、结果字节、重复读取/启动、定位失败、错误恢复轮数、审阅发现被采纳并关闭的比例。

环境故障、测试器故障、产品失败、预算不足分列；小样本报告原始结果，不宣布普遍成功率。只有工具微基准改善但端到端没有收益时，保留结论并重新排序，不继续叠加角色。

## 16 参考与实施记录

- 用户提供的[分享对话](https://chatgpt.com/share/6af3453f-a1bc-83ee-9905-31fbf407d718)：调研问题来源，不是当前实现证据。
- [Playwright CLI](https://github.com/microsoft/playwright-cli) / [Playwright MCP](https://github.com/microsoft/playwright-mcp)：局部快照、会话、语义观察及不同接口的上下文取舍。
- [winapp CLI](https://github.com/microsoft/winappCli) / [UIA文档](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/ui-automation)：Windows原生观察与输入参考。
- [Serena](https://github.com/oraios/serena)：符号检索与语言服务；2026-11-11读取README标识GPL-3.0-or-later，后端能力不同。实际分发/集成前核实锁定版本许可，不从参考学习推定可直接复制。
- [WindowsAgentArena](https://github.com/microsoft/WindowsAgentArena)：可复现Windows评测设施，不是Bloma现成验收器。
- Vide锁定源码、采用/改写/暂缓细项及风险见配套文档。

**首批历史见[工具升级首批交接](session-handoff-tooling-upgrade-20261111.md)；本次续接至6696d39的标准check:offline（19文件206项+11文件137项）已真实整体通过，旧超时/音频问题已取证处理，未合入原sprint2。新G1批次专项通过，最终集成后仍须再做整套；整份B0–B8尚未全部完成。** 各段历史验证只绑定相应批次；不能将早一版本19文件206项通过或后续单独复验拼成最终全通过。

| 批次 | 最新进度 |
| --- | --- |
| B0 | 文件/编辑基线已测，其它场景未齐 |
| B1 | 查询、读取、命令结果/日志首期已接线及专项验证；端到端收益未证 |
| B2 | 局部调用与数值观测、有界只读批处理已落地；同步/异步命令同一受管理生命周期及事件等待定向通过；仍不全量开parallel |
| B3 | 同文件多片段与hash保护完成；最多8文件全部预检后有序应用、逐项部分失败语义与真实Pi接线通过；不是跨文件原子事务 |
| B4 | G1/V1首期DOM语义、当前观察refs、能力发现、浏览器/Electron真实调试接线专项通过；V2实际提交差异/进程展示及Pi历史回放已接线，最终平台App展示回归待统一 |
| B5 | 首期可选交互探索接主收尾；真实隔离浏览器/受控Pi及原finding→独立绑定→失败/修复/复验/发布机制通过；真实模型收益未测，V3长程消息贡献仍待集成 |
| B6 | TS/JS worker之外补真实可选Jedi/Python固定stdio桥，真实Pi/版本/取消/坏后端等验证；T4已抓实际HTTP schema/context与恢复/撤销反例，不泛称总字节或费用下降 |
| B7/B8 | G2首期Windows UIA及O1保存失败证据链已接线并实测；窗口世代、重连/完整隔离/E1与最终环境验收仍在继续 |

后续在本节按实际证据更新，不能仅因合入代码标记真实模型提效完成。

### 2026-11-11 B2首期 调用身份与数值观测

Pi包装不再把每次toolCallId写进共享协调上下文；执行、feedback回执各自持有局部调用上下文，工具开始/结束通过原调用ID配对，不按同名末项猜归属。复用原onToolObservation补执行时长、入参UTF-8字节、输出文本UTF-8字节；这些不是供应商计费token，不包括图片payload，也没有新增采集sink或业务台账。

安装的Pi1.4.0确实提供parallel和executionMode=sequential混合批次退化路径，但没有在本批打开：当前白名单文件读取/遍历仍是Node同步IO，缺少并发收益证据；其它工具包含预算、进程、GUI和宿主收尾副作用。采用计划允许的有界只读批处理，不为标记parallelSafe而全局放开。原工具预算、权限、取消、恢复与收尾规则保持，未建第二个Agent loop。完整异步只读并发及命令生命周期统一仍待后续验证。

实际Pi2文件48项通过，包括同轮同名两调用的feedback上下文不串ID、数值字节、余量只够一项时另一项不执行，以及既有恢复/权限/永久预算/公开消息/取消用例；typecheck通过。证据b2-pi-tests.log、b2-typecheck.log。参考本地Proma上游bf3e98ca61dd8365eceaef876c0f7473700878a6的pi-agent-adapter.ts权限包装与sequential策略，以及实际安装SDK的agent-loop.js；仅适配宿主边界，不整体复制上游文件。

### 2026-11-11 B1b 命令增量投影和诊断归档

异步命令read_process默认只返回本次增量与退出事实，不再退出时重复附stdout/stderr；显式mode:tail保留兼容尾部。mode:log按原process/session归属查询工程外的脱敏归档，可按序号、字面关键词和长记录字符位置续读。同步run_command旧调用保持兼容，尚未统一两条命令生命周期，不将其记为B2完成。

归档先对完整逻辑行脱敏，再供模型尾部与磁盘保留；跨chunk UTF-8/密钥在同一逻辑行处理。超过65536字符仍未结束的行整条丢弃并明确标记缺口，不丢键名前缀后暴露敏感尾部。单进程8MiB、每home16个原子保留槽（归档内容总额≤128MiB）；保留直到手工清理，不自动删除旧证据或回收未知槽。容量、IO错误、长行缺口与旧进程无归档均不冒充全文可取；到达容量仍可用原环形尾部。归档是诊断证据，不是业务/费用/PASS台账。

本次真实命令、服务/取消、stdin/EOF、Pi异步单命令、归档与旧接口3文件21项通过；新增反例覆盖首部错误被1000行尾部淹没、分chunk密钥、长记录完整续读、128MiB保留槽/单文件上限、损坏记录、重启仅查历史不接管PID、错误所有者及退出后空增量。typecheck/main构建结果见b1b-typecheck.log/b1b-build.log；不增加真实供应商请求。未验证所有敏感文本格式，也不宣称OS沙箱。

### 2026-11-11 B3首期 同文件批量精确编辑

原edit_file增加1~32个edits，基于同一原文预检所有唯一片段及重叠，计算一次最终文本、语法校验一次、通过原权限/冻结保护与租约写入一次；相邻非重叠允许，不按前一项结果匹配后一项。CRLF/LF只在命中区域兼容，重复语义片段或重叠匹配拒绝。

新read_file/写后revision为原始字节SHA256；批量编辑必须有hash基准，提交点在异步校验后和原进程内租约内核对，删除也视为stale。旧会话单片段stat版本显式兼容，不宣称旧版本可防同mtime/size修改。新文件和已有文件均拒绝通过内部junction别名绕过原路径权限。仍不是跨进程互斥或跨文件原子事务；未自动回滚他人改动。

本批读写/查询/租约及受控测量7文件61项通过，包含真实Pi AgentSession走实际工具schema、部分读取失败、同原文多编辑及真实落盘的1条整链；模型响应受控，未调用付费供应商。typecheck与main/worker/preload/templates构建通过。最终补充内部junction新文件写入反例见b3-final-tests.log。两处修改含预读从3→2次；不据此认定总成本或总体质量改善。

证据：b3-tests.log、b3-typecheck.log、b3-build.log、tooling-after-edit.json。多文件编辑与真实模型接口准确率比较待后续单独验证。本批依赖B1的读接口，不要求B2开启并发，未增加新工具名或PASS账本。

### 2026-11-11 B1a 搜索和有界读取

已在原grep/read_file/list_files/find入口接线：搜索返回命中正文、字面/大小写/上下文/路径与明确glob子集；内容指纹绑定分页，集合或内容变化拒绝旧cursor。目录清单可续页，深度、基础设施排除和不可读范围明确报告。未依赖本机未受控的rg，不把JS正则/有限glob冒充完整ripgrep。

read_file默认16000字符/48000 UTF-8字节，最长16MiB文本；长行有版本绑定的行内续读，Unicode代理对不截断，二进制拒绝。原入口增加最多8个窗口的有界只读批处理，总输出≤24000字符/65536字节；逐项保留失败，读时登记revision。路径增加真实路径核对，拒绝junction逃逸。Pi仍串行，未开启任意工具并发。

本次4文件52项通过（包含原有29项与租约/文本编辑回归、新增13项查询反例），装配/受控测量另2文件3项通过；typecheck、main/worker/preload/templates构建、docs检查通过。对照同任务：搜索2→1次，四文件读取4→1次；长单行300092→约47500字节且可完整续读。结果元数据增加会使短文件输出变大，单机耗时未证明改善，不能称端到端提效。命令日志、调度、批量编辑及后续扩展尚未以本批完成。

证据：会话工作台b1-tests.log、b1-measurement.log、b1-typecheck.log、b1-main-build.log、tooling-after-read.json。可按本批提交回退接口，不删除原证据/质量/费用台账。

### 2026-11-11 B0 首批受控基线

用户随后明确要求完成计划。工程工作树以09d8549为起点，原sprint2用户dirty文档保持不动，无付费或产品续跑。本批增加可在前后版本重复执行的`tests/unit/software/tooling-benchmark.test.ts`，产物通过`TOOLING_REPORT`显式输出到工程外。

实际基线：有用内容搜索需要grep→read共2次；4文件读取4次；10万中文字符单行返回300092字节；同文件两处修改含预读共3次。记录每项输入/输出UTF-8字节和执行时长，不把字节估算称为供应商token；单次时长只作观测，不宣布普遍性能收益。原有读写/租约/文本编辑3文件39项及新基线1项通过，typecheck通过。

证据：本次Proma会话工作台`tooling-before.json`、`tooling-before.log`、`baseline-existing-tests.log`、`b0-typecheck.log`。这是T1/T3前置的工具级基线，不代表GUI、原生、真实模型、故障恢复与所有T0样本均已测量；各扩展批次仍须补其对应基线。

### 2026-11-11 文档批次

已完成当前源码和Vide锁定版本的只读核查、总计划及专项适配设计；`npm run docs:check`、本地Markdown目标链接检查和diff空白检查通过。未运行工程性能/GUI或真实供应商测试，未修改运行代码。用户原有文档blob仍为 `53c7abb3aef8497d8b0522b8aab806c82b2ec164`。本节证明文档已整理，不将B0基线测量或任何实现批次记为完成。

### 2026-11-11 继续实施：回归取证与真实IO瓶颈

先取证而非增加超时：控制CLI夹具的导出库存扫描记录显示首次main目录约9.4秒，并在90秒信号后未交付；本机where.exe node一次约1.11秒。改为直接PATH/PATHEXT文件解析（每次重新解析，无stat缓存、不隐式执行cwd），库存至多4个文件流并行读取完整字节，保留原深度优先顺序与摘要，并在每个文件读后检查dev/ino/ctime/mtime/size。不复用旧字节hash、不放宽原输入变化/取消/链接保护。

同一受控CLI夹具改后4轮完成并交付，约41秒；main库存单次约0.89~1.22秒。环境冷/热、资源负载不同，仅作为本机取证，不承诺通用倍数。原失败日志保留；测量JSON continuation-io-profile.json、continuation-io-after.json。

真实音频夹具此前以wall-clock轮询且state=running就累计样本，不能证明音频图已产生render quantum；现在等待AudioContext时钟实际推进、只采不同渲染时刻，3秒内未就绪明确失败。正/负/恢复对照阈值、原产品及断言未放宽，观察finally关闭自己的AudioContext。

组合回归5文件54项通过，包含上轮两个超时夹具、音频8项、真实执行和新库存/路径反例；类型与main构建通过。证据continuation-regression-tests.log、continuation-b0-typecheck.log、continuation-b0-build.log。尚未在后续全部代码完成前重跑完整check:offline，不把这个小组PASS替代整套。

B8资源前置实查：WindowsSandbox.exe不存在、Hyper-V模块不可用，hypervisor存在但不能据此推定可启动Windows执行器；C盘仅约11.2GB空闲。不会自动安装镜像、开启管理员系统功能或声称worktree等于干净Windows。先完成可用模块，干净机实际资格仍为环境阻塞。

### 2026-11-11 B2续：统一受管理命令与事件等待

run_command省略yield_ms仍等待完成并给兼容stdout/stderr，但现在与yield路径共用start/readSoftwareProcess，返回相同process_id、身份、期限、停止、日志归档和依赖结果；等待窗口与120秒默认/300秒上限命令期限分离，不因读取或短等待重新启动。默认不改成强制多一次模型轮询。底层验证驱动executeSoftwareCommand仍是驱动专用执行器，不冒充自由工程工具第二条生命周期。

readSoftwareProcess去掉每次50毫秒轮询，使用同一OwnedProcess的有界change事件/超时/取消等待；输出与终态通知都能唤醒，finally移除监听。静默命令停止不再有“close已发生、状态稍晚改变而等满30秒”的窗口。不凭旧PID接管。仍不为PTY或白名单同步文件IO无收益地全开parallel，保留计划允许的有界只读批处理。

执行/异步/归档3文件21项通过；新增旧等待同一process/归档/仅启动一次、静默停止唤醒用例后异步8项通过，真实Pi增量读链、取消/timeout/stdin/EOF/退出与任务未验证区分保留。typecheck/main构建通过：continuation-b2-tests.log、continuation-b2-final-tests.log、continuation-b2-typecheck.log、continuation-b2-build.log。重启去重与连接恢复仍在V4后续集成，不据此声称已认证所有重放排列。

### 2026-11-11 B3续：有序多文件编辑（明确非原子）

edit_file沿原入口增加files（最多8文件、每文件1~32处，整体原输入大小门），与单文件形态二选一。所有路径/内容hash/授权/冻结保护/片段唯一性/语法先全部预检，任何预检失败不写任何文件；单文件语法只验证一次。实际依次在原写租约/CAS中提交，提交点仍重新核对路径/权限/取消/内容版本。失败或取消立即停止后续项，返回applied/failed/not_attempted各项事实；不回滚他人的并发改写，也不宣传跨文件原子事务或崩溃自动回滚。

四文件48项通过，含原护栏与新增多文件全预检拒绝、重复路径、冻结拒绝、首项后外部同长改写、取消后保留已写事实。实际Pi AgentSession分别执行单文件和多文件schema各一例，仍保留读取批内失败；收紧多文件额外参数后2文件14项复测通过，typecheck通过，主构建在额外schema约束前通过（最终整套会重新构建）。证据continuation-b3-final-tests.log、continuation-b3-schema-tests.log、continuation-b3-typecheck.log、continuation-b3-build.log。未做真实模型格式/费用对照，不将工具级通过替代产品验收。

### 2026-11-11 续接标准回归与G1/V1、缓存边界

HEAD6696d39完整check:offline exit0：原标准19文件206项通过、工具11文件137项通过，含完整renderer/main/worker/preload/templates构建与类型/文档检查。日志continuation-standard-check.log及版本continuation-standard-version.txt。此前失败历史保留，不把这次通过外推到之后所有代码。

inspect_app沿原debug生命周期新增capabilities、observation(selector/role/name/query/frame/cursor/limit)、control(ref/kind/value/key)。观察为**DOM派生的最佳努力角色/名称/状态/层级，不是完整浏览器AX树**；每frame至多4000节点、深度32、至多16 frame、最多80返回，输出<=16000字符/48000字节。显式报告扫描缺口、Canvas视觉需要、closed shadow/未渲染虚拟行不支持；开放shadow与iframe真实查询通过。区域多命中拒绝，不点击第一个。

refs绑定当前观察、实际ElementHandle和document，DOM变更/路由/视口缩放与滚动/原生表单状态改变/替换/关闭后拒绝；新观察与一次动作都使旧refs失效。定位用真实元素，不写业务DOM或注入业务控件ID，不改验收/发布权威。输入取消关闭**本会话拥有的页面**防止待输入晚到，已派发输入不能撤销，明确OUTCOME_UNKNOWN而不自动重放。观察放在截图/检查点之后，避免诊断临时样式影响刚返回的refs。热更新仍是原正常入口重启+隔离数据，不假称框架热重载。

3文件24项通过（9 DOM反例、9原/新debug实际运行、6原GUI协议）；新增browser及Electron各一条真实实例观察→ref点击→状态1→跨会话拒绝→旧ref拒绝，原数据保留、重启、脚本/下载/错误链均通过。typecheck和完整build通过。日志continuation-b4-all-tests.log、continuation-b4-typecheck.log、continuation-b4-build.log。UIA/原生输入及最终平台App的Cua验证尚属后续，不能把DOM/Electron夹具通过说成已完成G2或原App升级。

V5边界修复：先前默认Vitest曾写共享node_modules/.vite缓存（子产物也披露），未擅自回滚未知共用缓存；实际依赖安装/包源码未改。所有管理脚本改runner configLoader，vite.config以import.meta.url确定项目根、缓存放各worktree的.cache/vite（原fingerprint已排除.cache），renderer build同样使用runner，避免.vite-temp bundling。修复后独立9项+真实renderer构建前后，两处已知共用缓存(.vite/vitest、.vite-temp)的清单/字节hash/mtime/size不变，continuation-cache-isolation.json。仅证明这两处，不伪称全共享依赖写入审计。

### 2026-11-11 C1续：真实TS/JS语义与独立计算worker

审阅唯一协作子Agent的独立代码产物并复制其code-service.ts及31项真实TS/JS测试，未把产物支架、依赖junction或临时配置复制到仓库。父补排除.cache/.context/.bloma-build，沿inspect_repository增加definition/references/diagnostics/symbol/capabilities，继续原project身份/实际root/脱敏与白名单。没有移植Serena代码或引入GPL组件。符号仅指定文件声明导航树，坐标1-based UTF-16；fileVersion/indexVersion为sha256:前缀的实际字节/本次观察域身份，不是候选PASS或跨查询通用仓库revision。

LS不emit/加载项目插件/执行业务脚本，无默认node_modules越权；缺依赖、越界、配置错误、project references不支持、截断和新查询失效显式报告。不把词法import/declaration候选冒充语义。每请求fresh LS，不宣称增量索引或所有TOCTOU/OS沙箱保证。

父将实际工具查询放独立worker thread：只接宿主解析的project root和固定request字段、空env、execArgv=[]、512MiB heap、最多2个并行、15秒宿主硬期限及取消终止；无动态脚本或模型权限。TS内部仍10秒协作期限，worker层让主事件循环可处理取消，不将同步LS误标为UI及时可取消。build-state新增semantic组件，正常all/main构建含worker；字节新鲜度/输出证明沿原构建体系，worker失效不以内联旧实现补位。

4文件63项通过：核心31、生产构建worker3（真实定义/Python缺口、硬终止与host ticks、槽上限）、构建新鲜度28（含新增semantic/source变更归属及原实构建/锁/新鲜度断言）、实际Pi1（四语义mode与capabilities，真实工具schema与worker，无付费供应商，另验跨project拒绝及Python缺口）。最初worker夹具把坐标落在标识符前空白，修正为57列；Node构建脚本经Vite转换报语法错、native import正常，构建测试改真实Node加载，未删/放宽任何构建断言。证据continuation-c1-final-tests.log、continuation-c1-typecheck.log、continuation-c1-build.log。

Python仅发现解释器、无真实语言服务器，本批明确返回PYTHON_BACKEND_UNAVAILABLE，**还没有Python stdio桥或正向语义认证，C1/B6不能整体标完成**。T4上下文成本实验仍待做。runtime inventory/G1/C1/build-freshness共7个新增文件已纳入test:tooling:offline，运行前按原build-state构建semantic；最终需再跑全部原门禁与新增，不把本批63项当全套。

### 2026-11-11 V2续：宿主实际提交/进程事实在工具卡展示

补读锁定Vide版本三组件和LICENSE，仅参考、不复制代码。Bloma沿原ToolOutcome.detail、Pi tool receipt/details、audit tool_result和tool_call_completed扩展有界display投影，不新建执行台账或PASS。代码只渲染React文本，不执行HTML/ANSI、工具URL或重放工具。

文件差异在原process-local lease的成功write后产生（原文UI捕获<=1MiB），来自实际UTF-8提交前后字节，含SHA256与行号；是精确连续替换片段而不是最小多hunk算法，片段截断/未捕获明确标注，脱敏先于裁剪。多文件部分写只展示已applied项，原始结果摘要保留失败/未尝试信息。大原文/非UTF-8不可伪造完整diff。版本记录改为本次提交字节hash，不把可能随后外部改写的字节登记成模型已读版本；仍不承诺跨进程文件锁/原子事务。

进程卡显示本次读取时的状态、退出码、有界输出、归档可用/缺口和原会话read_process日志查询入口；入口是可见只读查询说明，不执行重放/启动，不以退出0当产品PASS。通过原反馈明确running/cancel/budget/未验收，修复ChatPanel过程组此前丢掉feedback的接线；请求声明仍“调用已登记”。实时摘要剥离反馈封套再裁剪，避免500字只剩内部元数据。历史有展示元数据就原样校验回放，无元数据明确只有摘要，不能重构假diff。

7文件35项通过（新diff投影3含127组可重构反例、renderer3、原feedback UI2、写租约5、多文件12、实际Pi文件2、真实异步命令8）。实际Pi验证同/多文件host display经过真实事件与历史JSONL一致；单测并非最终平台App界面验证。typecheck通过，最终平台Cua/当前全部新版本离线标准仍待统一验收。证据continuation-v2-tests.log、continuation-v2-typecheck.log；新UI3文件已接test:tooling:offline。

### 2026-11-11 B5首期：隔离交互探索沿原质量闭环接线

新增宿主可选`BLOMA_INTERACTION_EXPLORER=1`策略，默认关闭，待单独授权真实模型成本/收益验证再决定是否默认启用。在当前候选实际本机验证、合作者收敛后，宿主安排新的UI-only Pi会话，只给确认目标、自己的DOM语义观察/refs、合成数据操作、关闭重开及结构化疑点提交；不给实现、自评、shell/script/任意URL、文件写、纠正批准或发布工具。保留原费用/请求/输出守卫，每次请求（含transport retries）重新保护必要收尾/C/V预算及资金/期限；缺报价不当作免费。至多6轮/12次界面调用、90秒独立期限；取消排空自己的实例，未知输入结果不重放。沿现有debug生命周期和data/profile，不import付费试验控制器、不复制凭据或旧用户数据；目录隔离不是OS/网络沙箱，不承诺应用本身无法发外部请求。

每个UI操作核对实际产品库存字节、目标和冻结合同；提交点及宿主返回再核对完整环境。debug fingerprint与release inventory哈希是不同协议，分别绑定而不互相比值；初版因此拒绝真实实例，已修复并保留失败日志。初版每次点击重算整个宿主运行时导致组合用例60秒失败；取证后改为逐操作仍完整重读产品字节、提交再重核完整宿主环境，未放宽生产/测试期限或移除预期。

发现写原quality ledger，`purpose=exploration`明确不是C/V；宿主绑定版本/trace/hash、保留原触发/确认预期，只登记suspected，模型不能指定checks、确认失败、关闭或PASS。同候选、相同触发及相同规范化实际旅程才归并，不吞不同输入/操作；新的源码不让旧发现自动消失。沿原read_quality_findings/read_quality_review有界分页读取历史trace，不重放动作。原独立案例绑定、真实verifySoftwareCandidate、失败/修复重测及C/V/发布门禁不变；显式排除exploration冒充新鲜C/binding或已发布基线C凭证。

4文件81项组合通过：新浏览器探索7、质量审阅35、质量收尾19、协作选择20。含Ω合成输入保存/重开坏/好对照、源变更/错session/伪造预期/无实际观察拒绝、取消、重复不吞不同触发、预算保护和实际Pi三工具边界；另有正常UI→原finding→实际独立C读取冻结case和trace并绑定→原宿主CLI复现失败→改实际实现→同冻结case通过并关闭→最终C→原release发布的临时fixture闭环。后者证明原质量/发布机制贯通，不是GUI成品全部功能/真实模型普遍自主发现认证。保留整份计划未完成状态；最终版本标准离线门禁、真实平台App、原生和干净Windows仍待后续。typecheck、main/worker/semantic/preload/templates构建、docs通过；六保护文件SHA及原HEAD/dirty/blob未变。

证据：会话工作台continuation-b5-final-tests.log、continuation-b5-typecheck.log、continuation-b5-build.log、continuation-b5-docs.log、continuation-protected.b5.json；初次输入契约/哈希范围/性能失败见continuation-b5-tests*.log。未启动付费模型，不把受控响应解释成供应商或成本认证。

### 2026-11-11 B6：可选Python静态语义桥与T4实际请求测量

Python沿原inspect_repository四mode接固定宿主stdio桥，不新增模型工具/自由命令；真实Jedi0.19.2/Parso0.8.4，非LSP。definition/references/符号为真实静态分析，diagnostics仅语法，不声称类型验收；Jedi不提供一般读/写数据流，references显式writeAccess=unknown。缺依赖会缩小解析域，外部位置不当项目授权。仅宿主明确设置BLOMA_PYTHON_SEMANTICS_EXECUTABLE、BLOMA_PYTHON_SEMANTICS_SITE两条绝对路径才启用；capabilities实际启动固定桥probe，不以文件存在冒充可用。默认无配置仍PYTHON_BACKEND_UNAVAILABLE，不安装系统/产品依赖，不自动搜索项目venv；这是可选开发能力，不影响产品原验证门禁。

宿主有界复制UTF-8 .py及配置（单文件1MiB、总8MiB、最多256文件/深40/目录数和成员限制；链接拒绝、常见依赖/cache忽略），每次全新进程/数据，完整原字节、目录成员、真路径复核及实际分析副本复核，源码/配置/新模块/同mtime-size改写或分析副本被改都不返回旧成功。fileVersion为原字节sha256，indexVersion仅复制观察域+适配器字节/声明后端身份；不是全仓库/可信解释器或所有包字节证明。位置统一1-based UTF-16，覆盖BOM/CRLF/astral Unicode，不切surrogate。输出最多200项、65,536 UTF-8字节，有截断事实。

绝对宿主Python以-I -B -S运行固定main/templates/tools/python-code-service.py，不处理PYTHONPATH/cwd/site/.pth；只显式载入宿主私有Jedi/site。Project固定analysis副本，smart_sys_path=False、load_unsafe_extensions=False、显式sys_path；禁unsafe interpreter执行及auto_import_modules，固定InterpreterEnvironment避免Jedi默认无隔离flag的子进程。Python audit hook限制源读取为宿主清单、项目代码执行/外部进程/网络及越界写，cache仅本次目录；**不是OS沙箱或硬堆限制**。初版fast_parser=False导致真实Jedi函数过滤KeyError；按固定版本实现改为每私有进程一个Script的局部Parso树cache，不跨查询复用，不修改共享依赖源码。宿主共享TS/Python最多2个语义请求，15秒默认/30秒上限；取消/期限终止自己的子进程（Windows沿原tree-kill模式）、等close与停止完成才释放槽；不把Python藏入可被terminate的Node worker。TS原worker/512MiB上限仍保留，未把该堆限制误称Python限制。

验证：5文件50项组合通过（原TS31、executor3、原Pi1、新Python14及新Pi1），再加分析副本篡改防护并重跑Python/Pi **2文件16项通过**；随后增加Windows树停止、编码/stub明确缺口并重测。包含跨模块alias/局部同名/无依赖、版本变化、真实符号/语法错误、类型错误不伪造诊断、双槽/取消/期限、broken backend无词法补位、项目marker/.pth/sitecustomize不执行及实际Pi五操作/原项目权限拒绝。私有验证依赖仅安装在会话工作台python-semantic-deps，独立pip cache，未安装或修改系统/共享node_modules/真实产品。Jedi/Parso及自带stub许可留在原wheel，不复制进源码；wheel/hash清单validation-dependencies.json。专用test:python-semantic:offline要求TEST_PYTHON_SEMANTICS_EXECUTABLE/SITE私有验证路径（测试守卫清除全部BLOMA_，不放松守卫），缺依赖明确失败而不跳过正向认证；常规离线组保留默认缺配置反例，不把可选后端变成系统安装前提。

T4用真实软件Agent parent生产装配（35工具，未含每产品quality/scope/check附加工具）、Pi、原budget与本机HTTP/SSE记录实际序列化字节，不付费不做usage估算。比较“提前把8个topic全部塞系统”的反事实与当前按需策略：schema31,703字节、稳定hash/顺序；系统19,441→6,315、首请求51,407→38,281，省13,126字节。但按需实际多一次工具往返，首任务两请求总77,564，**高于**提前塞入时单次51,407；不能据首包宣传总输入/费用下降。恢复后仍35工具、同schema hash，不重读已读上下文；显式撤销为9个只读工具后schema8,291，未知run_command请求不执行/不写marker、不从历史恢复旧权限。无通用MCP/codemode/tool_search/REPL。只证明稳定集合与薄按需接口可用，不启用无准确率收益证据的动态schema，也不把wire重复当供应商缓存命中保证。

T4实际HTTP专项1项通过；原Pi恢复/中断receipt/原生compaction带当前宿主恢复摘要选择4项通过（不是整47项重测），最终整套待统一。证据：tool-context-wire.json、continuation-b6-t4-tests2.log、continuation-b6-t4-recovery.log、continuation-b6-all-tests.log、continuation-b6-final-python.log、continuation-b6-final-typecheck.log、continuation-b6-final-build.log。失败保留：首轮测试私有环境变量被既有BLOMA_守卫清掉、fast_parser KeyError、BOM fixture转义和HTTP fixture漏PATH，修正输入/适配器，不削生产断言/权限或时限。

B6最终专项将原TS/执行器/Pi、新Python/Pi及实际HTTP测量一并核验；Python .pyi明确不支持，非UTF-8 coding声明拒绝而不按错误编码返回名称。

B6最后版本 **6文件53项组合通过**（Python16、Python实际Pi1、T4实际HTTP1、TS31、原executor3、原Pi1），continuation-b6-env-tests.log；typecheck及main/worker/semantic/preload/templates构建通过。同组前一版本52/53时一条Python symbol触发15秒DEADLINE_EXCEEDED，失败保留continuation-b6-integrated-tests.log，不算通过，也未放宽期限/删断言。取证确认Windows/libuv会给显式env注入USERPROFILE/PATH等默认项；固定Python bootstrap现于导入Jedi前清除这些项，只设置本次workspace HOME/USERPROFILE及cache TEMP，避免宿主profile/cache发现。该环境边界修正与53项新版本通过不证明已穷尽旧次时延根因；独立冷启动3样本2.5–2.9秒仅当前观察，忙碌系统仍可能按原15秒返回明确deadline，不承诺普遍延时。私有阶段计时与importtime日志continuation-python-importtime-fixed-*.log供诊断，不是费用或性能倍数认证。

### 2026-11-11 G2首期：自有Windows实例的原生UIA与截图

沿既有inspect_app/debug session为Windows managed Electron实例及其原生子窗口增加native.query/window_ref/control，不增加PID/HWND/RuntimeId/脚本入口或第二套App生命周期。宿主OwnedNativeUi与固定owned_native_ui.ps1使用系统UIAutomationClient/Types、WindowsBase/System.Drawing，无第三方安装；实际普通用户态WinForms后端、Electron真实inspect链已验证。未扩成任意应用/pywebview原生启动器，不替代既有browser/electron默认入口或C/V。

根仅来自本次活调试实例的nativeRoot/owned process记录；逐次检查进程start ticks及进程树（CIM创建时间与当前原生start ticks核对），只在归属成立后读取窗口/控件，不扫描邻近用户窗口内容。HWND、UIA RuntimeId和原始控件值/状态/窗口DPI、边界/模态/最小化、全部已扫描视图指纹留在宿主。模型只有UUID观察引用，重观察/跨会话/DOM与native切换/重载/关闭/一次动作即失效；动作前重新查询并核全视图。多窗口必须选择当前window_ref，不凭名称取第一项；重复按钮保留不同refs。值/Toggle/selection/expand状态均入指纹，完整值hash而非裁剪前缀，密码不读取。**仍非原子UI保证；暂未建立持续WinEvent窗口世代watcher，极短同进程HWND/RuntimeId复用是明确缺口，后期隔离反例仍需补。**

只开放Invoke/Value/Toggle/SelectionItem/ExpandCollapse六类真实UIA pattern，记录方法，不冒充真实鼠标或键盘。没有全局前台输入/SendInput/抢焦点。宿主单一派发与Windows Local命名mutex约束本App同桌面会话的原生pattern调用，不宣称能锁住外部软件/整个桌面。每次固定适配器15秒，取消/timeout等待自有子进程排空；派发后结果不明标OUTCOME_UNKNOWN，已确认pattern返回但后观察失败标DISPATCHED_OBSERVATION_FAILED，均不重放。关闭native取消并排空当前helper，不接管持久化旧PID/引用。源码已变时旧control拒绝，不能自动重启后重放旧输入。

最多16窗口、1000节点/深24，返回80项/32000字节控件窗口，适配器262144字节输出硬上限；文本裁剪和虚拟化/未暴露/上限缺口明确。UIA provider卡住按deadline失败，不扩大到相邻窗口。选定自有HWND用PrintWindow（PNG像素上限3840×2160/20MiB）；缺图/最小化/GPU缺口不退到整桌面。捕获匹配目标DPI awareness以避免当前144 DPI下逻辑绘制落在物理大画布的黑边，图像像素与UIA屏幕坐标不混用，不保证树/图同一原子瞬间。view_image(debug_session_id,surface=native)及include_image返回对应原生图，无原生图不冒用DOM截图；附图不签PASS。WinForms两版实际图native-ui-proof.png/proof2.png已读取核对：后者无多余黑画布，真实标签/重复按钮/输入框可见。不是Cua或用户常用平台App验收。

当前专项证据：native-ui首次3项、扩展5项真实WinForms反例均通过；包含实际Ω文本保存字节、重复名称、跨实例/旧refs、Toggle状态改变拒绝、进程start token拒绝、真实自有模态选择/关闭、单派发竞争，以及UIA实际触发慢事件后取消client而应用随后仅写一次（不把取消当撤销）。Electron真实inspect_app→UIA Button Invoke→DOM独立读到计数1、原生截图经view_image、跨会话/原始PID字段/混输拒绝也通过。最近focused native/UIA选择2项通过仅是定向，不把13项未选冒充整套；本批最终组合另记。日志continuation-b7-native-tests.log、continuation-b7-native2-tests.log、continuation-b7-wire-tests.log。

O1完整IPC/存储保存失败链、B8世代/重连/隔离/干净Windows及最终整套仍待续做。Cua专用driver记录不存在且命令不在PATH；定向检查Proma resources/bin及app.asar.unpacked未找到cua，不擅装/重装/改安全设置。最终真实平台Cua仍需用户完成设置，不能用本批Native/Electron夹具替代。

G2首期最终版本 **4文件30项组合通过**（native UIA5、debug10、原DOM语义9、原GUI协议6），continuation-b7-g2-offered-tests.log；typecheck/main及worker/semantic/preload/templates构建通过（对应offered-typecheck/build日志），docs通过另记。额外收紧ref授权为**只允许本次实际返回的控件索引**，不能按已知snapshot UUID伪造未展示的内部扫描index；1项返回窗口下伪造:e:1的反例拒绝。显式旧/关闭实例control不自动开新App重放，Electron实际测试已关闭后再次传旧ref并确认无新活动实例。此前g2-tests日志中GUI协议参数误写到不存在目录，实际仅3文件24项，不算4文件；随后已用正确路径重新跑上述4文件30项，未跳过失败或修改生产时限。保护对照continuation-protected.g2.json不变。

### 2026-11-11 O1：原调试事实中的保存失败链（非事故/PASS账本）

在原debug-sessions观察和diagnostic-context导航上补debug-evidence-v1，不新建工具名、统一管理Agent、故障账本或验收状态机。inspect_app(mode=read,diagnostics)支持kind字面前缀、action/operation_id/trace_id/process_id/source/version精确过滤及ISO时间范围；since_seq+diagnostic_page.next_seq有界前向续读，最多80条/12000 UTF8字节；保留原默认最近16条、200条/64000码元滚动，明确retained_from_seq/history_gap，不能把丢失记录当EOF或PASS。当前source仍由原候选指纹绑定，历史行保留原version/source。

backend改读既有owned process逻辑记录的seq，而非用stdout/stderr尾串相减猜增量。每实例保持process ID/输出seq，重复read不会重复采入；换进程单独重置，原stdout/stderr及归档仍是权威来源。保留进程/记录seq、归属与source；滚动缺口、长行裁剪和归档不可用都明确。backend晚到接收不塞给当前click：correlation=temporal-only，无伪造action或operation。network保留request-start观察；真实Native pattern返回是host-dispatch，依然不证明业务成功。持久化原snapshot的seq高水位，为后续恢复补证，不接管旧PID。

必要应用可选以console/stdout/stderr输出一行 `BLOMA_DIAGNOSTIC {"kind":"ipc","phase":"failed","trace_id":"app-generated-id","code":"ENOENT"}`；kind只ipc/storage、phase只request/completed/failed、可选短code/message，不接应用自报host source/seq/动作/归属/状态。宿主把这些标为application-reported而非拦截全部IPC，更不是因果/独立C/根因裁决；没有埋点就诚实缺失。严格4096字节、字段白名单、脱敏，trace/code即使恰为宿主环境secret也不泄露或伪成有效关联ID。原普通console/backend记录仍保留；不注入IPC monkeypatch或更改生成产品。capabilities与原read_production_context(diagnostics)给出同一协议及导航。

实际mutating debug调用（步骤/脚本/native/reload）的宿主operation UUID区间只读本次owned debug data：异步opendir/文件读取、128文件/64目录/深12、每目录512成员、1MiB/文件、总8MiB、协作1500ms；真路径/无链接/前后文件身份与目录成员复核，输出仅文件字节数/sha256/最多8处相对路径差异，不采正文、不扫宿主盘。**APP_DATA_DIR/electron-profile是原bindSoftwareProfile实际管理的Chromium缓存目录，明确列入排除域**；complete仅代表声明的有界文件域，不代表profile/localStorage或全部磁盘。前后scope变化、取消/限额/读取/链接问题不出完整digest；不完整一侧缺文件只能unobserved，不能猜删除/unchanged。记录前后source/version/at/operation_id，纯read/query不假装新存储观察；不保证FS原子性、点击因果或OS沙箱，不签PASS。

真实Electron普通入口对照：preload真实ipcRenderer.invoke(save)→main真实fs.writeFileSync(notes/note.json)因缺父目录抛ENOENT→owned backend stderr真实错误+同应用trace的request/failed→renderer catch与可见Error:ENOENT；host排除已声明profile后确认notes未落盘。修fixture源码mkdir(recursive)后沿原reload绑定新candidate/version，同输入保存真实UTF8“真实保存 Ω”文件；close后正常入口实际读取同文件并显示（未重注入缓存/期望）。旧source/trace失败行仍可查，原质量/验证未跑、不认证业务通过。真实Pi还通过公开schema读取这条现存trace并得到application.ipc.failed，SDK响应受控、不收费；修复是测试作者实施，不宣传模型自主排障/自动修复。G2/原browser/electron持久化与原GUI协议不变。

**最终7文件43项组合通过**：evidence7、真实保存+Pi1、debug10、GUI协议6、原归档6、异步命令8、真实Native5，continuation-o1-release-tests.log约260.56s；release-typecheck/build日志通过main/worker/semantic/preload/templates，docs另验。新增反例含伪造host字段/PASS/大marker、分页/时间/候选/进程、Unicode/binary/__proto__文件、链接/配额/取消/缺目录/范围变化/主循环tick、结构化secret泄露。工具专项现在28文件；Python正向仍单独跑。

保留初次5/6失败：storage扫描误包含实际electron-profile缓存，触发DATA_BYTE_LIMIT与缓存变化；没有把它当完整未变。按原“不扫描整个profile”约束改为明确排除宿主管理profile并标注scope，未提高字节/期限、未删断言。continuation-o1-tests.log、save-test2.log及save-failure.json保留；后续6、7、36项阶段通过也不替代最终43项。最早Python编辑正则转义造成TS语法失败，修源码转义后通过，typecheck失败日志保留。保护对照continuation-protected.o1.json不变。

B8窗口世代/旧终态重连/隔离/E1与最新全套仍待；本批不是Cua平台或干净Windows验收，不解除费用暂停、不改生成产品/项目registry/原账本、不push或合原sprint2。

### 2026-11-11 B8：自有HWND世代标签、历史终态与双读者重连

不新建桌面管理器/持久daemon/事故账本。Native adapter给**已核owned PID/start的HWND**添加每OwnedNativeUi私有UUID键的两个非零63bit不透明运行时属性；同窗口跨短PS helper保持，窗口重建/标签缺失产生新cookie，纳入私有整域fingerprint。UIA行若有NativeWindowHandle也绑对应owned HWND；无HWND虚拟节点仍provider RuntimeId/视图约束，不能泛称恶意provider安全或持续AX树。模型schema不给key/value/PID/HWND/脚本/任意adapter kind。观察确有这两项**宿主运行时元数据写入**，不是零写；不改产品DOM/业务ID/源码/数据，不动外部App窗口，UIPI/非64bithelper不可用明确拒绝而非降级动作。未引入WinEvent watcher，不把异步事件迟到当同步窗口身份。

pattern前重扫整域指纹后，紧邻派发再读已有cookie（不创建）、核控件HWND/PID/start/Enabled/Iconic；截图前后也核窗口身份/cookie，变动丢弃而非附上错误窗口。非原子UI/恶意进程或外部软件桌面独占保证仍不成立。close先取消/排空inFlight，再固定release分支只删当前仍活owned窗口及子窗口的该私有key；无数据HANDLE分配/无CloseHandle伪释放，重复close复用同promise。返回metadata_cleanup completed/not_needed/owner_exited/unknown；unknown在原debug日志保留，不接管失去身份的PID、不宣称全部回收。窗口自行销毁/极短重用仍不被当作全OS压力认证。

实际WinForms新增两项：仅删一个真实Win32属性而**HWND和UIA RuntimeId都不变**时，旧ref被拒且没有保存副作用、新cookie/fp不同；正常close实际GetProp已清空。真实RecreateHandle销毁/重建Form后新cookie不同、旧ref拒绝；真实SW_SHOWMINNOACTIVE最小化后不派发Save，selected窗口minimized=true、无PNG且NATIVE_SCREENSHOT_BOUNDS_UNSUPPORTED，之后SW_SHOWNOACTIVATE恢复到自有屏幕外位置。它们不是手改响应mock；**未强制OS在同一PID下把完全相同数值的HWND复用**，不冒称完成该压力样本。原保存字节/模态/Toggle/start token/并发/派发后取消不重放反例保持。实际Electron继续经inspect_app→UIA Invoke→DOM独立读count与原view_image附图，非Cua最终平台验收。

Windows文档核验：[SetPropW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setpropw)、[About Window Properties](https://learn.microsoft.com/en-us/windows/win32/winmsg/about-window-properties)说明属性、UIPI与RemoveProp清理/数据自身不释放。仅用不分配资源的opaque值；显式close清理只作用仍活owned窗口，不能宣称旁路WM_NCDESTROY协作或OS内核沙箱。受管浏览器main正文提取/最终Observe成功，最终截图Page.captureScreenshot超时未成功，未宣称图像核验；该Agent草稿tab已关闭。

历史debug metadata现有界2MiB读取，前后文件身份/字节计数复核，拒文件链接、真实路径逃离PROMA_HOME、异常结构/重复或倒退seq/错误高水位；不把损坏历史当成功EOF。纯历史closed/failed/interrupted保留真实终态和原错误，只有遗留opening/ready才转interrupted。runtime_attached=false/retained_snapshot=true/stale=true公开，旧PID/refs不接管、输入不重放；重复close历史closed/failed只读返回、不杀进程也不改原文件。当前活实例另有runtime_attached明确标记，历史不出PASS。

seq>0接续改为从最早未读前向分页，不能默认tail截掉16条后就把cursor跳至末尾；显式since_seq=0公共工具也前向分页，未给cursor的原默认最近16条保持。两个读者各用自身next_seq，服务器不设破坏性consumer cursor；无新记录为空、滚动retained_from/history_gap明确、越界cursor拒绝。纯历史双读者实际排空90条完全同序/不重复；真Electron/Pi保存失败测试同时通过公开inspect_app由两个客户端显式cursor0读相同首批，原Pi trace查询及保存/修复/正常重开不变。

**最后7文件48项通过**（Native7/debug10/save+Pi1/evidence7/recovery8/GUI6/DOM9），continuation-b8-release-tests.log约297.98s；当前release typecheck/main相关构建/docs通过，tooling入口现29文件。保留首次组合47/48失败continuation-b8-final-tests.log：Pi在原15秒窗返回cancelled；新增可选phase计时后，单独及同组合通过，未抬期限/删断言。计时当前样本显示首次query前约7.7秒、真正inspect读取约60ms；**不能用新通过穷尽断言旧cancel根因已修**，负载/冷初始化仍可明确deadline，最终大组继续检验。首次新fixture漏System.Drawing引用，setup失败/7未运行日志保留；补系统程序集后focused2通过（5未选，不冒充7全跑）。一次长Windows命令在Python解析前截断、一次测试调用参数顺序/字段拼错被typecheck拦下，均修源码后通过，未执行不明生产写入。

六保护/原HEAD及唯一dirty blob对照continuation-protected.b8.json仍不变。B8剩余资源归属/隔离/E1候选交付协议、V3原伙伴长程贡献与最新全套继续，不以本批结束全部计划；Cua/干净Windows外部条件仍单列。
