# Bloma 工具与工程能力升级：当前交接与首批历史

## 2026-11-12 修复后最终门禁与合入（最新）

用户批准最终回归、隔离App冒烟及通过后的合入。生产/测试验收点为 `f44ea41924d1a64b7b2f5c169d27052499fc5e80`，随后仅记录文档。此次代码不再沿用旧605项作为当前认证。

- `npm run check:offline` 一次完整exit0，13:07:15–13:41:00北京时间，约33分45秒；前后HEAD一致、tracked clean。包含类型、docs、完整构建、verification **19文件207项**及tooling **41文件401项**，合计 **60文件608项**。无重复整套、改期限、删断言或跳过失败。
- Python正向另组 **2文件17项通过**，约70秒，使用原宿主TEST_*私有Jedi环境；无安装和付费模型。它不是同一个check命令，也不是全仓test:all。
- 通过外部受控测试建立全新临时PROMA_HOME样本：真实Pi完成两文件批改及一次Node命令，原工具审计/交接落盘；响应受控、未连接供应商，不是自主生成能力评测。
- CUA当前可连接。实际读取当前build的Bloma原生窗口、截图和UIA，操作“查看过程”并核对批改两路径、命令exit0/stdout42/归档信息；Escape关闭详情，Ctrl+R后项目/历史/未交付状态恢复。正常界面仍提示未连接模型、发送禁用，未发送业务请求。初次隐藏启动无可操作窗口，换为可见验收实例后完成；元素点击的坐标信息不足时改用当前截图定位。验收实例已结束，未操作常用App。
- **以上只是有限的当前平台GUI冒烟**：确认历史回执可读，不将原始工作记录中的JSON等同于新差异卡/进程卡的完整原生视觉验收；实时流、全部布局/交互和真实供应商端到端体验仍未覆盖。“CUA未配置”不再作为本会话阻塞理由。干净Windows和新预算下的真实模型效果实验仍待条件具备。
- 六保护SHA仍与原最终基线一致，原用户dirty文档blob保持 `53c7abb3aef8497d8b0522b8aab806c82b2ec164`。按已批准顺序将本分支快进合入sprint2并检查主树构建；不push、不重启常用App、不解除费用暂停。

证据根：`C:/Users/17359/.codex/reviews/bloma-tooling-20261112/`。包含 `offline-f44ea41.log` / `offline-f44ea41-result.json`、`python-f44ea41.log` / `python-f44ea41-result.json`、`ui-fixture.test.ts` / `ui-fixture.log` / `ui-fixture.json`、`ui-app-instance.json`、`final-protected.json`。CUA截图与实际UIA观察保留在本聊天工具记录中；未用模拟IPC页面冒充当前App。

## 2026-11-12 独立审查后的定向修复（最新）

基于 `d1a3a97`，按用户授权处理两项P2。本节覆盖下方对应旧实现描述；下方“后续只改文档”和整套验收结论只描述Sol原收尾，不覆盖本次修复。

- 实际文件提交成功后即向原 `ToolState.successful_file_changes` 登记路径，早于回调与取消；多文件全部成功及部分成功都保留准确交接，部分失败返回也附已应用paths。真实Pi测试断言 `files_changed` 和 `buildTaskHandoff().changed_files`；部分冲突/取消反例检查只登记已写文件。
- 日志取消每HOME终身16槽位限制；按已有jsonl实际字节计量，每文件仍8MiB、每HOME合计128MiB，另有10000文件元数据上限。旧日志计入，旧slot保留但不再占配额，不自动删除证据。显式清理释放空间后新归档可继续建立。
- 容量检查和追加采用跨进程排他锁，最多等250ms；遗留锁/IO错误明确标记缺口，不猜PID或抢锁，不停止工程命令。同一管道输出块一次检查/追加，避免每行重复枚举目录。不保证任意归档数量下固定性能；不宣称旧版本进程继续写入时也受新总配额约束。
- 清理候选复现文件行尾空白；`git diff --check 09d8549`（包含本次工作树）通过。

最终定向组合 **6文件47项通过**（async8、execution9、process-log9、Pi文件2、batch-edit12、handoff7），包含双Node进程竞争剩余容量、40份小日志/16份旧slot兼容、容量耗尽/释放及管道块有序归档。类型、`build:main`（main/worker/semantic/preload/templates）、docs检查通过。中间45项/10项是重叠批次，不相加。**本次未重跑完整605项或Python正向17项**，旧结果不作为修复后整套认证。

