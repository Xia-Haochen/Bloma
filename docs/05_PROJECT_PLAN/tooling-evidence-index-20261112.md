# 工具工程受控证据索引与待外部验收项

此文件是导航，不是新 PASS/费用/事故账本。具体门禁仍由原 software-v1、Pi、quality ledger、冻结合同、验证/发布出口和费用账本决定。报告在本次会话工作台；专项不能拼成同一源码的完整回归。当前完整离线回归结果另按最终提交记录。

## 可重复工作流对照

`tests/integration/pi-tooling-journey.test.ts` 真 Pi→原文件/进程工具→真实 Node 流式任务，比较**当前代码的兼容调用形态**与批量/增量调用，绝不是历史源码或真实模型准确率对照。固定两个源码文件改动，同轮分别读/编辑与同轮批量均允许，未人为强制旧方案每个工具都再问一次模型。

两种形态都定位数字转换和两位美元格式、实际修改两个文件、按真实 stdin EOF 完成流式作业、运行原固定输入和未给受控 query 的小数数据点、从归档找回被尾部淹没且分 chunk 的 EARLY_NOTE/凭据行。每次构建实际启动计数=1，预期字节不改、原 tool-call ID 配对，返回不是产品 PASS。留出数据点仍是测试作者设计，不证明未知任务上的模型泛化。

为避免无 cursor 的兼容 tail 不必要忙读，正式对照给 **tail/incremental 两者都传同样 since_seq**。初版未这样处理的报告 tooling-journey.json 留存，不用于下表。正式 ABBA 顺序 `compatibility, batched, batched, compatibility`，tooling-journey-balanced.json：

| 样本 | SDK轮数 | 文件工具调用 | 总工具调用 | 参数UTF8 B | 工具返回UTF8 B | SDK messages累计UTF8 B | 总ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| compatibility 1 | 12 | 5 | 13 | 1056 | 320868 | 1351928 | 9663.69 |
| batched 1 | 12 | 3 | 11 | 1018 | 95135 | 634227 | 2454.31 |
| batched 2 | 12 | 3 | 11 | 1017 | 89161 | 591017 | 2556.10 |
| compatibility 2 | 12 | 5 | 13 | 1055 | 294498 | 1166702 | 2140.70 |

结论限定如下：

- 此固定工作流文件调用5→3、总调用13→11，**模型轮数12→12未减少**。同轮多调用本来就可行，不能把调用数缩减冒称模型往返缩减。
- 两份兼容返回合计615366B、批量增量184296B；SDK messages累计2518630→1225244B。主要收益是显式tail反复附快照与增量续读的差异，不是所有批量都省字节。单个小文件批量框架、逐文件CAS/partial事实本身可能更大。
- SDK字节仅 `options.messages`，不含system/schema/HTTP封装，不是供应商tokens、cache或费用；无付费调用。首样本有冷启动，**最后兼容样本还比两个批量样本快**，不能据此宣传普遍耗时倍数。
- 真实任务实际约为“阻塞直到EOF的流式构建样作业+Node断言”，不是webpack/npm编译性能；脚本选择/修复都是受控provider/测试作者，非自主诊断成功率测评。

本批 `continuation-journey-final-tests.log` 4文件17项通过（新journey1/Pi文件2/process-log6/async8）；当前typecheck通过。另 `continuation-journey-recovery-tests.log` 2文件14项通过（file-interactions3/long-task-recovery11）。不是当前全套认证。

## T0八类场景导航

| 场景 | 当前可复现证据 | 不能据此声称什么 |
| --- | --- | --- |
| 多文件定位/读取 | tooling-before→tooling-final历史同driver；file-query unit；新Pi journey真schema与原call ID | 已证明模型自主选对文件、历史整个产品端到端收益 |
| 跨文件修改 | batch-edit/text-edit/write-lease/真pi-file-tools；journey两文件真实Node固定/留出数据点；preflight/CAS/partial失败 | 跨文件事务、崩溃回滚、跨进程锁、全量并发安全 |
| 长构建/命令 | 新真实stdin EOF流式任务；async-command真实Pi/静默停止/中断；execution supervisor真父管道关闭回收grandchild | 所有编译器、交互PTY、Windows任意命令兼容性 |
| 长日志排障 | process-log保留1000行前错误/脱敏/8MiB容量/gap/Unicode大记录续读；journey1200行+split credential | 任意数量日志都完整、容量错误是EOF、供应商input费用下降 |
| 重复按钮/长结构/限额 | ui-semantics真实browser/iframe/open shadow/Canvas gap/refs；native-ui重复名称/offered索引/模态/最小化/实际重建 | 完整AX/closed shadow/任意虚拟列表、同数值HWND复用压力已强制成功、恶意provider/原子UI安全 |
| 持久化/正常重开 | debug-sessions；O1真Electron IPC失败→作者修→普通重开；E1删旧source/cache后包运行；release-update100条SQLite与notes GUI | 旧trace替代当前独立C/V、所有安装环境/用户数据迁移已验收 |
| Windows对话框 | **现有file-interactions**本机真实owned Electron `dialog.showOpenDialog`读冻结文件；Native WinForms modal/pattern；源码/fixture损坏不复用PASS | 最终平台Cua已做、任意系统窗口都可读写/全局输入租约已授权 |
| 宿主中断/恢复 | Pi native/receipt/torn append不重放；debug历史两读者前向seq；**long-task-recovery真两个Node进程exit23→新PID恢复、effect once、makerCalls=0、原预算累计** | 旧PID接管、unknown自动重试、跨机器daemon/OS重置或持久call-id exactly-once |

恢复组的31分钟与心跳有些用**假时钟**推进，不是31分钟实钟压力结果；最后双进程case确实有两个真实PID/退出码和一次真实CLI副作用，证据 `run-artifacts/closeout-process-fixture/evidence.json`。取消后的继续仍原project/Pi/budget，不清账、不擦旧失败。两类证据分开看。

## 保守选择与仍受外部条件限制的部分

- Pi仍sequential，局部调用身份与有界批读/多文件有序CAS已验证。无全量parallel准入、持久重放幂等或跨文件崩溃事务认证，不因工具parallelSafe标记就开全量并发；这是计划T2允许的首期回退。
- 真TS/JS LS、可选真Jedi/Python固定桥已接线；Jedi非LSP、Python diagnostics语法级、无硬OS沙箱。T4首请求更小但按需两请求总量反而更大，故不启未有准确率收益证据的动态schema/tool-search/REPL。
- V3受控单伙伴三版真探针说明消息确能携带证据、同session续接与停机不新购请求；测试作者集成修复，不吹成真实模型长期贡献/费用改善。默认工程伙伴与交互探索开关保持原授权状态。
- E1是原候选物理包/独立pin/runtime映射/一次性正常入口/原诊断回传，不是新发布状态。干净Windows安装、断网、全权限矩阵及旧数据真实系统升级仍需独立执行器，见候选复现协议。
- 最终常用平台App展示/原生交互必须按Cua验证；当前driver未配置的事实已告知，不能用上述browser/Electron/WinForms工程夹具替代。未提供干净Windows环境、未授权付费模型效果实验时，不擅自装系统/VM、复制旧profile/凭据、解费用暂停或重启常用App。
