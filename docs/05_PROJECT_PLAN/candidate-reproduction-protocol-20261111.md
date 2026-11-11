# 候选复现与证据回传协议 v1

## 边界与权威

本协议用于把**现有 release-store 候选**送到独立执行环境运行固定诊断旅程，不是新的候选/发布/事故账本。`software-reproduction-v1` 的 package UUID 只是传输包 ID；原 `candidate_id`、source/runtime inventory 及原 C/V、冻结预期、质量/费用/发布门禁保持唯一权威。包与回执均声明 `verification: not_applicable`，退出码 0 不表示产品验收通过。

已在当前 Windows 上用真实 Node/browser 和 Electron 入口、IPC/文件保存、正常重开实测；**没有进行干净 Windows 重置、安装验收或最终平台 Cua 验收**。目录、HOME、profile、缓存、端口分开不等于 OS/网络沙箱。产品仍可能联网；只有操作者明确授权的候选才应执行。

## 固定候选与测试数据

宿主 API 在 `main/software/candidate-reproduction.ts`：

- `prepareCandidateReproduction(projectId, candidateId, frozenSuite, signal?)` 从原 `readSoftwareCandidate` / `validateSoftwareRelease` 取候选。用 release-store 的流式库存与物理复制，不硬链接开发依赖、不安装/修改共享 node_modules。将候选声明域中的应用/依赖字节复制到包 `app/`，**LAUNCH.json 字节不改**。依赖 junction 在包中变成真实目录文件。
- fixture 使用原 GUI fixture store/显式 suite text 物化到 `seed/`；不默认复制用户数据、旧环境、登录凭据或 profile。旅程 scope 必须匹配该候选的 verificationFingerprint；native_tests/free script 首期不支持。manifest 只保存固定步骤和 seed 库存，不把 source 文件路径当执行器可随意读取的宿主路径。
- 包位于 `PROMA_HOME/software-reproductions/<source-project>/<package-uuid>/`。包 manifest 固定原候选身份、原应用根（仅用作受控重定位）、生产平台/架构、应用/seed 每文件字节数及 SHA256、固定旅程、外部运行时文件要求和已有 managed runtime 来源/许可信息。
- 首期最多 10,000 文件、应用 1GiB、seed 64MiB、metadata 16MiB，超限明确失败而非裁成“完整包”。失败包保留诊断，不自动删除未知资源。已知 `.env*`、`.npmrc/.pypirc/.netrc/.git-credentials`、浏览器登录/credential 文件名及 pem/key 拒绝传输，不能为了通过而删改冻结候选。**这不是通用敏感内容检测**；对外转移前仍须审阅源代码、显式 fixture 和步骤输入。

导出返回 `manifestSha256`。该 pin 必须通过独立可信渠道带到执行器；从收到的包自己算 hash 再信任它不能认证来源。pin 只提供字节对应关系，不是签名/作者身份/验收证明。

## 检查、映射与独立启动

`inspectCandidateReproduction` 在解析前定额读取 manifest，核文件身份与独立 pin；每次重新流式读完整应用/seed 字节。传输包库存使用 `includeIgnored:true + hostLayout:false`：即使后来塞入 `.cache`/data 等原宿主布局排除域的文件也会被发现，不能借被忽略的目录夹带未绑定代码。拒导入链接、坏 scope/平台、字节变化及错误元数据。

运行时**不自动安装或回退到生产机旧绝对路径**。`runtime-paths.json` 是 `{"<外部文件sha256>":"<执行器上明确授权的绝对文件路径>"}`；每个外部文件均重新核 SHA256。如已有 `directory_sha256`（通常为 managed Electron）还核完整分发目录。仅 exe SHA256 **不覆盖** Node/Python/Electron 相邻库、系统依赖或安装正确性；原启动适配器还可能要求现有 runtime binding。需要准备运行时时用既有 runtime-manager/prepare_runtime 流程并取得相应授权，不改 pin 来掩盖不一致。

执行只对 LAUNCH 的完整绝对路径参数进行原 app 根→包 app 根或明确 runtime map 的替换；拒未声明外部路径及显式嵌入的绝对 flag 路径，不重写 JS/Python/配置里的字符串。browser 沿 `isolatedBrowserLaunch` 分配空闲端口提示；它不是释放到启动间无竞争的端口租约。Electron 仍经原自有启动、APP_DATA_DIR/profile 绑定。

`runCandidateReproduction` 每次显式请求生成全新 execution session，复用 debugWorkspace、copyDataForPreview、open/act/closeDebugSession。每次从 seed 开始，不接管旧 PID、不自动恢复/重试旅程。原声明的只读 fingerprint 与宿主生效启动 overlay 分开：重启仍核 LAUNCH 未改，不把生效新路径/端口写回冻结应用。公开 inspect_app 无此 overlay 权限。前后再验包与 runtime，运行中断/后检失败明确可能已发生输入副作用并提示 **do not replay**。取消不是撤销。

## CLI

入口自动走现有 templates 构建新鲜度门，按需构建，不安装依赖；打包的源码 CLI 使用独立 `.cache/reproduction-cli-*` 临时目录和当前模板，退出只清理自身目录。需要当前仓库及已安装依赖；它不是新的桌面 daemon 或独立安装器。

