"""Build independent fixed synthetic audio before agent trials."""
import json
import sys
import wave
from pathlib import Path
import numpy as np
import sherpa_onnx

model = Path(sys.argv[1])
output = Path(__file__).resolve().parents[1] / "inputs" / "voice"
output.mkdir(parents=True, exist_ok=True)
sentences = [
    ("01-name.wav", "我叫小林，我的项目叫语音助手，计划周五交付。"),
    ("02-budget.wav", "请记住，项目预算三百元，界面使用蓝色主题。"),
    ("03-recall.wav", "我的项目叫什么，何时交付，预算多少，主题是什么颜色？"),
]
engine = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
    model=sherpa_onnx.OfflineTtsModelConfig(vits=sherpa_onnx.OfflineTtsVitsModelConfig(
        model=str(model / "model.onnx"), tokens=str(model / "tokens.txt"),
        lexicon=str(model / "lexicon.txt"), dict_dir=str(model / "dict")),
        num_threads=2, provider="cpu")))
records = []
for name, text in sentences:
    audio = engine.generate(text, sid=0, speed=1)
    pcm = np.clip(np.asarray(audio.samples), -1, 1)
    assert pcm.size > 0 and float(np.sqrt(np.mean(pcm ** 2))) > .001
    samples = (pcm * 32767).astype("<i2")
    with wave.open(str(output / name), "wb") as wav:
        wav.setparams((1, 2, audio.sample_rate, 0, "NONE", "not compressed"))
        wav.writeframes(samples.tobytes())
    records.append({"file": name, "text": text, "seconds": len(samples) / audio.sample_rate})
with wave.open(str(output / "silence.wav"), "wb") as wav:
    wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
    wav.writeframes(bytes(16000 * 2 * 3))
(output / "transcripts.json").write_text(json.dumps({
    "provenance": "independent pre-generated sherpa-onnx VITS audio; synthetic, not human recording",
    "records": records, "physical_microphone": sentences[0][1],
}, ensure_ascii=False, indent=2), encoding="utf8")
print(json.dumps(records, ensure_ascii=False))
