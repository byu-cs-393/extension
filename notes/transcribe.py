import os
import sys
import time
import sysconfig
from pathlib import Path

site_pkgs = Path(sysconfig.get_paths()["purelib"])
extra_paths = []
for sub in ("nvidia/cublas/bin", "nvidia/cudnn/bin"):
    p = site_pkgs / sub
    if p.is_dir():
        os.add_dll_directory(str(p))
        extra_paths.append(str(p))
if extra_paths:
    os.environ["PATH"] = os.pathsep.join(extra_paths) + os.pathsep + os.environ.get("PATH", "")
    print(f"Prepended to PATH: {extra_paths}", flush=True)
    cublas_dll = site_pkgs / "nvidia/cublas/bin/cublas64_12.dll"
    print(f"cublas64_12.dll exists: {cublas_dll.is_file()}", flush=True)

from faster_whisper import WhisperModel

audio_path = sys.argv[1]
out_path = sys.argv[2]
model_size = sys.argv[3] if len(sys.argv) > 3 else "small"

device = "cuda"
compute_type = "float16"
try:
    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    print(f"Loaded {model_size} on {device}/{compute_type}", flush=True)
except Exception as e:
    print(f"GPU init failed ({e}); falling back to CPU int8", flush=True)
    device = "cpu"
    compute_type = "int8"
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

start = time.time()
segments, info = model.transcribe(
    audio_path,
    beam_size=5,
    vad_filter=True,
    vad_parameters=dict(min_silence_duration_ms=500),
)
print(f"Language: {info.language} (prob {info.language_probability:.2f}); duration {info.duration:.1f}s", flush=True)

lines = []
for seg in segments:
    ts = f"[{int(seg.start//60):02d}:{int(seg.start%60):02d}]"
    lines.append(f"{ts} {seg.text.strip()}")
    if len(lines) % 25 == 0:
        elapsed = time.time() - start
        print(f"...{len(lines)} segments, {seg.end:.0f}s of audio, elapsed {elapsed:.0f}s", flush=True)

Path(out_path).write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"Done. {len(lines)} segments in {time.time()-start:.0f}s -> {out_path}", flush=True)
