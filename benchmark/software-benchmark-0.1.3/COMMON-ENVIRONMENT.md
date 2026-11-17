# 统一运行条件与公共资源

共同条件以study.json为准：Windows 11、Node 22.22.2、Python 3.13.7、Electron 39.8.10。准备工作在计时开始前完成，各组得到同一份公共资源。Agent可以自行选择实现技术；已经公开的依赖和模型缓存均可使用。额外依赖安装计入任务时间。

独立分发的common-assets-0.1.3.zip约数百MB，包含SenseVoice INT8、Silero VAD、中文VITS语音模型及两份通用语音辅助模块。common-assets-manifest.json固定每个文件的哈希。解压到短ASCII路径，例如C:\bench-assets；所有组使用相同内容。参考业务应用不包含在这个包中。

在专用Python环境中准备以下共同依赖：

    python -m venv C:\bench-runtime
    C:\bench-runtime\Scripts\python.exe -m pip install numpy==2.5.4 sherpa-onnx==1.13.8 sounddevice==0.5.6 pypdf==6.21.2 reportlab==4.4.10

开跑前运行：

    node tools/verify-assets.mjs C:\bench-assets

把实际Python路径、公共模型目录和辅助模块目录作为环境信息提供给各组Agent。配置BLOMA_SPEECH_MODEL_DIR=C:\bench-assets\speech-models\sensevoice-int8后，公共定位器直接使用这些文件。辅助模块目录为C:\bench-assets\speech-tools。各组可选择直接使用或自行实现，不能只给Bloma这一组资源。

制作模型采用deepseek-flash、高思考、1M上下文、单请求32,768输出上限。允许联网、安装依赖、修改本任务项目和使用同模型的子Agent；子Agent和内部审阅费用全部计入10元。每任务90分钟，从第一次提交任务原文计时。每项任务新会话、新项目、新数据目录，失败后不另开“补考”会话拼接结果。

业务服务采用同一个DeepSeek端点和高思考设置，输出上限4,096。受控服务用于稳定制造503、鉴权失败和排队延迟。外部验收的真实模型费用单列；制作期间产品调试产生的业务模型费用计入制作额度。

组员开跑时填写run-environment.json：Agent版本、构建或commit、实际机器、协议、有效配置和公共资源校验结果。原始请求中去掉Authorization与API密钥，其余参数保留。供应商别名换版、客户端自动降档或模型切换都必须记录。

参考基线的实体麦克风环境由用户确认可用，按用户要求不另行录音实测；三段标准WAV、静音输入、取消逻辑和数字音频播放分别实测。此确认只描述参考校准范围，不会替代被测成品的实际功能证据。
