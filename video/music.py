"""Original minimal ambient music, synthesized locally; no samples or vocals."""
from pathlib import Path
import argparse
import json
import math
import wave
import numpy as np

SOURCE = Path(__file__).resolve().parent
OUT = SOURCE.parent / "brag-output" / "v3"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("duration", nargs="?", type=float,
                    help="Track duration in seconds; defaults to captions.json duration or 65.")
args = parser.parse_args()
duration = args.duration
if duration is None:
    metadata = json.loads((SOURCE / "captions.json").read_text(encoding="utf-8"))
    duration = metadata.get("duration", 65.0)
if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 1:
    parser.error("duration must be a finite number of at least one second")
OUT.mkdir(parents=True, exist_ok=True)
SR, DURATION, BPM = 48000, float(duration), 88.0
N = int(SR * DURATION)
mix = np.zeros((N, 2), dtype=np.float64)
beat = 60 / BPM
bar = 4 * beat

def hz(midi):
    return 440 * 2 ** ((midi - 69) / 12)

def add(start, length, midi, amp, kind="pad", pan=0.0):
    offset = round(start * SR)
    count = min(round(length * SR), N - offset)
    if count <= 0:
        return
    t = np.arange(count) / SR
    freq = hz(midi)
    if kind == "pad":
        env = np.minimum(1, t / 0.65) * np.minimum(1, np.maximum(0, (length - t) / 1.1))
        vibrato = .001 * np.sin(2 * np.pi * .15 * t)
        signal = (np.sin(2 * np.pi * freq * t + vibrato) + .13 * np.sin(4 * np.pi * freq * t)) * env
    elif kind == "pluck":
        env = (1 - np.exp(-t * 70)) * np.exp(-t * 2.7)
        signal = (np.sin(2 * np.pi * freq * t) + .08 * np.sin(4 * np.pi * freq * t)) * env
    elif kind == "bass":
        env = (1 - np.exp(-t * 9)) * np.exp(-t * 1.7)
        signal = np.sin(2 * np.pi * freq * t) * env
    gain_l = np.sqrt((1 - pan) / 2)
    gain_r = np.sqrt((1 + pan) / 2)
    mix[offset:offset+count, 0] += signal * amp * gain_l
    mix[offset:offset+count, 1] += signal * amp * gain_r

# Dmaj9, Bm7, Gmaj7, Aadd9: open gentle voicings, two bars per chord.
chords = [[50, 57, 61, 64], [47, 54, 57, 62], [43, 54, 59, 62], [45, 52, 59, 61]]
roots = [38, 35, 31, 33]
melody = [[73, 76, 69], [74, 69, 66], [71, 74, 69], [73, 71, 76]]
chord_length = 2 * bar
for i in range(int(np.ceil(DURATION / chord_length))):
    start = i * chord_length
    for j, note in enumerate(chords[i % 4]):
        add(start, chord_length + 1.05, note, .2, pan=(-.4 + j * .27))
        add(start + .04, chord_length + 1.05, note + 12, .018, pan=(.4 - j * .27))
    for pulse in [0, 4]:
        add(start + pulse * beat, 2.0, roots[i % 4], .12, "bass")
    # Sparse soft motif, no percussion or sharp transients beneath speech.
    for j, note in enumerate(melody[i % 4]):
        onset = start + (1.5 + j * 2) * beat
        add(onset, 2.5, note, .11, "pluck", -.25 if j % 2 else .25)
        add(onset + .375, 2.5, note, .025, "pluck", .3 if j % 2 else -.3)

time = np.arange(N) / SR
fade = np.minimum(1, time / 1.5) * np.minimum(1, (DURATION - time) / 3)
mix *= fade[:, None]
target_rms_db = -32.0
rms = np.sqrt(np.mean(mix * mix))
mix *= 10 ** (target_rms_db / 20) / rms
peak = float(np.max(np.abs(mix)))
pcm = np.clip(np.round(mix * 32767), -32768, 32767).astype("<i2")
with wave.open(str(OUT / "music-bed.wav"), "wb") as wav:
    wav.setnchannels(2)
    wav.setsampwidth(2)
    wav.setframerate(SR)
    wav.writeframes(pcm.tobytes())
metadata = {"duration": DURATION, "sampleRate": SR, "channels": 2,
            "rmsDbfs": target_rms_db, "peakDbfs": round(20 * np.log10(peak), 2),
            "bpm": BPM, "origin": "Original procedural synthesis; no samples, voices, or licensed recordings",
            "fadeInSeconds": 1.5, "fadeOutSeconds": 3.0}
(OUT / "music-bed.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
print(json.dumps(metadata, indent=2))
