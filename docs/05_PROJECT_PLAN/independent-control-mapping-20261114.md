# 语伴 B 控件映射补齐与复验

日期：2026-11-14。接续统一实测入口首批。项目 `9a419eea-12e2-45e3-8c8d-6c3fb20c0012`，生成工程提交 `aca3d1c`。

## 变更

仅在生成工程新增 `INDEPENDENT_ADAPTER.json`，绑定原冻结设计 `e8a57cfeb4284af172b1dda5f95c30da3b57d9d42a0c10b9480357f43979b738`。没有修改产品实现、冻结输入、断言、覆盖声明或用户需求。

| B 逻辑控件 | 实际产品控件 |
| --- | --- |
| say | `#say` |
| send | `#btn-send` |
| reply / reply_text | `#chat > .msg.ai[data-id]:not(.voice-failed) .bubble` |
| voice_bar | `#chat > .msg.ai[data-id]:not(.voice-failed) .voice-bar` |
| role_card | `#role-card` |

产品的“正在想怎么回应”占位气泡没有 data-id；模型配置错误和语音失败使用 voice-failed。不能把这些气泡和报错文字映射成成功业务回复。reply 与 reply_text 在该产品中是同一个文字气泡，映射如实反映这个事实，不伪造第二份输出。

## 正式 B 实际执行

候选 `34a26e313c566dd4be3c7f40e7c854b495304296191438f67a9fad6e03920d5c`。所有冻结 GUI 案例先通过宿主 independentSuite 的映射结构、设计摘要与控件覆盖校验，再由 verifyIndependentDesign 启动实际 Electron 产品，每个案例使用新的隔离数据目录。

- F-001：固定三种形状音频、实际 ASR 解码通过。
- F-002：输入与发送执行成功，实际业务回复非空断言失败。
- F-003：输入与发送执行成功，实际业务回复非空断言失败。
- F-004：输入、发送及角色卡读取成功，实际业务回复非空断言失败。

原 `INDEPENDENT_ADAPTER_REQUIRED` 已消除。新的正式 B 结果为 failed，原样保留，没有覆盖为通过。失败截图明确显示“请在产品设置中配置 AI 服务和 Key”。B 的隔离数据目录没有对话模型配置，因此尚未产生有效模型回复。这是测试前置环境未准备造成的行为失败，不能直接据此判定产品对话实现有缺陷；目前宿主按非空断言失败记录为 product_assertion，此分类的限度在此保留说明。

首轮完整报告：`C:/Users/17359/.proma/software-independent-evidence/9a419eea-12e2-45e3-8c8d-6c3fb20c0012/f0eaf969-74c2-466f-94eb-12f207d6d438/report.json`。最后还将新候选交给正式 verifySoftwareCandidate 写回聚合报告，见本机 `run-artifacts/assisted-live/b-candidate-final.log`。

聚合复验实际结果：GUI passed、B failed（1 项通过 / 3 项未通过）、core unverified（新候选尚无麦克风记录）、overall failed。已写回 `software-verification/<project>.json`，没有以旧候选结果冒充当前结果。

## 控件诊断验证

为区分映射错误和模型配置缺失，另行在三个全新实例中，通过产品真实设置界面接入本机回环受控服务，再执行同一冻结案例步骤。

三个案例均通过控件诊断；每次真实请求都携带用户输入和包含“林知夏”的角色 system 内容。产品实际显示受控回复并进入 playing 音频状态。F-003 仍执行冻结的 observed 比较，没有改写预期。

这个结果只证明控件映射及配置后的本机请求/显示/朗读链路可用，不代表正式 B 已通过，也不代表真实模型效果、听感或角色表现已验收。诊断结果保存在 `run-artifacts/assisted-live/b-controls-diagnostic.json`，其 scope 明确标记为 controlled_service_mapping_diagnostic_not_formal_B_or_model_quality。

没有发起付费模型调用，没有复制用户密钥到隔离目录，没有放宽断言让错误气泡通过。

## 后续前置条件与范围

本次还收敛 assisted-acceptance 的可操作入口判断：前端投影和制作恢复复用同一条件，B 有实际失败时不提供麦克风开始操作，优先回到工程处理。回归 2 文件 / 9 项通过，类型检查、构建与文档检查通过；不增加新状态或让用户重复确认。

正式 B 后续需要受控、可复现的模型服务配置准备机制，独立于控件映射；既不能每次把已有配置清空后直接发送，也不能暗中复用用户数据或凭据。受控服务验证与真实供应商效果验收须分别标明范围。新的付费调用仍沿原预算与渠道授权。

本轮新增映射产生新候选。旧麦克风人工核对记录仍绑定旧候选保留；没有人为改签为新候选的实测证据。若希望仅改验收适配文件时复用未变化的语音组件证据，应另行完善依赖级有效性规则，不能直接绕过现有候选指纹。

当前冻结 B 的范围也存在限制：voice_bar 非空不能独自证明实际播放；reply 和 reply_text 映射到同一显示节点，其相等比较不能独自证明朗读内容一致；角色卡非空不能独自证明模型始终遵守人设。这些限制不在本次控件映射中偷偷增加或删改断言解决。
