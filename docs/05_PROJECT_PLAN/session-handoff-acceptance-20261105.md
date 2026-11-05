# 会话交接：跑通现有项目的测试与交付验收

日期：2026-11-05（Asia/Shanghai）。本文件是本任务最新接手入口；旧临时交接和旧质量文档中的项目状态、预算与关机安排不能直接执行。

后续免费清算见[免费验收与检查入口清算](offline-clearance-20261105.md)：静音适配器已补有效音频对照及静音保存/重开路径，支持checkbox、switch和切换按钮；需成对配置静音控件与确认范围内的发声操作。下文关于旧适配器只支持checkbox、解除后才保存的描述为修复前限制。新增本地/Windows CI共用离线检查入口，远端工作流和分支保护尚未验证。真实静音增量、最新C/V与正式交付仍未完成，付费继续暂停。

## 1. 下一会话的目标与边界

**先完成当前涂鸦基线的最新C/V、独立验收和正式交付，再做原定静音增量并验证旧功能、旧数据与重开。不要另换样例，也不要重新从零生成来替代当前未完成结果。**

- 先看[本次源码复查](acceptance-source-audit-20261105.md)，核对代码与证据，再固定平台版本进行复测。
- **关机已被用户明确取消。不要执行关机、定时关机或沿用睡前授权。**
- 当前无新增费用授权，付费保持暂停。下一轮先给出完整验收链的费用安排，取得一个明确总上限；不要按每个失败再次申请小额追加。
- 用户原有`docs/05_PROJECT_PLAN/production-workflow-v2-20261020.md`两行修改保留，不纳入本批提交。保护值`53c7abb3aef8497d8b0522b8aab806c82b2ec164`。
- 不push，不改Proma/旧副本，不写回持久记忆。无需新建工作树或新聊天即可接手现有checkout。
- 用户希望查清每个失败的根因；明确同因时立即停下来诊断，三次自动停止不是允许盲试三次。

## 2. 当前工程与试验快照

| 项目 | 当前值 |
| --- | --- |
| 仓库 | `C:/Users/17359/OneDrive/Desktop/guide-agent-platform-sprint0` |
| 分支 | `sprint2` |
| 本次源码修复基线 | `eca26cc`；随后还有交接文档提交，先用git log核对实际HEAD |
| 上轮收尾修复 | `48b81a4`（手动C/V进入宿主收尾、仅处理本次等待交接） |
| 本次新增修复 | 宿主自动检查失败接入三次停止守卫；试验摘要检查单条复验；新窗口价格证据分开保存 |
| 试验根 | `C:/Users/17359/.bloma-validation/wish-retest-20261104-10rmb` |
| 项目 | `8a44a8ae-f228-4f45-a0be-6819d9173251` |
| 制作会话 | `complex-interaction-doodle` |
| 当前操作 | `bb720e4d-31dc-4721-a160-650ba3a71240`；续跑前从projects.json再次核对 |
| 应用源码指纹 | `55f641cc30ba07e8124c049885ec94720fd43b64efe3a417507b676246d2592d` |
| 当前项目状态 | active / generating_mvp，desktop_blocked=verification-incomplete；没有正式交付 |
| 正式测试入口 | `tests/full-entry4.mjs`，13案例，restart=true |
| 禁止替换入口 | 不用`full-entry5.mjs`、`direction2*`等未获准替换入口丢弃原案例 |
| 最新独立通过报告 | `interaction-doodle/independent/actual-7ae99f5e-1e4b-4e46-a6a7-0d291cb6fcd1.json` |
| 正常数据快照 | 同目录同前缀`-data.json`；增量前应在最终基线确认后重新核对/保存基准 |
| 暂停标记 | 试验根`pause-generation`仍存在 |

应用根路径以`interaction-doodle/project.json`为准，当前在试验home的`agent-workspaces/default-software-builder/generated-projects/<project_id>`。不要误用旧的`personal-wish-20261104-10rmb`项目。

冻结需求文件：试验根`trial-cases.json`。

> 基线：我想把鼠标涂鸦变成一个小乐器：线条速度影响节奏，颜色影响音色。我自己改对应关系，回放旧画时要能选择用旧规则还是新规则。先用几种简单合成音就好。
>
> 增量：增加静音画画模式；静音期间画的东西以后仍可以回放。

## 3. 已通过什么，还缺什么

已观察到的产品结果：13个正式案例与完整进程重开通过；独立真实鼠标、数字音频、旧/新规则、单笔速度、持久化和重开，以及规则/音色缺失、保存并发、映射编辑在途、加载失败、损坏数据保护通过。

这些是绑定此前具体候选与环境的证据。**最新C/V未完成、基线里程碑未确认、没有正式发布，静音增量尚未提交。** 本次改了宿主实现，也会使旧缓存凭据不再满足当前验证键；不要修改请求ID或时间戳让旧PASS“变新”。

