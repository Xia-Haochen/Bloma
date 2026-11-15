# 复杂软件评测包

三项任务统一使用 Windows 桌面交付。评分为业务60、恢复20、持续性10、可用性10，全部 mandatory 项通过才完整完成。每次试验90分钟、制作成本上限10元；实际使用额度由负责人安排。

## 组员开始前

1. 使用包内 tasks.json、inputs 和对应任务书。核对 MANIFEST.json，运行 node tools/bench.mjs verify-pack。
2. 全组在包外填写同一份 study.json，统一模型标识、模型版本、推理档位、上下文与输出上限，以及子 Agent 可用模型。填写机器、OS、运行时、权限和预装组件。init会复制空模板到结果目录，开跑前用统一已填写的版本替换。模型无法锁定的产品另列 P 赛道。
3. 每个任务使用新的 Agent 会话、空项目和空数据目录。只把 participant 内该任务的任务书与 inputs 给 Agent。tools、evaluator、calibration、results 放在被测工作区外。
4. 录屏覆盖需求提交、必要确认、关键故障和最终交付。同步保存完整会话导出、工具记录、调用用量及时间线。
5. 原样发送任务书。允许固定确认、配置凭据、读标准句子。所有额外提示、代改文件、人工排障都记录到 interventions.json。

## 一次运行

```powershell
node tools/bench.mjs init equipment-lending results/run-001
# 填写 results/run-001/study.json 和 trial.json 中元数据
node tools/bench.mjs event results/run-001 start "已提交任务原文"
# 按 participant/clarifications.md 回答正常确认
node tools/bench.mjs event results/run-001 stop "已交付或到达限制"
node tools/bench.mjs snapshot C:/path/to/product results/run-001/artifact-manifest.json
```

计时从首次提交需求开始，包含安装、思考、调试、内部审阅和重试。预登记的人工设备参与可以暂停计时，填写起止及原因。通用 Agent 自己更换策略属于同次尝试；人工换模型、改代码或另开救援会话必须记录。截止后保留当时全部产物，后续修改另建试验。

费用计入主 Agent、子 Agent、内部评审和调试服务的全部制作调用。外部验收费用单列。费用缺失填写 null，不能用套餐价格零元替代用量。90分钟/10元是比较条件，平台还应使用实际金额保护。

## 外部验收

冻结产物后由另一位组员按 evaluator 对应任务脚本操作，执行所有检查项。UI选择器和内部存储格式由产品决定，验收使用用户操作、导出文件、服务请求和重启事实。人工检查项需录屏时间段或截图，语音及语义判断由两位评判者填写同一表格，有分歧标 unverified。

```powershell
node tools/controlled-service.mjs results/run-001/service
# 读取输出的 base_url，在成品正常设置界面配置
node tools/bench.mjs grade-equipment results/run-001/equipment-facts.json
node tools/bench.mjs grade-documents results/run-001/document-facts.json
# 填写 checks.json 的实际结果、证据路径与评判者，不确定项保留 unverified
node tools/bench.mjs finalize results/run-001
```

controlled-service 的鉴权值为公开测试值 benchmark-test-key，模型名为 benchmark-model。真实服务凭据由负责人通过安全渠道提供，避免出现在任务书、录屏和交付包中。

## 每次必须交回的资料

- study.json 与机器环境说明。
- 原始完整对话导出、工具调用记录、开始结束时间、暂停区间。
- 主模型及子 Agent 的模型/推理配置、token 用量与可核实费用。
- 截止时产品源码、启动说明、依赖锁文件、可运行包及 artifact-manifest.json。
- interventions.json，包含正常参与与额外技术帮助。
- checks.json、trial.json、score.json。
- 录屏、截图、真实服务回复、受控服务日志、导出数据及数据重启前后观察。
- 问题说明，写清超时、失败、中止、设施故障及未验证项。

提交目录以 system-task-seed-run 命名。全部计划尝试均提交。遇到测试器问题先保存记录并告知负责人，所有对照组使用同一修订后版本重新评估。

## 冻结与校准范围

SCORING.md、tasks.json、输入与验收步骤通过 MANIFEST.json 固定。CALIBRATION.md 明确哪些自动判据已通过正反例校准，哪些依赖现场人工证据。人工表格中的示范数据只用于评判器校准。实际参赛成品仍须完成全套验收。

评分冻结与运行配置登记是两件事。study.json 的待填项完成前不能开始可比较试验。原始语音任务属于开发任务，另外两项作为初始未调参任务。
