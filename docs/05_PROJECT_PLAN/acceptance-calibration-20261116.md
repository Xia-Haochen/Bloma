# 开发与验收边界校准

校准基线为 d81b85a。本批保留暂停的语音项目现场，以离线参考程序、封存提案和明确的预期判断校准机制。生产模块保持本次校准基线。

## 参考程序

参考实现位于 tests/fixtures/acceptance-reference，执行入口为 scripts/calibrate-voice-acceptance.ts。先创建隔离 PROMA_HOME 和新项目，复制已有 Python 运行时，复用经过校验的本机模型资源，然后调用原 prepareSpeechCapability、registerNativeGuiTests 和 verifySoftwareCandidate。

输入为宿主 voice-golden.wav。程序通过真实 Electron 文件输入读取音频，使用 SenseVoice 解码，再用 VITS 合成固定回复，浏览器音频元素播放到 ended，文本写入 APP_DATA_DIR 并在关闭重开后读回。固定回复明确限定了这项校准的范围，供应商模型、多轮语义与实体麦克风仍需各自证据。

在同一生产实现下运行三种情况，测试输入与断言完全相同。

| 情况 | 预期 | 实际 |
| --- | --- | --- |
| 参考实现 | 本机正式验证通过 | passed，四条案例通过，启动通过，三次真实解码 |
| 回复内容故意改错 | 原断言失败 | failed，保存文本案例失败，重开阶段 not_run |
| 恢复原实现 | 重新执行后通过 | passed |

证据保存在 C:/Users/17359/.bloma-validation/calibration-20261116-c/result.json。记录了标准音频、六份主要模型资产的 SHA-256 以及运行前后这些资产一致性。使用的是本机已有资源，未认证干净机器安装。初次准备参考夹具时修正过 delivery 枚举和缺失的 window_title，失败目录 a、b 保留。

可重放命令如下，三个环境变量须指向新输出目录、已有模型目录和已有 Python 虚拟环境。输出文件放在 dist-main/main，使宿主模板根目录按正常构建布局定位。

```powershell
$env:BLOMA_CALIBRATION_OUT='C:/path/to/new-output'
$env:BLOMA_CALIBRATION_ASSETS='C:/path/to/sensevoice-int8'
$env:BLOMA_CALIBRATION_VENV='C:/path/to/.venv'
node_modules/.bin/esbuild.cmd scripts/calibrate-voice-acceptance.ts --bundle --platform=node --format=esm --packages=external --outfile=dist-main/main/calibrate-voice-acceptance.mjs
node dist-main/main/calibrate-voice-acceptance.mjs
```

## 裁定校准

scripts/calibrate-correction-records.mjs 读取原试验的封存提案和裁定，校验裁定文件 SHA-256，识别与宿主标准音频完全一致的输入，输出校准材料并确认原台账未变。本次提取前两轮共七份提案，六份已有裁定，一份在暂停时待处理。

```powershell
node scripts/calibrate-correction-records.mjs C:/path/to/trial C:/path/to/new-output
```

本轮建立人工核对的预期事实，尚未向新的供应商模型购买重评分。因而不报告模型裁定准确率。

| 样本 | 可确定的事实 | 正确处理边界 |
| --- | --- | --- |
| R2 朗读等待修订 | waitForFunction 将超时放在第二参数，实际沿用默认五秒。修改后的隔离执行通过 | 原因应定位参数签名。修正正确位置的有界等待可走适配比较，较大逻辑改写再审具体差异 |
| R2 设置面板修订被拒 | 裁定承认面板展开逻辑保持业务输入和断言，另一个重开用例仍超时 | 面板修订的合法性与重开运行失败分别记录。其他用例失败本身不能证明面板修订改变预期 |
| R2 后续修订通过 | 九个用例隔离执行通过，正式复验通过 | 可以接续正式验收，保留前次真实失败 |
| R3 第一份修订 | 封存 WAV 与宿主标准音频字节完全相同，正式参考解可实际解码。草稿同时改变多个等待及消息定位步骤 | 夹具来源已知；整份修改仍需核对。不能把“二进制未展示”解释成“宿主无来源证据” |
| R3 第二、三份修订 | 用产品 TTS 生成 ASR 输入，链路未跑通，大部分案例未运行 | 输入来源变化属于语义修订。未运行案例状态为未验证，不能自动记成预期被削弱或产品行为失败 |
| R3 第四份草稿 | 暂停时 pending | 保持未裁定 |

R3 第一份草稿还有具体的时序风险。voiceTurn 先等待用户气泡，再读取 aiBefore，然后等待 AI 气泡数量增长。快速回复可能在读取 aiBefore 之前已出现，这会等待不存在的下一条回复。此结论来自封存源码分析，尚未在原候选上单独复现。它进一步说明整份草稿需要按具体改动核对，不能仅依据制作方的“只是适配修复”说明批准。

封存材料提取结果位于 C:/Users/17359/.bloma-validation/calibration-records-20261116/r2 与 r3。

## 目标边界

以下是后续实现的明确约束。当前生产实现仍有差距，应以本校准结果作为下一批变更的输入。

| 对象或阶段 | 允许改变什么 | 谁提供判断依据 | 如何影响发布 |
| --- | --- | --- | --- |
| 确认的业务目标 | 用户明确变更范围时更新 | 确认来源与可观察结果 | 最终结果必须满足 |
| 开发测试草稿 | 定位、辅助函数、等待与测试实现可修 | 原需求、原错误、差异与开发运行记录 | 草稿运行不签发发布资格 |
| 可信输入与预期 | 输入来源和语义变更必须显式核对 | 宿主标准资产、确认数据、独立设计 | 无依据弱化预期阻断发布 |
| 环境准备 | 路径、依赖和服务启动可修 | 实际解释器、模型校验、进程状态、就绪信号 | 准备失败返回环境缺口，业务案例为未运行 |
| 正式执行 | 在固定候选和输入上执行 | 宿主观察与持久状态 | 产生通过、失败或未验证事实 |
| 测试修订裁定 | 判断修改是否保留或合理纠正预期 | 具体差异、输入来源、所改路径的实跑证据 | 批准修订后仍需当前候选正式验证 |
| 候选审阅 | 核对覆盖、实现与已有问题 | 当前执行记录与冻结依据 | 明确缺口交给制作方，结算后由宿主发布 |
| 自主性评估 | 统计完成率、时间、费用和外部干预 | 多轮实际试验轨迹 | 用于评价 harness，独立于单个产品验收结论 |

## 校准所得的下一批范围

优先修正宿主证据传递及失败分类。为裁定材料提供已知夹具来源、明确的准备失败和案例未运行状态；把草稿合法性与产品是否成功执行作为两个判断。保留原失败，不让未知信息被误当作语义变更的证据。

先使用本批正负参考程序与七份历史提案核对这些行为，完成后再考虑付费模型复评与从头生成。按需求选择性执行、增加角色或更换整套 Agent 框架均需另有具体证据支持。

## 参考方法

采用 Playwright 的 fixture 生命周期思想，先准备明确输入与依赖，再执行用例，并通过同一数据目录验证重启。采用 Anthropic 对 eval 的参考解、评判器校准和逐条阅读轨迹的方法。采用其 harness 简化案例中的逐项变更和结果比较方法。本批没有复制其完整多 Agent 架构。

- [Playwright fixtures](https://playwright.dev/docs/test-fixtures)
- [Anthropic Agent评估方法](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)
- [Anthropic 长任务harness简化实验](https://www.anthropic.com/research/harness-design-long-running-apps)
