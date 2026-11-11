# Bloma 工具升级首批实施与验收交接

日期：2026-11-11（Asia/Shanghai）。起点：`sprint2 / 09d8549`，计划来自同日Codex最新对话。用户已授权实施，要求少用子Agent；本批实际使用0个。

**结论：基础工具首批已实现并通过专项；整份B0–B8计划没有全部完成，最终标准整套回归尚未形成全通过结果。改动留在隔离分支，未合入原sprint2、未push，不把隔离分支当用户常用App已升级。**

- 分支：`proma/tooling-upgrade-20261111`。
- 工作树：`C:/Users/17359/.proma/agent-workspaces/default/c8ff45a0-bce1-4744-9f16-3612de0db557/bloma-tooling`。
- 证据根：`C:/Users/17359/.proma/agent-workspaces/default/c8ff45a0-bce1-4744-9f16-3612de0db557/`。
- 主计划：[基础工具与工程能力升级](agent-capability-upgrade-20261111.md)；[Vide专项](vide-adoption-design-20261111.md)仍为后续设计，未声称已经移植。

## 1 实现范围

| 项目 | 本批落地 | 重要边界 |
| --- | --- | --- |
| 搜索 | grep直接给命中正文；字面/大小写/局部路径、上下文、文件模式；内容绑定分页；find/list分页 | 有限glob和JS正则，不冒充完整rg；扫描/深度/大文件/二进制/不可读缺口明确 |
| 读取 | 字符/UTF-8字节限额；长行有版本绑定续读；同入口最多8窗口，逐项保留失败 | 聚合为所有后续错误预留空间；不允许早项挤掉后项；16MiB文本上限，不是流式读取任意大文件 |
| 编辑 | 单文件1–32个片段按同一原文预检，一次语法校验和一次写入；内容SHA256；提交前CAS | 旧单片段stat版本只作兼容；新批量要求hash；没有跨文件事务或跨进程锁 |
| 路径 | 读取/搜索增加真实路径越界检查；写入再次核对并拒绝junction别名绕过原权限 | 不声称提供OS沙箱或完整对抗跨进程文件系统竞态 |
| 命令日志 | 退出不重复stdout/stderr；显式tail兼容；脱敏归档按原进程/会话归属查询、按长记录续读 | 每进程8MiB/每home16份，满额/IO/长行缺口如实报告；不自动删旧证据；同步旧命令生命周期尚未统一 |
| Pi边界 | 局部toolCallId/context、按调用ID回填结果；复用原观察事件补耗时和文本字节 | 仍sequential；白名单文件工具为同步IO，尚无收益依据开并发；不增加loop/PASS台账/模型 |

参考本地Proma上游`bf3e98ca61dd8365eceaef876c0f7473700878a6`的Pi包装/权限/sequential策略和当前安装的Pi1.4.0实际执行逻辑；采用宿主边界适配而非整体重写。未安装外部参考项目或改模型/渠道。

## 2 受控对照：不是供应商效果实验

同一离线任务驱动，旧基线`tooling-before.json`与最终`tooling-final.json`：

| 样本 | 旧工具往返 | 新工具往返 | 返回文本 |
| --- | ---: | ---: | --- |
| 定位一条业务实现并得到正文 | 2 | 1 | 147→143 UTF-8字节 |
| 读取4个小文件 | 4 | 1 | 584→1419字节；完整版本/续读/分项状态增加元数据 |
| 10万中文字符单行首次读取 | 1 | 1 | 300092→47326字节；其余有界续读，不丢弃原文件 |
| 同文件两处修改（含预读） | 3 | 2 | 205→215字节；一次校验写入 |

**只能证明这些受控样本的接口往返/首包体积变化。** 小文件元数据变大，单机耗时没有证明改善；没有真实供应商实验、费用结论、交付成功率或普遍性能百分比。

## 3 验证及未通过记录

### 最新专项

`npm run test:tooling:offline`：**11文件130项通过**，日志`final-specialized-tests.log`。包含实际Pi AgentSession的schema/部分读取失败/多片段写入、调用身份/预算/取消/恢复、真实Node/npm命令、进程归属、stdin/EOF、完整日志与脱敏反例。模型响应均受控，不是付费供应商认证。

`npm run typecheck`、`npm run build:main`通过，见`final-typecheck.log`、`final-build-main.log`。早先完整`check:offline`亦构建renderer/main/worker/preload/templates；未启动或重启用户常用Bloma实例。

### 整套回归仍未收敛，不能改写成全部通过

1. `47be8a7`的原标准19文件206项曾完整通过：`final-check-offline.log`。这是早一代码版本，不代替最终全部回归。
2. `a291d8b`扩大为30文件336项的并行组合：335通过，CLI修复后交付夹具约91.7秒未达completed；该夹具内部90秒取消信号。原失败见`final-expanded-check-offline.log`。同断言单独执行约46.3秒通过，`verification-failure-retest.log`；不是将原组合追认为通过。
3. `ae64181`将交付夹具移到后续单worker后，前18文件199项仍有浏览器纠正夹具90秒超时，并出现其临时目录EBUSY清理失败：`final-isolated-check-offline.log`。同断言单独约34.6秒通过，`test-correction-failure-retest.log`。未确认生产死锁，也不据此免除失败。
4. `d6df5a0`单worker组合前18文件：198/199通过，音频正对照checkbox的实际PCM peak为0而失败，见`final-serial-check-offline.log`。本轮未修改音频产品/断言/门槛来追求PASS，后续组因&&短路未执行。

最后撤下未证明稳定且会拖慢全套的临时串行拆组策略，保留原标准19文件调度，新增独立`test:tooling:offline`入口，并将它接在`check:offline`末尾：原标准失败时不会跳过失败继续声称整套通过。最终该组合没有再全跑；专项130项、类型及main构建已经重跑通过。后续应先针对这些既有重型夹具的调度/等待/真实音频就绪取证，再处理GUI/Vide扩展。不得简单放宽生产时限、删断言或跳过失败。

## 4 保护与提交

- 原仓库HEAD仍09d8549、原用户dirty文档`production-workflow-v2-20261020.md` blob仍`53c7abb3aef8497d8b0522b8aab806c82b2ec164`，不覆盖、不纳入本批提交。
- 本次项目registry、quality、test-corrections、usage、run-state、execution-limits六文件重新取SHA256对照；`protected-state.before.json`和`protected-state.after.json`记录全部一致。最终再核对见`protected-state.final.json`。
- 未改原生成产品、未解除校园暂停、未清unknown/费用/质量账本、未真实模型付费、未发布、未fetch/push、未重启常用实例；未改Codex或Proma持久记忆/镜像/SYNC-MANIFEST。
- 代码批次已即时提交：fe06c6e基线、33d77f0查询读取、acd15c7批量编辑、0dbed74日志、47be8a7 Pi边界、a291d8b聚合限额与测试。ae64181/d6df5a0保留测试调度尝试历史；后续提交恢复标准入口并固化本交接。按git定位，不抹失败历史。

## 5 下一步与明确未完成项

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