本次离线控制流回归：核心8文件106项、报表2项、视觉生产链2项通过，详见源码复查文档。模型响应为本地可控SDK/HTTP fixture，不是付费真实模型验收。

## 4. 费用和参数必须先处理

- 当前窗口10元，保守计价8.2678元，余1.7322元，未结算0；357次实际发送、364条编号记录、415条完整公开工具回执。
- 当前完整输入预留2.097152元，余款不足；渠道显示有余额不等于这个窗口可发请求。
- 上轮最后第362条实际发送：off模式、310681非缓存输入、24输出、缓存0，保守费用0.621554元。第363/364条未发送。不能断言模式切换是缓存未命中的唯一原因，也不能把off当作已验证的省费策略。
- `BLOMA_COMPLEX_TRIAL_THINKING`默认low，显式off才改变模式；不要静默继承旧临时环境变量或中途切换参数。新一轮与预算一起确定并记录模式。
- 新预算窗口的现有机制是`BLOMA_COMPLEX_TRIAL_WINDOW`、`BLOMA_COMPLEX_TRIAL_AUTHORIZED_CAP`与`BLOMA_COMPLEX_TRIAL_AUTHORIZATION_TEXT`。只有取得真实的新授权后才设置；不得把旧“新增10元”文字冒充新授权。
- 新窗口沿用原试验根/项目，生成独立manifest、policy及epoch；旧policy/state/账本保持原样。新的价格页面保存为带窗口后缀的文件。先审查预检结果，再允许生成；不要覆盖原manifest。
- 价格页面关键字检查不能证明某个模型与某组数字的对应关系。独立核对当前模型对应的官方报价并保留来源；不为让预检通过而盲改匹配字符串或沿用不明费率。
- 对恢复长Pi会话按冷缓存安排余量，包含基线C/V、增量、复验、修复与重试。换Codex聊天不等于平台的制作上下文已清空。

## 5. 下一轮实施顺序

### A. 接手与免费检查

1. 核对git状态、最新提交、用户保护文件；确认没有另一个试验实例占用同一4318端口，保持测试环境独立。
2. 读取`report/REPORT.md`、`report/final-state.json`、`report/summary.json`和`observer-log.md`。读取质量/长期状态台账，核对当前源指纹、pending裁定与里程碑。
3. 运行相关离线检查；若本次交接后又改了源码，只补受影响检查，不把反复跑同一批绿测当新证据。
4. 必要时免费重跑当前正式13案例与独立基线；这些会写新的本地验证凭据并操作隔离数据，不是纯只读操作，也不是供应商模型验收。

免费宿主复验命令（不删除暂停标记）：

```powershell
$trialRoot = 'C:\Users\17359\.bloma-validation\wish-retest-20261104-10rmb'
$env:BLOMA_COMPLEX_TRIAL_ROOT = $trialRoot
$env:BLOMA_COMPLEX_TRIAL_CASES = "$trialRoot\trial-cases.json"
$env:BLOMA_COMPLEX_TRIAL_TASK = 'interaction-doodle'
$env:BLOMA_COMPLEX_TRIAL_PHASE = 'verify-current'
$env:BLOMA_TRIAL_VERIFY_SCRIPT = 'tests/full-entry4.mjs'
$env:BLOMA_TRIAL_VERIFY_RESTART = '1'
Remove-Item Env:BLOMA_TRIAL_FINDINGS_FILE -ErrorAction SilentlyContinue
node scripts/software-complex-trial.mjs
```

独立检查改为phase=`inspect`并设置`BLOMA_TRIAL_UI_ADAPTER=retest-doodle`。它会实际绘制/保存到本试验的正常数据目录，故障分支使用副本；每次都保留报告与数据快照。脚本也可能查询渠道余额，但不发生成请求。

### B. 取得新费用授权后，完成基线

1. 完成新窗口预检，固定模型/渠道/thinking设置、平台提交与测试输入；检查原账本hash和未结算责任。
2. 在没有活动生成时构建试验runtime。只有预检成功且授权明确后才能移除`pause-generation`。不要在正在运行的试验中重建同一runner文件。
3. 用phase=`resume`，目标是当前候选的必要审阅与交付收尾。不要发“重新全面优化”或“清空所有意见”之类扩大任务的指令。
4. 手动或宿主发起C/V都应进入同一收尾路径。已完整提交的审阅交接不再交回制作方自由改动；真实重要疑点仍实际复现/同案复测。
5. 若失败，先对照确认预期、冻结原文、对象身份、实际输入、运行环境和原始回执。错误预期走独立裁定通路，不直接手改产品迎合测试，也不清空记录。
6. 到达当前源码对应的`awaiting_confirmation`后，对待确认候选做独立实际验收，核对数据与源码/环境绑定，然后用phase=`confirm`调用真实长期项目确认入口。
7. 只有`projects.json`满足`status=completed`、`current_stage=completed`、`desktop_phase=delivered`，当前里程碑delivered且active release有效，才算基线正式交付。不能仅看某条自然语言“完成”。

