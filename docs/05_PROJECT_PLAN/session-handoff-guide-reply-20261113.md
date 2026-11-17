# Bloma需求引导普通对话修复交接

日期：2026-11-13。工程起点sprint2/eb0cfcb；生产/测试验收点 **3ea5541f084c75be04c8e700d3da2427330ce928**。本批只修需求引导阶段的普通回复和UX回退引导的正文落盘，不扩展新Agent、分类调用或发布状态机。已快进合入主仓库sprint2（合入点ab14d18），并在主仓库执行node scripts/start.mjs --build-only --no-install退出0：更新main，复用经新鲜度核验的renderer/worker/semantic/preload/templates，未启动常用App。此后仅记录收尾，不改已验生产/测试代码。

## 根因与修复

真实Bloma会话9b909990-79de-4477-a7d3-fc4d49058494中，“你是谁”被送入只接受brief/clarify的任务单协议；用户纠正被编成未来功能/约束。最后两次真实模型各有360输出tokens，非空流；任务卡分支不持久化assistant正文、外层completed仅说明处理结束。原项目未开工/未交付，不用本批平台修复替其销案或续跑。

- `main/guide/lean-brief.ts`：在同一请求中增加经过非空字符串校验的reply结果；明确Bloma身份，区分直接问答/文本起草/对话纠正与明确的软件创建/修改。保留原brief/clarify契约，不把只要文字自动视作command软件。
- `main/guide/lean-guide.ts`：在原用户来源索引之外，提供最多20条公开user/assistant文字上下文与宿主阶段/确认状态；不传system/tool/image块。原预算包装、取消检查、一次调用及有界重试不变。reply通过原say路径持久化/发布，在范围写入/命名/自动确认/开工之前返回；不把暂停或待确认任务的UI阶段强制改回clarifying。
- 独立审查确认的P2：`ux-confirm.ts:returnToPrd`原先传入空persistAssistant；接回原appendSessionMessage。新增真实UX回退链测试，先复现可见正文存在但历史丢失，再修复通过。不新建正文账本。
- 原冻结合同/显式确认/UX/C/V/验证/发布及费用权威不变；不改模型、渠道、额度、unknown、暂停或原产品数据。

## 验证范围

| 本次执行 | 结果与边界 |
| --- | --- |
| 新回复边界测试，原代码 | 11项中7失败/4通过，保留red日志，未放宽断言 |
| 独立审查P2反例，修复前 | UX正文可见但loadConversationHistory无正文，原断言失败 |
| 最终组合 | **16文件107项通过**，含需求引导/确认恢复/UX、真实runAgent入口、合同与能力绑定、原会话读取、公开消息/renderer流；非全仓或608项重跑 |
| 类型/文档/构建 | typecheck、docs:check及完整renderer/main/worker/semantic/preload/templates构建通过；原Vite体积提示等非失败 |
| 实际隔离Electron | 当前构建、私有PROMA_HOME与user-data-dir；实际preload loadMessages拿到user/assistant；实际可见窗口显示介绍、重载仍显示、不出现制作范围确认卡；实例已退出 |

新增13项回复/公共入口测试及1项UX回退反例已纳入上述最终107项，不与早期63项等重复相加。普通回复、pending/dismissed/adjust状态原字节不变、无隐式开工、内部块隔离、坏reply重试、真实需求修改仍须确认均覆盖。

模型响应是受控SDK替身；实际窗口读取的历史来自原runAgent/真实guide的隔离执行，不是mock IPC页面或直接捏造renderer回复。为恢复该临时项目，测试数据仅补project→last_session_id索引指针并改临时展示名。没有真实供应商调用，不能宣称DeepSeek一定选择reply或效果/费用改善。

当前Proma会话无可用cua-driver CLI或computer-use.md配置；Codex此前可用CUA不代表本会话CLI可用。本次实际Electron以Playwright绑定独立实例验证，不冒称CUA键鼠验收。首次脚本误用编译入口导致app.getAppPath错误，后按正常仓库包入口启动；随后误点已隐藏标题的测试定位器，改为检查已恢复回复后通过；原失败证据保留，没有为此修改生产源码。

## 审查与仍有的边界

- 一名独立只读审查者未发现新增可复现P0/P1，确认UX回退正文不落盘P2后已复现并修复；同一审查者随后核对3ea5541接线与先红/最终通过日志，确认该P2闭合、未发现新的可复现P0/P1。独立复核未重跑测试，不作无缺陷保证。
- **草图卡“等待修改意见”状态仍会把下一条文字当作草图反馈。** 此入口在guide模型前消费输入，是原有行为；本批没有宣称该态支持任意插问，也未增加一轮分类/自动重画的解决方案。
- 既有“继续”重发任务卡、“确认”确认当前候选的明确快捷语义未改。不能把本次验证宣传成所有阶段完全自由对话。
- 新system需要真实模型验证意图区分效果；仅在用户给定新范围/预算并实时预检渠道/报价/余额/账本/完整预留后执行。干净机与全平台UI/实时生成体验不在本批认证范围。

## 证据与保护

会话证据根：`C:/Users/17359/.proma/agent-workspaces/default/07b74f04-62a5-457c-bf7c-f1a8263d547a/`。

- 根因：bloma-guide-diagnosis/report.md及test.log/observations.json。
- TDD：guide-repair-red.log、guide-repair-review-red.log。
- 最终：guide-repair-final-tests.log、guide-repair-final-typecheck.log、guide-repair-build.log。
- 实际App：guide-ui-fixture.test.ts/.log/.json、guide-app-smoke.cjs/.json/.log、guide-app-reply.png；脚本错误guide-app-wrong-entry.json、guide-app-fixture-locator-error.json。
- 原registry、Bloma索引、原会话、usage、确认、prd六文件SHA均与诊断前一致：guide-repair-protected.json。原用户dirty文档blob仍53c7abb3aef8497d8b0522b8aab806c82b2ec164，未覆盖或纳入提交。
- 代码3ea5541已提交并合入sprint2；主仓库构建新鲜度通过（guide-repair-main-build.log）。无push、无常用App重启、无原产品/付费恢复；不把主仓库构建成功当成用户旧实例已加载。
