# 语音失败复核与宿主调整

候选 2423f688309b36d82c3b8f28adb248f53a98f00d3f2835b3b32d9e3a030a3c70 来自项目 41710f75-f40a-457e-b6c5-06a957bcabb5。本次诊断与对照使用原始候选文件，本地 HTTP 返回受控回复，新增付费模型请求为 0。

## 实测结果

1. Node 模型探针传入 timeout=2，实际客户端使用 AbortSignal.timeout，导致请求只有2毫秒。仅将诊断调用的值改为2000后，六项检查全部通过，切回2再次失败。生产探针已采用2000毫秒，Node入口说明同步注明单位。Python入口继续使用秒。
2. 正式环境的长 USERPROFILE 导致候选的 System.Speech 和 COM 语音激活失败。缩短 TEMP、APPDATA、LOCALAPPDATA均未恢复，仅缩短 USERPROFILE 后恢复。实际产品界面进行长路径→短路径→长路径对照，两轮朗读依次表现为都失败→均完整朗读约8秒→都失败。
3. 宿主现在复用已有的 Windows 短路径解析方法，将 USERPROFILE 映射为同一隔离目录的短别名。别名须经 realpath 核对，应用数据和备份位置仍绑定原目录。使用短别名的能力取决于文件系统提供的 DOS 别名，本机已实证。
4. 修复后重新执行原始原生验收，初始阶段九项用例全部通过，包括连续朗读。重开阶段执行后，在 textarea 的 toContainText 断言处失败。随后实际重开界面读取 inputValue，得到“你是「青梧」，只回答园艺问题。”，textContent为空。该断言须通过测试修订流程改为读取表单值，正式完整交付仍待收口。

## 宿主停止策略

用户要求进一步减弱宿主阻碍。正式验收失败身份现在包含实际源码指纹，修改后的源码有独立重试机会。相同源码、相同失败的停止上限从3次改为8次。失败反馈、请求预算与金额保护继续生效，纯参数拒绝及审阅提交协议保留原有独立处理。

回归验证覆盖新源码重试、同版本八次失败停止、隔离目录身份与复用、真实 Node HTTP 客户端毫秒超时，以及语音能力和缓存。相关87项测试、typecheck、build:main通过。候选重放的正式脚本仍因上述 textarea 断言返回 failed，未把局部通过覆盖为完整验收通过。

证据目录为 run-artifacts/voice-error-audit-20261116。llm-results.json保存超时对照，tts-variable-results.json保存单变量环境对照，gui-results.json保存实际界面对照，recheck-result.json保存原生验收与模型探针复核，reopen-values.json保存实际重开字段值。
