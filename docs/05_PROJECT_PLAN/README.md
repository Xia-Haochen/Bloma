# 计划与实施索引

维护日期：2026-11-05。此目录同时存放计划、实施结果和历史试验；文件日期及“已完成”字样只说明各自记录的范围。当前代码决定实现状态，绑定版本的证据决定验证范围。

## 当前接手

1. [免费验收与检查入口清算](offline-clearance-20261105.md)：最近提交的免费修复、离线回归和真实涂鸦基线复查。
2. [验收会话交接](session-handoff-acceptance-20261105.md)：现有项目、预算边界、基线收尾与静音增量顺序。项目尚未正式交付，付费暂停。
3. [验收职责收敛](verification-architecture-refactor-20261105.md)：证据解释、精简反馈、宿主收尾的职责边界。
4. [质量协作交接](session-handoff-quality-20261030.md)：Q1–Q4已接线，顶部更新优先于旧正文。真实模型质量与效率收益另验。
5. [无干预测试规范](observation-only-testing-20261105.md)：只观察驾驶器已实现并离线验证，旧驾驶入口已停用；用户另授权10元的新样本仍未开始真实运行。此授权不恢复旧涂鸦窗口，外部执行拒绝不得绕过。

现役新项目流程为 `software-v1`：短任务单确认 → 按需外观确认 → 持续Pi制作与修复 → 宿主验证 → 快速型发布或长期里程碑确认后发布。旧PRD/裁判长链、lean-v1及冻结实验均不从历史文档自动恢复。

## 专题入口

| 主题 | 入口与使用范围 |
| --- | --- |
| 质量协作设计 | [生成质量方案](multi-agent-generation-quality-plan-20261030.md)，结合[Q1](quality-q1-implementation-20261030.md)、[Q2](quality-q2-implementation-20261030.md)、[Q3](quality-q3-implementation-20261030.md)、[Q4](quality-q4-implementation-20261030.md)实施记录 |
| 模板与能力 | [模板交接](session-handoff-templates-20261029.md)，区分本机工程、真实服务与干净系统验收 |
| UI | [UI交接](session-handoff-ui-20261101.md)、[雾面工作区结果](ui-matte-workspace-result-20261101.md)，用户评审状态不得从工程完成推定 |
| 历史退役 | [流程退役实施](workflow-retirement-implementation-20261027.md)、[后续清理](workflow-cleanup-20261028.md)，解释旧流程的去向 |
| 历史实验 | `dispatch-*`、`experiment-*`及费用记录保留审计价值；其中授权、参数和余额不是当前运行许可 |

## 仍有效的约束与未完成事项

本节合并旧计划的剩余事项，区分当前主线、条件具备后验收及历史未闭合记录。列入此表不等于本轮已验证，也不自动恢复历史任务或预算。

| 范围 | 保留内容与下一步 | 证据/承接入口 |
| --- | --- | --- |
| 当前涂鸦交付 | 先完成同一基线的必要C/V、独立验收与里程碑发布，再做静音增量；有声对照、静音保存重开已准备，播放中切换及开关持久化按确认范围补测。费用暂停。 | [当前验收交接](session-handoff-acceptance-20261105.md)、[免费清算](offline-clearance-20261105.md) |
| 历史稳健性实验 | 2026-10-11的原产物业务4/5、修复副本后5/5与自动交付0/6分别记录；两项中断、长期语音缺产物、用量不完整、不同构建及驾驶协议偏离均保留。不能当作现版本缺陷或成功率，也不因删计划销案。 | [案例结果与剩余工作](robustness-case-results-20261011.md)、[逐批执行及证据索引](robustness-execution-20261011.md) |
| 语音与环境 | 固定WAV、模型适配、历史采集人工接受、当前真实麦克风/ASR及干净机器安装是不同范围；缺哪层证据就保留哪层未验，不以文本模拟或缓存存在代替。 | [历史语音反例](voice-demo-failure-and-closed-loop-20261011.md)、[语音准备修复](speech-capability-permission-fix-20261101.md) |
| 软件专精四项能力 | 持续调试、增量及旧数据保护、独立环境交付、已有工程与长期恢复仍是能力目标，不增加四个必经阶段。旧跟进仍挂着源码Git提交/最小导出包、C1/C2独立环境、C3干净机执行器/重启、D4远端构建与冲突合并；应先核查后继交付是否覆盖，不直接宣称全部仍缺或已完成。旧3元样例的人工介入及安全拦截也保留。 | [实施](software-specialization-implementation-20261024.md)、[跟进与未完成项](software-specialization-followup-20261024.md) |
| 模板验收 | B0–B8本机工程、T01设置及B9工具已有结果；真实账号/模型效果、具体供应商适配、干净系统安装与真实效率对照仍另验。C1/C2/C3的独立场景与各模板反例移入交付记录；后置OAuth、公网Webhook、视频/TTS/实时采集、更多OS/协议不自动开工。 | [模板交接](session-handoff-templates-20261029.md)、[交付与保留契约](template-rollout-result-20261029.md)、[审计](template-audit-20261029.md) |
| 复杂任务与开放愿望 | 项目活动、Task/Assignment、阶段检查、B分批与透明界面已有离线实现；真实愿望理解、变更恢复、用户干预及成本收益须独立验证。H2常驻协调者、H4模型看门狗仍需具体问题触发；保留单一业务权威、累计回归、幂等、暂停与预算边界。 | [实施及保留的v4边界](complex-wish-implementation-20261103.md)、[v5设计](personal-wish-architecture-v5-20261104.md) |
| 测试样本与体验 | 开发样本已暴露，不能称独立保留集；录像、真实增量和体验评价按各自证据继续挂账。UI用户决定、素材/原型及视觉评审不由构建通过替代。 | [个性化测试协议](personal-wish-test-plan-20261104.md)、[真实试验](personal-wish-trial-20261104.md)、[UI交接](session-handoff-ui-20261101.md) |
| 工程治理与效果 | 本地离线检查已通过，远端CI运行及必需合并检查未验证；真实模型效率和修复收尾成本不能由可控模型回归推断。 | [免费清算](offline-clearance-20261105.md)、[职责收敛](verification-architecture-refactor-20261105.md) |

