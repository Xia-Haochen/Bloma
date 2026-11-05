# 计划与实施索引

维护日期：2026-11-05。此目录同时存放计划、实施结果和历史试验；文件日期及“已完成”字样只说明各自记录的范围。当前代码决定实现状态，绑定版本的证据决定验证范围。

## 当前接手

1. [免费验收与检查入口清算](offline-clearance-20261105.md)：最近提交的免费修复、离线回归和真实涂鸦基线复查。
2. [验收会话交接](session-handoff-acceptance-20261105.md)：现有项目、预算边界、基线收尾与静音增量顺序。项目尚未正式交付，付费暂停。
3. [验收职责收敛](verification-architecture-refactor-20261105.md)：证据解释、精简反馈、宿主收尾的职责边界。
4. [质量协作交接](session-handoff-quality-20261030.md)：Q1–Q4已接线，顶部更新优先于旧正文。真实模型质量与效率收益另验。

现役新项目流程为 `software-v1`：短任务单确认 → 按需外观确认 → 持续Pi制作与修复 → 宿主验证 → 快速型发布或长期里程碑确认后发布。旧PRD/裁判长链、lean-v1及冻结实验均不从历史文档自动恢复。

## 专题入口

| 主题 | 入口与使用范围 |
| --- | --- |
| 质量协作设计 | [生成质量方案](multi-agent-generation-quality-plan-20261030.md)，结合[Q1](quality-q1-implementation-20261030.md)、[Q2](quality-q2-implementation-20261030.md)、[Q3](quality-q3-implementation-20261030.md)、[Q4](quality-q4-implementation-20261030.md)实施记录 |
| 模板与能力 | [模板交接](session-handoff-templates-20261029.md)，区分本机工程、真实服务与干净系统验收 |
| UI | [UI交接](session-handoff-ui-20261101.md)、[雾面工作区结果](ui-matte-workspace-result-20261101.md)，用户评审状态不得从工程完成推定 |
| 历史退役 | [流程退役实施](workflow-retirement-implementation-20261027.md)、[后续清理](workflow-cleanup-20261028.md)，解释旧流程的去向 |
| 历史实验 | `dispatch-*`、`experiment-*`及费用记录保留审计价值；其中授权、参数和余额不是当前运行许可 |

## 本次清理

以下四份重复或已被替代的计划从当前目录删除，结果文档和原始运行证据保留。原文可从清理前提交 `9206d26` 读取：`git show 9206d26:docs/05_PROJECT_PLAN/<文件名>`。

| 已删除的旧文件 | 保留的后继记录 |
| --- | --- |
| `agent-feedback-improvement-plan-20261012.md` | [工具反馈执行记录](agent-feedback-execution-20261012.md)，已包含实施批次及未验证边界 |
| `harness-improvement-plan-20261027.md` | [Harness实施记录](harness-improvement-progress-20261027.md)，补存原计划独有的批次0结果；[对照工具记录](harness-evaluation-20261027.md)继续保留真实对照未执行的限制 |
| `workflow-reduction-plan-20261023.md` | [流程缩减实施记录](workflow-reduction-implementation-20261023.md)，仅解释历史lean-v1阶段；现役流程见上方 |
| `ui-proposal-v2-20261010.md` | [软件剧场实施记录](ui-theatre-implementation-20261010.md)，后续UI以当前专题入口为准 |

稳健性计划中的未完成验收、较新UI方案中的用户决定、研究方案、测试结果和账本未按日期批量删除。用户尚未提交的 `production-workflow-v2-20261020.md` 修改保持原样。

后续计划完成后优先把结果与未完成边界收敛到实施记录；确有独立决策价值的设计保留，重复的待实施清单可以删除并更新引用。历史失败、费用和未验证项不能因清理文档而消失。