证据：`C:/Users/17359/.codex/reviews/bloma-tooling-20261112/repair-final-combined.log`、`repair-protected.json`。六保护SHA与Sol最终基线一致；原仓库仍 `09d8549`，唯一dirty文档blob仍 `53c7abb3aef8497d8b0522b8aab806c82b2ec164`。无付费请求、合并、push或常用App重启。CUA、干净Windows和真实模型效果边界保留。

## Sol原收尾记录

更新时间：2026-11-12（Asia/Shanghai）。代码验收点：**90b636f1ed626eb61c9bc772cb2914a277b8e08a**；后续本次收尾提交只同步文档，不改生产/测试源码。分支仍为 `proma/tooling-upgrade-20261111`，未合原 `sprint2`、未fetch/push、未发布或重启常用App。

**结论：本轮授权的B0–B8本机工程建设和受控离线验证已收敛；当前同一代码的完整标准门真实通过，不是专项相加。整份计划的最终平台Cua、干净Windows/系统故障矩阵与真实付费模型效果仍未验收，所缺外部条件见下表。不能宣布全部外部认证完成或用户常用App已升级。**

## 当前可接手入口

- 当前worktree：`C:/Users/17359/.proma/agent-workspaces/default/c8ff45a0-bce1-4744-9f16-3612de0db557/bloma-tooling`。
- 会话证据根：`C:/Users/17359/.proma/agent-workspaces/default/c8ff45a0-bce1-4744-9f16-3612de0db557/`。原始失败/版本/CPU profile/图和最终证据全部保留。
- [总计划与按批事实](agent-capability-upgrade-20261111.md)、[Vide采用边界](vide-adoption-design-20261111.md)、[八类场景与收益反例](tooling-evidence-index-20261112.md)、[候选复现协议](candidate-reproduction-protocol-20261111.md)。历史pending须与当前源码及这些最新事实核对，不能再从下半部首批表重做B4–B8。
- Pi仍sequential，原Task/Assignment、quality ledger、C/V、验证/发布/费用权威不变；无统一管理Agent、新PASS/事故账本或平行候选状态机。全程只用了同一个已收敛的C1 Proma协作子会话，其余由主会话推进。

## 当前已落地与限制

| 范围 | 本机当前实现 | 明确保留的边界 |
| --- | --- | --- |
| T0/T1、B0/B1 | grep正文/有界分页、批读8窗口/逐项错误、Unicode限额/续读；八类场景、真Pi两文件修复和归档长日志ABBA | 有限glob/JS regex，非完整rg；文件调用5→3、总工具13→11，但SDK轮数12→12；最后兼容样本更快，不吹普遍倍数/费用 |
| T2/T3、B2/B3 | 局部call-ID/字节观测；等待/异步共owned进程、事件等待、stdin/EOF/日志；同文件32片段与最多8文件全预检/有序CAS | 局部batch不等于全量parallel；多文件非原子/partial不回滚他人；未知取消不自动重放，无持久exactly-once认证 |
| G1/V1/V2、B4 | 浏览器/Electron真实调试、派生语义/iframe/open-shadow、一次性refs；真实提交字节diff/进程展示及Pi历史恢复 | 不是完整AX/原子UI/最终平台Cua；旧结果不执行，缺口不伪造完整diff |
| Q1/V3、B5 | 可关闭UI-only独立探索→原finding→独立绑定→坏/好复验→原发布；原工程伙伴定向问答/三源版本真实探针/同session续接与停机 | 探索仅suspected，不能给C/V/PASS；受控query和作者修复不是模型自主收益，默认开关不擅改 |
| C1/T4、B6 | 真TS/JS LS固定worker与共享两槽；可选真Jedi/Python固定桥；真HTTP schema/context及恢复/撤权反例 | Jedi非LSP、diagnostics语法级/写引用unknown；无硬OS沙箱；T4首包省13,126B但两请求总量更大，不启无收益证据的动态schema/tool-search/REPL |
| G2/O1、B7 | owned Windows UIA后台patterns/私有refs/截图；IPC/存储有界诊断、真实保存失败→作者修→重开 | 不操作任意外部窗口/不暗用全局键鼠；Win32世代属性是owned运行时metadata写入；应用自报非因果/PASS，存储complete只对声明scope |
| E1/V4/V5、B8 | HWND世代失效/真实重建；历史终态/独立读者前向seq；真双宿主exit23→新PID恢复/副作用once；实例HOME/tmp/cache/profile防链接；物理候选包/pin/runtime映射/CLI回传 | 未强制同数值HWND复用压力；部分31分钟测试用假时钟；目录隔离非干净OS，UUID/pin非签名/验收；不自动装runtime/接旧PID；远端daemon/Flutter/TUI属原设计后续条件扩展 |

