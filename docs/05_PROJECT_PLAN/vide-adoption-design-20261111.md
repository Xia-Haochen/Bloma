# Vide 源码借鉴与 Bloma 适配设计

日期：2026-11-11。状态：只读调研与待实施设计。主计划：[基础工具与工程能力升级](agent-capability-upgrade-20261111.md)。

## 1 参考版本与证据范围

仓库：[Norbert515/vide_cli](https://github.com/Norbert515/vide_cli)。本次读取Git tree及选定源码，锁定commit `3ae14cdca9525f65e2b9c0e22391a5c2ad8ccbc6`；未安装、构建或运行Vide，以下是实现结构参考，不是效果认证。README标示Apache-2.0；复制具体组件前仍核查该版本组件/依赖许可证。

官网有部分“Coming Soon”与仓库README不一致，例如远程控制；本文件以已读源码说明具体能力，不把官网展示画面当可用性验证。当前README仍将Codex/Gemini列为后续后端，不能据此声称已经有多后端效果。

## 2 具体源码与取舍

下表链接均固定到本次检查版本。

| 编号 | 已读实现 | 可借鉴设计 | Bloma落点和区别 |
| --- | --- | --- | --- |
| V1 | [Flutter runtime server](https://github.com/Norbert515/vide_cli/blob/3ae14cdca9525f65e2b9c0e22391a5c2ad8ccbc6/packages/flutter_runtime_mcp/lib/src/flutter_runtime_server.dart) | 管理实际实例，提供启动、热更新、截图、错误和停止；启动关联工具调用身份；开发入口注入runtime工具 | 复用debug-sessions/runtime绑定；先Electron/Web。合成开发入口与正式产品入口证据严格分开 |
| V1a | [actionable elements](https://github.com/Norbert515/vide_cli/blob/3ae14cdca9525f65e2b9c0e22391a5c2ad8ccbc6/packages/runtime_ai_dev_tools/lib/src/actionable_elements_extension.dart) | 从Semantics树取得可操作元素，考虑可见路由/弹窗与DPI，必要时回退widget树 | G1/G2提供结构化观察和明确降级；引用须绑定当前快照，不能把旧坐标跨版本使用 |
| V3 | [agent MCP server](https://github.com/Norbert515/vide_cli/blob/3ae14cdca9525f65e2b9c0e22391a5c2ad8ccbc6/packages/vide_core/lib/src/mcp/agent/agent_mcp_server.dart) | 创建子任务、异步发送消息、唤醒与任务展示 | 复用Bloma现有delegation/伙伴消息；不再建设Agent网络和任务台账，不继承任意角色数量 |
| V4a | [remote session](https://github.com/Norbert515/vide_cli/blob/3ae14cdca9525f65e2b9c0e22391a5c2ad8ccbc6/packages/vide_client/lib/src/remote_vide_session.dart) | 连接恢复、按seq去重、历史重建与流式消息分开 | 连接中断不等于执行中断；基于Bloma既有public_message_id/事件归属设计恢复，不能把显示回放变工具重放 |
| V4b | [session registry](https://github.com/Norbert515/vide_cli/blob/3ae14cdca9525f65e2b9c0e22391a5c2ad8ccbc6/packages/vide_daemon/lib/src/daemon/session_registry.dart) | 会话进程登记、持久化、健康检查、恢复 | 先验证本机host/worker分离必要性；不得新增与run-state/operation竞争的业务权威，旧PID归属不能仅凭存活判定 |
| V5 | [worktree service](https://github.com/Norbert515/vide_cli/blob/3ae14cdca9525f65e2b9c0e22391a5c2ad8ccbc6/packages/vide_core/lib/src/agent_network/worktree_service.dart) | 工作目录选择、worktree变化后重建agent client | 复用Bloma归属和隔离。该文件有worktree缺失时退回原目录逻辑；Bloma写任务不照搬，必须停止并报告隔离失效 |
| V6a | [verification-first](https://github.com/Norbert515/vide_cli/blob/3ae14cdca9525f65e2b9c0e22391a5c2ad8ccbc6/packages/vide_core/assets/team_framework/behaviors/verification-first.md) | 修复前复现、实现前了解可用验证入口 | 吸收方法，但不增加每个任务强制前置文档；现有冻结标准和真实执行保持权威 |
| V6b | [handoff etiquette](https://github.com/Norbert515/vide_cli/blob/3ae14cdca9525f65e2b9c0e22391a5c2ad8ccbc6/packages/vide_core/assets/team_framework/etiquette/handoff.md) | 请求具体、范围明确、附文件/验证依据 | 用原Task/Assignment与证据引用承载，不让Agent重复填写一套Markdown协议 |

V2续接已补读锁定版本的lib/modules/agent_network/components/tool_invocations/{tool_invocation_router,diff_renderer,terminal_output_renderer}.dart及顶层LICENSE（Apache-2.0）。只参考分类路由/折叠日志方法，不复制Dart组件或依赖。其Edit差异依cat-n文本与trim后的行集合猜测，Bloma不照搬：实际字节提交时捕获有界前后文、版本指纹，未知/截断明确标注；只有applied的项展示写入，声明/失败不能冒充成功。未运行Vide，不能据源码认证其效果。

## 3 V1：运行时适配设计

对外沿用inspect_app，内部适配器提供能力发现、打开、观察、动作、更新、诊断与关闭。能力缺失显式返回，不以空结果表示成功。公共字段最少包含实例归属、源码身份、观察身份和证据位置，直接复用既有定义。

先完善Electron/Web的页面结构与错误查询。以后确有Flutter任务再研究VM service/semantics/hot reload；TUI则单独验证屏幕状态、终端尺寸和输入。无需为了技术覆盖统一更换生成产品框架。

开发热更新保留调试数据，但正式候选仍重新绑定当前字节并走正常入口。借鉴Vide的调试注入时，必须证明注入没有改变待验业务行为，且未混入发布包；无法证明则只能作为诊断。

反例：热更新失败、旧实例仍活、截图来自旧路由、设备像素比变化、错误缓存未清、应用重启后控件引用失效。验收以真实适配器操作和版本身份为准。

## 4 V2/V3：显示和协作

工具卡显示运行中/已退出/失败、精确差异、日志入口及用户下一步；正常工作不要求用户操作。复用UX-001的消息边界，工具块不拼成另一条业务对话或覆盖当前宿主阻断。

异步调查继续使用同一伙伴会话；派发具体问题，结果返回结论、代码/证据位置和未确定部分。宿主可供给公开工具请求/返回；请求不当成功，私有思考和C/V内部内容不共享。

消息展示完成与任务执行完成分开；迟到消息携带原归属和版本，不能推进新候选。父任务结束后子调查有界排空；重复同字节事实不唤醒，重大新事实仍可交接。

验证指标：负责人重新调查次数、伙伴首次有效事实的延迟、被采纳并复验关闭的问题、协作总费用与收尾占用。更多消息和更多角色不算收益。

## 5 V4：会话与执行分离

第一阶段仅研究当前host退出/客户端重连的缺口，复用原Pi session store、run-state与执行归属；是否需要独立常驻worker由复现实验决定。

如确有需要：客户端只订阅/发送已授权指令，执行服务拥有进程与原operation；事件有稳定编号和恢复游标；重连可重放显示事件，工具副作用必须按原回执核对，不执行第二次。取消、预算耗尽与用户范围确认仍由单一宿主规则决定。

远端daemon暂缓为独立扩展：需定义认证、传输、执行机器资源/凭据、文件同步、网络断连、取消送达与账本归属。Vide的REST/WebSocket或推荐Tailscale不是Bloma已实现的安全/恢复保证。

验收：客户端断开执行继续、worker崩溃、宿主重启、事件缺口/重复/乱序、历史结束事件晚到、预算拒绝后重连、双客户端重复发送、无法判定旧副作用时保持unknown。

## 6 V5：worktree与并行实现

完整隔离单位是任务运行环境：worktree、候选身份、APP_DATA_DIR、端口、profile、日志和工具归属。共享依赖缓存必须只读或有明确写协调；原生鼠标键盘不能因worktree分开就并发。

只拆接口稳定、可独立验收的模块；实现者负责自己的基础验证，负责人做集成取舍。合并冲突保留现场；合并后原候选证据失效并重新验收。任务回退不得触碰用户数据或别人的分支。

worktree目录缺失、错误路径、跨任务端口冲突、后台进程未退出、两方业务规则不一致为必须覆盖的反例；不将“Git合并成功”当功能集成成功。

## 7 基础工具与Vide的关系

Vide主要在现成Agent框架之上组织会话及领域工具，不能据其编排层证明其通用文件/Shell接口优于Bloma。Bloma工具升级应以当前Pi实际路径与测量为依据。

优先级仍为主计划T1/T2/T3：搜索直接提供有用内容、读取和日志有界续查、只读批处理与安全并发、精确多片段编辑、调用身份和预算正确。这些为所有角色提效，再考虑增加调查者或扩展框架。

## 8 实施交接清单

1. 从主计划B0开始核实当前基线，记录原调用成本。
2. 每个V项先选一个具体失败或任务，定义最小接口与反例；列明共用的现有宿主模块。
3. 外部组件采用锁定版本；参考代码、直接依赖、复制代码三种方式分别记录许可与维护责任。
4. 先离线/隔离环境验证；原付费暂停和原项目状态不变。
5. 结果回填主计划批次状态，保留未验证边界；不因读到源码就宣称移植完成或效果更好。
