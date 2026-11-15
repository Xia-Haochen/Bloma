import json
from pathlib import Path
import sys
import wave

sys.path.insert(0, str(Path(__file__).parent))
import numpy as np
import sherpa_onnx
from speech_runtime import SpeechEngine

input_file = Path(sys.argv[1])
with wave.open(str(input_file), "rb") as source:
    assert source.getsampwidth() == 2
    samples = np.frombuffer(source.readframes(source.getnframes()), dtype=np.int16)
    samples = samples.reshape(-1, source.getnchannels())
    rate = source.getframerate()
text = SpeechEngine().transcribe(samples, rate)
reply = "收到，我们下周四下午三点开会。"
model_root = Path(sys.argv[3])
tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
    model=sherpa_onnx.OfflineTtsModelConfig(
        vits=sherpa_onnx.OfflineTtsVitsModelConfig(
            model=str(model_root / "model.onnx"), tokens=str(model_root / "tokens.txt"),
            lexicon=str(model_root / "lexicon.txt"), dict_dir=str(model_root / "dict")),
        num_threads=2, provider="cpu"), max_num_sentences=2))
audio = tts.generate(reply, sid=0, speed=1)
pcm = (np.clip(np.asarray(audio.samples), -1, 1) * 32767).astype("<i2")
assert pcm.size > 0
target = Path(sys.argv[2]) / "reply.wav"
with wave.open(str(target), "wb") as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(audio.sample_rate)
    output.writeframes(pcm.tobytes())
print(json.dumps({"text": text, "reply": reply, "file": str(target),
                  "duration": pcm.size / audio.sample_rate}, ensure_ascii=True))