## 当前完整验证：精确版本与命令

| 当前实际执行 | 终态 | 证据（相对会话工作台） |
| --- | --- | --- |
| `npm run check:offline` 完整原链 | **exit0，60文件605项**：原verification19文件207项（只新增1条fixture drain反例），原双worker；tooling41文件398项，单worker。含类型/docs及renderer/main/worker/semantic/preload/templates完整构建 | `offline-90b636f.log`、`offline-90b636f-job.json` |
| `npm run test:python-semantic:offline`，宿主显式TEST_*与保留私有Jedi/Parso | **exit0，2文件17项**，105.03s；同90b636f生产与测试代码，未安装/修改系统Python | `continuation-final-python.log`、`continuation-final-python-version.txt` |

标准job从2026-11-12 02:36:36到03:19:41，前后HEAD均完整90b636f、tracked clean且仅AGENTS/node_modules未跟踪。原verification207项752.25s、工具398项1687.88s，**同一check的&&确实一路完成**；没有拿a2245ed后另行诊断398项翻绿。Python是另一个显式正向门，不能把“605+17”说成一个原始命令或全仓所有测试。

旧失败全部保留：26309bb原组203/206；2d2dd9b204/206；a2245ed205/206且独立工具398过仍总exit1。收尾/Native/浏览器纠正的原期限从未提高，截图错误不吞成假图；2d2dd9b仅取证优化Windows fresh路径查询，90b636f只修测试超时后abort/drain再删home并补阶段诊断。当前纠正四阶段53.37s，收尾enter88.63s仍在原90s signal内完成；**通过不代表穷尽旧负载/冷初始化时延根因，也不承诺宿主无关的固定时延**。

## 外部未认证：确实需要的条件

| 尚未验收 | 所缺条件与执行边界 |
| --- | --- |
| 当前平台App完整展示/原生交互 | 尚未获得已配置的Cua driver/session。设置Computer Use后，用当前build、全新临时PROMA_HOME和独立user-data-dir开隔离实例，精确选窗口/先preview，不重启常用实例、不复制旧凭据。DOM/Electron/WinForms单测不替代此项 |
| 干净Windows安装/断网/权限/旧数据系统矩阵 | 需要用户提供独立执行器或明确授权配置。按候选复现协议转移已审物理包、独立可信pin和显式runtime映射，一次fresh原入口/证据回传；不把worktree/profile隔离当OS重置、不擅装VM/系统功能。历史低磁盘样本不是当前阻塞理由 |
| 真实供应商/自主诊断/费用与成功率效果 | 需要新的明确付费总额/范围并先核live selector、报价、账本与完整输入预留；当前暂停和unknown保留。SDK受控执行/UTF8字节/首包缩减不替代真实token、cache、费用或质量结论 |

这些条件无确认变化就不循环探测/重装/擅自恢复试验；不得直接跑含付费及旧profile/凭据复制控制器的 `scripts/software-observation-trial.ts`。当前本地工程无需为了这些缺口重做已完成批次。

## 保护与现场状态

- 六保护文件SHA与最初基线完全相等，见`continuation-protected.final.json`；原主树HEAD仍09d8549、唯一dirty文档blob仍53c7abb3aef8497d8b0522b8aab806c82b2ec164。不动原产品/registry/质量/费用/运行账本，不解暂停、不清unknown。
- 未改Proma/Codex持久画像/项目memory、镜像或SYNC-MANIFEST。仅补当前worktree未跟踪AGENTS的已核入口/命令/红线并真实review，未把它或共享node_modules链接提交。
- 本次未用且核清的bloma-semantic worktree已在可见终端无force移除（branch保留），未动用户.codex工作树；该终端已关闭。保留私有Python依赖、全部失败/最终日志、PNG及run-artifacts。有限门禁runner已终态，不是常驻daemon/Automation；没有running Proma协作或新增付费任务。

