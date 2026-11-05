# 测试与验收复查及实际复现（2026-11-05）

起点：`73bad85`。读取项目记忆后，以当前 software-v1 源码和当日验收交接为准。复查测试登记/冻结、原生执行与报告、CLI 入口、验收缓存、质量缺陷收尾、正式预期纠正和长期项目确认。没有新增供应商模型请求，没有恢复暂停的付费试验。

## 实际复现与修复

### P1：重开分支未执行业务检查仍可通过验收

在隔离 PROMA_HOME 中创建浏览器样例，经真实 `registerNativeGuiTests → verifySoftwareCandidate` 启动应用。initial 分支保存姓名并检查空输入，reopened 分支直接 return。宿主确实关闭重开应用，但汇总仅累计跨阶段的覆盖和断言，旧实现返回 passed。

- 修复前：新增回归期望 unverified，实际 passed，见 `run-artifacts/acceptance-recheck-20261105/repro-restart.log`。
- 修复后：要求报告数量符合是否重开，且每个阶段至少实际通过一个带断言的已登记业务案例；缺失时返回 `GUI_NATIVE_PHASE_INCOMPLETE`，不签发可复用的 PASS。
- 不要求所有案例在两个阶段重复执行，允许分别编写创建与重开案例。另修复同名案例跨阶段汇总：正常 skip 不覆盖另一阶段的 passed，真实失败和未验证仍保留优先级。
- 范围：保证每阶段确实执行案例，不自动证明断言足以覆盖全部持久化语义。

### P2：断言文本包含 cancelled 被误判为测试取消

真实浏览器保存 cancelled，再断言应为 saved，实际产生断言失败。旧实现对整个错误文本匹配 cancelled，导致结果从 failed 降为 unverified，丢失确定的失败分类。

- 修复前：新增回归期望 failed，实际 unverified，见 `run-artifacts/acceptance-recheck-20261105/repro-assertion.log`。
- 修复后：宿主 Node reporter 传递结构化 failureType，汇总按真实取消/超时类型判断；旧记录只保留狭窄的父测试取消文本兼容。业务值中的 cancelled 不再影响分类。
- 实际复验同时断言总状态 failed、failure_kind=assertion、对应案例 failed；父级取消和超时仍为 unverified。

## 源码审查及回归范围

- 测试登记与冻结：原始输入、预期、共享 helper 和实际依赖受冻结契约约束；定位与有界等待适配仍走原有规则。
- 验收凭据：验证键绑定源码、需求、规则、环境和宿主实现，当前实现改变后旧缓存不能直接复用。
- 质量与确认：确定失败进入缺陷闭合；正式预期修订须经独立裁定；长期确认校验 revision、会话、scope 与候选，再执行当前验证后发布。相关回归实际执行，未发现本批需要修改的另一条发布路径。
- CLI 检查：仍运行实际声明入口，对照固定参数、输出与退出状态；登记不是通过证据。

## 本次验证

- 原生验收/冻结输入/报告：3 文件 39 项通过，`native-regression.log`。包含真实浏览器、关闭重开、真实 Electron 正常窗口启动、错误断言、运行异常和跳过案例。
- 验证与交付相关：9 文件 59 项通过，`verification-regression.log`。包含 verification、verification-tool、quality-closeout、test-corrections、longterm、acceptance-evidence、lean-checks、core-verification-cache、trial-status。
- 上述不重叠套件共 12 文件 98 项；最终报告反馈 10 项复跑见 `feedback-final.log`，不重复计入总数。
- TypeScript 检查、主进程构建、docs:check、git diff --check 通过。日志位于 `run-artifacts/acceptance-recheck-20261105/`。

本批证明的是宿主测试与验收机制的实际运行修复，不是全仓所有测试通过，也不是供应商模型生成效果或现有涂鸦项目正式交付。静音增量、真实模型 C/V 和原试验完成状态仍按原交接保留待验；未修改旧账本、暂停标记或用户已有计划文档。
