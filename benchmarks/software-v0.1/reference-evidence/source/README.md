# 三任务参考应用

这些应用用于评估者校准公开验收，不进入Bloma或通用Agent的制作工作区。业务代码独立于Bloma编排和验收模块，正常操作经Electron界面完成，数据各自存储在APP_DATA_DIR。

仓库已安装Node/Electron/Playwright，Python环境和模型按benchmark的COMMON-ENVIRONMENT.md准备。单独启动某个应用时：

    $env:REFERENCE_MODE='equipment'  # equipment / documents / voice
    $env:APP_DATA_DIR='C:\bench-reference\equipment-data'
    node_modules\electron\dist\electron.exe tests\fixtures\benchmark-reference\main.cjs

文档可设置REFERENCE_DOCUMENT_PYTHON。语音需要REFERENCE_VOICE_PYTHON、BLOMA_SPEECH_MODEL_DIR和REFERENCE_SPEECH_TOOLS，后者指向公开speech-tools目录。使用界面的服务设置填写端点、模型、凭据；真实密钥由Windows safeStorage加密保存。导出写入数据目录exports，界面显示路径。

独立自动重放：

    node scripts/calibrate-benchmark-e2e.mjs C:\bench-evidence\equipment equipment
    node scripts/calibrate-benchmark-e2e.mjs C:\bench-evidence\documents documents
    node scripts/calibrate-benchmark-e2e.mjs C:\bench-evidence\voice voice
    node scripts/calibrate-benchmark-e2e.mjs C:\bench-evidence\audio voice-audio
    node scripts/calibrate-benchmark-e2e.mjs C:\bench-evidence\cancel voice-cancel

每次使用新目录；失败证据保留。voice-audio只补充三轮浏览器数字音频输出证据，voice-cancel明确使用合成输入设备。不能用这两项冒充物理设备测量。

真实模型校准用评估者的金额保护代理scripts/benchmark-live-service.cjs，并配置REFERENCE_LIVE_ENDPOINT指向代理端点文件；voice-live执行4次请求，documents-live执行4次。代理须显式传入现有授权金额账本、渠道文件和解密profile，最多8次调用。它不创建新预算，不输出真实密钥。