---

## 首批历史附录（不是当前待办）

以下原文只描述首批截至1655603的实现和失败。其“未实施/下一步/0个子Agent”等仅当时范围，**全部由上半部当前交接覆盖**；保留以追溯证据，不能据此重开已完成操作。

## Bloma 工具升级首批实施与验收交接

日期：2026-11-11（Asia/Shanghai）。起点：`sprint2 / 09d8549`，计划来自同日Codex最新对话。用户已授权实施，要求少用子Agent；本批实际使用0个。

**结论：基础工具首批已实现并通过专项；整份B0–B8计划没有全部完成，最终标准整套回归尚未形成全通过结果。改动留在隔离分支，未合入原sprint2、未push，不把隔离分支当用户常用App已升级。**

- 分支：`proma/tooling-upgrade-20261111`。
- 工作树：`C:/Users/17359/.proma/agent-workspaces/default/c8ff45a0-bce1-4744-9f16-3612de0db557/bloma-tooling`。
- 证据根：`C:/Users/17359/.proma/agent-workspaces/default/c8ff45a0-bce1-4744-9f16-3612de0db557/`。
- 主计划：[基础工具与工程能力升级](agent-capability-upgrade-20261111.md)；[Vide专项](vide-adoption-design-20261111.md)仍为后续设计，未声称已经移植。

### 1 实现范围

| 项目 | 本批落地 | 重要边界 |
| --- | --- | --- |
| 搜索 | grep直接给命中正文；字面/大小写/局部路径、上下文、文件模式；内容绑定分页；find/list分页 | 有限glob和JS正则，不冒充完整rg；扫描/深度/大文件/二进制/不可读缺口明确 |
| 读取 | 字符/UTF-8字节限额；长行有版本绑定续读；同入口最多8窗口，逐项保留失败 | 聚合为所有后续错误预留空间；不允许早项挤掉后项；16MiB文本上限，不是流式读取任意大文件 |
| 编辑 | 单文件1–32个片段按同一原文预检，一次语法校验和一次写入；内容SHA256；提交前CAS | 旧单片段stat版本只作兼容；新批量要求hash；没有跨文件事务或跨进程锁 |
| 路径 | 读取/搜索增加真实路径越界检查；写入再次核对并拒绝junction别名绕过原权限 | 不声称提供OS沙箱或完整对抗跨进程文件系统竞态 |
| 命令日志 | 退出不重复stdout/stderr；显式tail兼容；脱敏归档按原进程/会话归属查询、按长记录续读 | 每进程8MiB/每home16份，满额/IO/长行缺口如实报告；不自动删旧证据；同步旧命令生命周期尚未统一 |
| Pi边界 | 局部toolCallId/context、按调用ID回填结果；复用原观察事件补耗时和文本字节 | 仍sequential；白名单文件工具为同步IO，尚无收益依据开并发；不增加loop/PASS台账/模型 |

参考本地Proma上游`bf3e98ca61dd8365eceaef876c0f7473700878a6`的Pi包装/权限/sequential策略和当前安装的Pi1.4.0实际执行逻辑；采用宿主边界适配而非整体重写。未安装外部参考项目或改模型/渠道。

### 2 受控对照：不是供应商效果实验

同一离线任务驱动，旧基线`tooling-before.json`与最终`tooling-final.json`：

| 样本 | 旧工具往返 | 新工具往返 | 返回文本 |
| --- | ---: | ---: | --- |
| 定位一条业务实现并得到正文 | 2 | 1 | 147→143 UTF-8字节 |
| 读取4个小文件 | 4 | 1 | 584→1419字节；完整版本/续读/分项状态增加元数据 |
| 10万中文字符单行首次读取 | 1 | 1 | 300092→47326字节；其余有界续读，不丢弃原文件 |
| 同文件两处修改（含预读） | 3 | 2 | 205→215字节；一次校验写入 |

**只能证明这些受控样本的接口往返/首包体积变化。** 小文件元数据变大，单机耗时没有证明改善；没有真实供应商实验、费用结论、交付成功率或普遍性能百分比。

### 3 验证及未通过记录

#### 最新专项