```text
npm run reproduce:candidate -- export <source-project> <candidate-id> <suite.json>
npm run reproduce:candidate -- inspect <source-project> <package-id> <manifest-sha256>
npm run reproduce:candidate -- run <source-project> <package-id> <manifest-sha256> <executor-project> <runtime-paths.json>
npm run reproduce:candidate -- evidence <executor-project> <execution-session> <debug-id> [since-seq]
```

export 的 suite 是操作者明确选择的诊断旅程；CLI 经原 parse/sealGuiFixtures 冻结输入，**不修改或替代独立 C 已冻结的业务预期**。run 在一个进程内有界执行和关闭，不跨 CLI 进程恢复执行。evidence 仅用原 metadata 读取旧记录，保留 closed/failed，旧 live 记录转 interrupted；不会接管进程或重放动作。CLI JSON 参数最多 256KiB，实际定额读取与身份核验，不只依赖一次 stat。

## 证据回传

run 返回来源候选/manifest pin、执行器 owner/session、平台/架构、声明/生效入口和原 debug snapshot、原 seq/前向 diagnostic_page、存储摘要/步骤/错误。`os_reset:not_attested` 不允许改成 clean/verified。首次返回最多80条且总查询字节遵守原 O1 限额；根据 `diagnostic_page.next_seq` 用 evidence 续读，history_gap/more 不能当 EOF/PASS。

PNG 只列原自有 evidence 目录中本次选中截图，限制20MiB，附相对路径/大小/SHA256、`visual_review:not_reviewed_by_model`。只回传该 JSON 和**明确列出的相对附件**；不把整个 HOME/data/profile/源 checkpoint/缓存打包。附件不可读/越界/变化时报告 attachment_gap，不伪称有图。完整 backend 归档仍按原 read_process/log 机制查询，不新建平行日志账本。执行器产物是待审事实，原宿主 C/V 仍需按当前候选、合同、独立预期判断。

## 故障矩阵与当前证据

| 情况 | 当前验证 / 剩余边界 |
| --- | --- |
| 源工作树、原候选 app、依赖 cache 已移除 | 真实物理包仍实际启动、保存 UTF8、正常 restart 读回；原注册表不变、原候选不因复现而 verified |
| pin 错/伪 PASS/同 stat 改字节/额外 .cache/坏 seed/目录链接 | 明确拒绝；不从不完整数据推断未变化 |
| 缺 runtime map/错误 exe/旧 producer 路径 | 启动前拒绝，无隐式回退或下载安装；exe 不等于全运行环境证明 |
| 后端真实 exit27/EACCES | 返回原 failed startup metadata/owned stderr，不只抛 page.goto 而丢掉 session；不伪造因果裁决 |
| 派发后取消 | 真实 slow 事件落盘一次，取消后 unknown/do-not-replay、旧记录保留且服务关闭，不自动 rerun |
| 端口冲突/主宿主管道关闭 | 原 execution/debug 组实际冲突与真实 grandchild 回收反例；空闲端口选择不等于 OS 租约 |
| 旧数据升级、失败与回退 | 当前 active release-update 真实100条SQLite记录跨失败迁移/升级/搜索标签/备份恢复；notes-gui-upgrade 实际 GUI保留 create/edit/save/reopen 与 id，再让作者引入删行反例，原门禁失败。不是旧休眠 data-migration drill 冒充现役链 |
| 断网、权限/杀进程、干净 OS 安装/升级 | 数据包操作本身不联网；**未验证产品在断网/系统权限矩阵中的行为，干净Windows及最终平台Cua仍待外部执行条件**。已有受控 Node退出/取消不是全系统故障矩阵 |

组合 `continuation-e1-final-tests.log`：7文件47项（reproduction12/debug10/recovery8/inventory3/isolation7/release-update6/notes-gui-upgrade1）通过。随后增加 seed **物化前**64MiB总量预检（避免复制后才拒绝），当前 E1 全12项再次通过 `continuation-e1-guard-tests2.log`，guard typecheck/main构建通过。专项不是当前完整离线回归；旧失败/执行器中断日志保留，见升级主计划。

## 干净 Windows 执行清单（待外部条件，不是已运行）

1. 明确独立执行器/重置点、磁盘/管理员边界，使用空的专用 PROMA_HOME 和独立 Bloma user-data-dir；不复制生产 home、凭据/旧 LocalState，不动常用 App。
2. 审阅并仅传输整个 reproduction package 目录与独立 pin，保留 `<source-project>/<package-id>` 布局。通过既有流程建立执行器本地项目，显式提供 executor-project；不把 source project 的 registry/质量/费用账本搬过去。
3. 经授权安装/准备匹配运行时/依赖，记录版本、来源、许可和 bytes/directory 校验。缺条件即记录阻塞，不跳过断言或改 pin。
4. inspect→一次 run；按案例实际验证安装/启动/保存/正常重开/旧数据升级，并执行明确允许的断网、权限、终止、迁移失败/回滚矩阵。每次重置/seed/失败保留与副作用范围须记录，不重放 unknown 输入。
5. 回传原事实 JSON、所列附件及必要归档片段，保持 not_attested 直到操作者有独立重置/环境证据；原质量/发布流程独立收敛。Windows Sandbox/VM、Cua driver 不是本协议自动安装项。