### C. 静音增量

1. 基线交付后保存当前正常数据快照。用phase=`change`提交冻结的普通用户增量，不夹带技术栈、测试锚点或内部工具名。
2. 核对新scope保留F-001～F-006，并明确静音控制影响的声音、切换期间的行为和后续回放语义。若有新界面确认，实际观察后再通过正常确认入口。
3. 生成后按真实UI适配独立验收。现有`BLOMA_TRIAL_MUTE_SELECTOR`假定checkbox，不能让产品为适配器改成checkbox。
4. **基线画画本来不自动发声。仅“静音画画时无声”不能证明新增功能有效。** 按确认范围建立有效的有声→静音→解除/后续回放对照，检查静音期间笔画仍记录、在静音状态下保存、关闭重开后回放；按已承诺范围检查正在播放时切换及开关持久化。现有适配器先解除静音再保存，需要补这条保存路径。
5. 使用`BLOMA_TRIAL_BASELINE_DATA`核对旧画、笔画、原版本引用和旧映射保留。完整旧测试、独立原功能、数据与重开都要通过，再完成新候选C/V和第二次实际确认。

### D. 每个阶段的停点与最终证据

- 宿主自动检查与模型显式检查现在都按结构化原因/指纹停止同因循环。新失败仍须分析，不能等到额度用完才解释。
- 费用守卫、价格/路由不明、未结算责任、证据损坏或来源不一致时停付费；离线诊断可以继续。不要为了交付降低门、调整账本或隐藏参数变化。
- 基线交付与静音交付各保存：确认scope、源码/候选身份、正式报告、C/V台账、独立GUI/音频/数据与重开证据、真实发布状态、账本与逐请求对账。
- 若任何一步仍未完成，明确标注具体缺口。当前已有357次发送不能用来证明自主收敛效率，下一轮也不能因“调用更少”就忽略验收范围差异。

## 6. 关键源码导航

| 模块 | 接手时关注点 |
| --- | --- |
| `main/desktop/lean-production.ts` | `afterTools`、`advanceCloseout`、最终验证与发布；手动入口与自动入口一致 |
| `main/desktop/production-completion.ts` | 仅等待当前项目活动协作；消费有效C/V交接，不重放全历史 |
| `main/agent/loop/pi-runtime.ts`、`work-progress.ts` | 普通工具与宿主检查的同因守卫；真实通过才重置；用户插话不被收尾吞掉 |
| `main/software/quality-review.ts`、`quality-closeout.ts` | 候选身份、角色字段、finding_indices、实际缺陷闭合及未验证核心体验 |
| `main/software/test-corrections.ts` | 读取冻结契约、独立裁定、精确应用、来源/字节/hash与修订链 |
| `main/software/verification.ts`、`longterm-control.ts` | 当前凭据与确认版本绑定、封存/发布和失败恢复 |
| `main/platform/llm/monetary-budget.ts`、`request-budget.ts` | 费用责任、输出适配、已知未发送与未知用量区分 |
| `scripts/software-complex-trial.ts`、`trial-status.ts` | 阶段运行、预算窗口、每条复验对摘要的影响 |
| `scripts/personal-doodle-retest-acceptance.ts` | 真实GUI/音频与数据回归；补全静音语义对照 |

## 7. 记录与重跑检查入口

相对试验根：

- `report/REPORT.md`、`report/requests.md`、`report/requests/00362.md`：最终报告、逐请求明细和最后一笔实际发送。
- `report/operation-accounting-reconciliation.json`：旧操作摘要的未发送预留更正，未改全局账本。
- `trace/requests/`、`trace/events.jsonl`、`observer-log.md`：完整观察记录与独立干预。实际发送已核对全部357条，部分宿主前置拒绝只存在事件记录。
- `home/software-quality/<project_id>.json`、`home/software-longterm/`、`home/software-verification/<project_id>.json`：质量、里程碑与最近验证。按实际结构读取，不猜文件名。
- `oracle-recheck/`：独立证据和精确裁定；原失败不回写成成功。

仓库内本次验证：`run-artifacts/handoff-acceptance-20261105/`中的`tests.log`、`visual.log`、`verification-snapshot.json`。构建产物不代表正在运行的Bloma已加载最新版本。

```powershell
npm run typecheck
npx vitest run tests/unit/pi-runtime.test.ts tests/unit/software/quality-review.test.ts tests/unit/desktop/dispatcher-completion.test.ts tests/unit/software/quality-closeout.test.ts tests/unit/software/test-corrections.test.ts tests/unit/software/longterm.test.ts tests/unit/request-budget.test.ts tests/unit/monetary-budget.test.ts tests/unit/trial-status.test.ts --maxWorkers=2 --minWorkers=1
npm run build:main
npm run docs:check
```

不必重读整段旧对话。先按本文件核对现场；遇到具体问题再查相应请求、原始报告与源码。