`npm run test:tooling:offline`：**11文件130项通过**，日志`final-specialized-tests.log`。包含实际Pi AgentSession的schema/部分读取失败/多片段写入、调用身份/预算/取消/恢复、真实Node/npm命令、进程归属、stdin/EOF、完整日志与脱敏反例。模型响应均受控，不是付费供应商认证。

`npm run typecheck`、`npm run build:main`通过，见`final-typecheck.log`、`final-build-main.log`。早先完整`check:offline`亦构建renderer/main/worker/preload/templates；未启动或重启用户常用Bloma实例。

#### 整套回归仍未收敛，不能改写成全部通过

1. `47be8a7`的原标准19文件206项曾完整通过：`final-check-offline.log`。这是早一代码版本，不代替最终全部回归。
2. `a291d8b`扩大为30文件336项的并行组合：335通过，CLI修复后交付夹具约91.7秒未达completed；该夹具内部90秒取消信号。原失败见`final-expanded-check-offline.log`。同断言单独执行约46.3秒通过，`verification-failure-retest.log`；不是将原组合追认为通过。
3. `ae64181`将交付夹具移到后续单worker后，前18文件199项仍有浏览器纠正夹具90秒超时，并出现其临时目录EBUSY清理失败：`final-isolated-check-offline.log`。同断言单独约34.6秒通过，`test-correction-failure-retest.log`。未确认生产死锁，也不据此免除失败。
4. `d6df5a0`单worker组合前18文件：198/199通过，音频正对照checkbox的实际PCM peak为0而失败，见`final-serial-check-offline.log`。本轮未修改音频产品/断言/门槛来追求PASS，后续组因&&短路未执行。

最后撤下未证明稳定且会拖慢全套的临时串行拆组策略，保留原标准19文件调度，新增独立`test:tooling:offline`入口，并将它接在`check:offline`末尾：原标准失败时不会跳过失败继续声称整套通过。最终该组合没有再全跑；专项130项、类型及main构建已经重跑通过。后续应先针对这些既有重型夹具的调度/等待/真实音频就绪取证，再处理GUI/Vide扩展。不得简单放宽生产时限、删断言或跳过失败。

### 4 保护与提交

- 原仓库HEAD仍09d8549、原用户dirty文档`production-workflow-v2-20261020.md` blob仍`53c7abb3aef8497d8b0522b8aab806c82b2ec164`，不覆盖、不纳入本批提交。
- 本次项目registry、quality、test-corrections、usage、run-state、execution-limits六文件重新取SHA256对照；`protected-state.before.json`和`protected-state.after.json`记录全部一致。最终再核对见`protected-state.final.json`。
- 未改原生成产品、未解除校园暂停、未清unknown/费用/质量账本、未真实模型付费、未发布、未fetch/push、未重启常用实例；未改Codex或Proma持久记忆/镜像/SYNC-MANIFEST。
- 代码批次已即时提交：fe06c6e基线、33d77f0查询读取、acd15c7批量编辑、0dbed74日志、47be8a7 Pi边界、a291d8b聚合限额与测试。ae64181/d6df5a0保留测试调度尝试历史；后续提交恢复标准入口并固化本交接。按git定位，不抹失败历史。

### 5 下一步与明确未完成项

| 批次 | 当前状态 |
| --- | --- |
| B0 | 首批文件/编辑受控基线已测；GUI/原生/恢复/真实模型对应基线未齐 |
| B1 | 搜索、读取、结果投影、归档首期已落地并有专项；更广平台压力/敏感格式/端到端收益未认证 |
| B2 | 调用身份、文本数值观测及有界只读批处理已落地；安全异步并发、同步/异步统一生命周期未完成 |
| B3 | 同文件批量及hash保护完成；多文件修改语义/恢复与真实模型格式对照未做 |
| B4 | G1 + Vide V1/V2 GUI语义/运行时/工具展示未实施 |
| B5 | Q1 + V3独立交互探索到原缺陷闭合未实施 |
| B6 | C1 + T4语义代码服务/上下文实验未实施 |
| B7 | G2 + O1通用原生Windows/故障证据扩展未实施 |
| B8 | E1 + V4/V5干净Windows/重连/完整隔离扩展未实施；远端仍另定范围 |

按executing-plans的分批审阅检查点保留现场；先取得整套回归的可信结果，再决定合并本批到sprint2和继续后续扩展。不能把本文当整份计划已完成或已上线证明。
