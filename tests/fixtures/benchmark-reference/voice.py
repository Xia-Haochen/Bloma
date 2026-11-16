import json
import os
from pathlib import Path
import sys
import wave
import numpy as np
import sherpa_onnx

sys.path.insert(0, os.environ["REFERENCE_SPEECH_TOOLS"])
from speech_runtime import SpeechEngine

request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
if request["action"] == "asr":
    with wave.open(request["file"], "rb") as source:
        if source.getsampwidth() != 2:
            raise ValueError("请使用 PCM16 WAV")
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2")
        samples = samples.reshape(-1, source.getnchannels())
        rate = source.getframerate()
    text = SpeechEngine().transcribe(samples, rate)
    print(json.dumps({"text": text}, ensure_ascii=True))
else:
    root = Path(os.environ["BLOMA_SPEECH_MODEL_DIR"]) / "tts-vits-zh"
    tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(vits=sherpa_onnx.OfflineTtsVitsModelConfig(
            model=str(root / "model.onnx"), tokens=str(root / "tokens.txt"),
            lexicon=str(root / "lexicon.txt"), dict_dir=str(root / "dict")),
            num_threads=2, provider="cpu"),
        rule_fsts=",".join(str(root / name) for name in ["date.fst", "number.fst", "phone.fst", "new_heteronym.fst"]),
        max_num_sentences=2))
    audio = tts.generate(request["text"], sid=0, speed=1)
    samples = (np.clip(np.asarray(audio.samples), -1, 1) * 32767).astype("<i2")
    if not samples.size:
        raise ValueError("语音合成结果为空")
    with wave.open(request["file"], "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(audio.sample_rate)
        output.writeframes(samples.tobytes())
    print(json.dumps({"duration": samples.size / audio.sample_rate}))