研究/预登记中的独立样本、计量协议与费用责任继续保留；v5、质量协作方案和个性化测试协议仍有独立设计价值。本索引不把待选架构变成默认实施路线。

## 清理记录

以下四份重复或已被替代的计划从当前目录删除，结果文档和原始运行证据保留。原文可从清理前提交 `9206d26` 读取：`git show 9206d26:docs/05_PROJECT_PLAN/<文件名>`。

| 已删除的旧文件 | 保留的后继记录 |
| --- | --- |
| `agent-feedback-improvement-plan-20261012.md` | [工具反馈执行记录](agent-feedback-execution-20261012.md)，已包含实施批次及未验证边界 |
| `harness-improvement-plan-20261027.md` | [Harness实施记录](harness-improvement-progress-20261027.md)，补存原计划独有的批次0结果；[对照工具记录](harness-evaluation-20261027.md)继续保留真实对照未执行的限制 |
| `workflow-reduction-plan-20261023.md` | [流程缩减实施记录](workflow-reduction-implementation-20261023.md)，仅解释历史lean-v1阶段；现役流程见上方 |
| `ui-proposal-v2-20261010.md` | [软件剧场实施记录](ui-theatre-implementation-20261010.md)，后续UI以当前专题入口为准 |

第二批清理前版本为 `6e1a8b5`，以下计划的未完成事项已汇总到上表，独有契约/证据归入对应后继记录；原文可用同样的 `git show` 方法读取。

| 已删除的旧文件 | 内容去向 |
| --- | --- |
| `robustness-completion-plan-20261011.md` | [执行记录](robustness-execution-20261011.md)新增原批次证据表，[结果记录](robustness-case-results-20261011.md)保留失败、未完成和用量口径 |
| `software-specialization-four-priorities-20261024.md` | [实施](software-specialization-implementation-20261024.md)、[跟进](software-specialization-followup-20261024.md)和上表保留四项能力目标、未完成项及历史真实试验限制 |
| `product-template-roadmap-20261029.md` | [交付记录](template-rollout-result-20261029.md)保留T01–T08范围/反例、共用组件契约及C1–C3组合场景；模板交接删除过时的B0/B1开工指令 |
| `complex-wish-generation-plan-20261101.md` | [实施记录](complex-wish-implementation-20261103.md)保留v4架构边界、H1–H4选择和历史探查口径，[v5](personal-wish-architecture-v5-20261104.md)仍保留为后继设计 |

较新UI方案中的用户决定、研究方案、测试结果和账本未按日期批量删除。用户尚未提交的 `production-workflow-v2-20261020.md` 修改保持原样。

后续计划完成后优先把结果与未完成边界收敛到实施记录；确有独立决策价值的设计保留，重复的待实施清单可以删除并更新引用。历史失败、费用和未验证项不能因清理文档而消失。
