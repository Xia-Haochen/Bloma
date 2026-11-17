# UX-001：行动优先的对话显示修复

日期：2026-11-10；实施基线`sprint2 / cfb3a54`。用户15:50批准实施，并在16:21、16:39、16:40重申按方案完成。

## 已实现

- 面向零知识用户，对话区醒目内容先告诉用户做什么；只有真实动作时提供主按钮，正常工作明确“不用操作”。需求/界面确认优先于制作提示，确认、继续、设置和打开程序复用原入口，不解暂停、不加金额授权、不跳质量门。
- 复用`SoftwareStatusView`的execution/verification/goal；原交付IPC支持`status_only`只读提前返回，不列产品文件、检查release、运行验证或调用模型。历史PASS不升级为当前通过。内部限额已增加时读取当前原预算snapshot，只改变继续提示，不结算/清账或保证人民币准入。
- Pi每条assistant响应有稳定`public_message_id`，同条内累计delta，独立呈现边界结束该消息而非整个run。原公开审计保留同ID和起始时间；原Pi transcript保留协议/工具证据，公开流与公开历史采用相同DSML显示转换。原`message_completed`的流程含义、预算、伙伴回调不变。
- 渲染归约按条固化，终态只补存残留；历史与流以公开消息ID去重。识别停止run、较旧generation、重复事件，并保留终态后的合法确认卡。原无ID记录不推测拆分，不迁移改写。
- 取消首句抽取大标题和固定155px角色舞台；角色缩小，正常公开回复完整保留。新审计中带工具的公开正文仍独立显示，工具块留在原执行折叠组；不按HTTP/API等关键词删答复。
- 阅读历史时不被新token拉走，有“有新消息”入口；输入草稿、确认入口、详情Escape焦点、窄栏和减少动态效果继续可用。原错误不因制作方再次输出自动销失；行动区读取当前宿主事实，旧执行提示仍可展开核对。

## 验证与证据

工作台证据：`C:/Users/17359/.proma/agent-workspaces/default/ce1d0954-c07d-4052-b50c-f721e6a2d9fb/ux-repair/`。

- 完整`npm run check:offline`通过：类型、文档、renderer/main/preload/模板构建及19文件206项标准离线；日志`check-offline.log`。不是全仓test:all或真实供应商质量效果。
- UX定向最终组合10文件47项通过，包含实际全局listener、异步历史与快照、主动作防重复、完整正文、输入/队列/Markdown、现有theatre行为及审查P1反例，见`final-ux-regression.log`。P1修复定向2文件13项另见`review-fix.log`，不与重叠组合累计报总数。
- Pi传输实现定向4文件58项通过，含本地受控HTTP服务与真实Pi运行，见`transport/RESULT.md`；不是付费供应商或原产品续跑。
- 独立只读审查报告已落`review.md`，确认旧无key终态重放可吞掉新run尾部的P1。已保留跨run的有界事件去重并拒绝更早的无key执行事件，补同ID和不同ID的旧终态反例；真实Electron/IPC追加通过，见`native/late-event-verification.json`。审查会话随后因TPM限制中断，不能写成最终独立复审通过；本修复由父会话实测收口。
- 受管浏览器核验真实组件的行动/确认结构，截图两次超时；随后独立Chromium组件回放补充720px布局、确认和运行中无多余主按钮，见`browser/verification.json`及截图。该页使用mock IPC，不作原生认证。
- 本次构建的真实Bloma Electron App使用独立`PROMA_HOME`与user-data，实际preload/status IPC验证草稿、历史、详情关闭、280/360px键盘调整、两响应回放、模型自述不能覆盖宿主blocked、重载后原审计/状态读取，共12项，见`native/verification.json`。窄App实测viewport786px（受原生最小窗口限制），不是声称原生窗口已覆盖720px。
- Windows UIA实测独立窗口与输入草稿。Cua Driver未配置、镜像不可用；Python UIA鼠标命中受DPI影响，未绕过焦点校验；其它交互和截图由确切绑定该隔离实例的Playwright Electron/IPC完成。原生截图已经实际读取核验。
- P1修复后重新构建renderer并通过类型检查，见`final-renderer-build.log`、`final-typecheck.log`；真实重建renderer的迟到终态反例通过，不用修复前原生截图证明该逻辑。

## 保留边界

- 用户原有`production-workflow-v2-20261020.md`不编辑、不纳入提交，blob保持`53c7abb3aef8497d8b0522b8aab806c82b2ec164`。
- 原转介项目、quality、test-corrections、usage、run-state、execution-limits保持字节一致；收尾回执与原始摘要在工作台。校园暂停、unknown费用责任与金额授权不变。
- 没有恢复原任务/付费，没有代修生成产品、销案或发布；未push。隔离App验证完成后关闭，未重启用户原实例。
- 展示层处理不是全面凭据审计。原始受保护审计策略不放宽，不能以折叠详情宣称凭据已安全。
