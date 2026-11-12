#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""System-audio capture, low-latency speech recognition and a click-through overlay.

The Python engine owns capture, faster-whisper recognition and the desktop overlay.
The Host plugin owns translation and the Web panel.  Speech is transcribed in small
draft windows while the person is still talking, so translated subtitles update
before the next line begins.
"""

from __future__ import annotations

# Anaconda's MKL and ctranslate2 both ship an OpenMP runtime.  Allowing the
# duplicate only affects this helper process and is required for Whisper on the
# Windows Python distribution used by many Harness users.
import os

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import argparse
import base64
import io
import json
import queue
import sys
import threading
import time
import traceback
import urllib.request
import wave
from collections import deque
from typing import Any

try:
    import numpy as np
except Exception as exc:  # pragma: no cover - reported through JSON
    np = None
    _NUMPY_ERROR = exc
else:
    _NUMPY_ERROR = None

try:
    import soundcard as sc
except Exception as exc:  # pragma: no cover - reported through JSON
    sc = None
    _SOUNDCARD_ERROR = exc
else:
    _SOUNDCARD_ERROR = None

try:
    import webrtcvad
except Exception:  # pragma: no cover - optional
    webrtcvad = None


SAMPLE_RATE = 16000
BLOCK_FRAMES = 1600           # 100 ms audio blocks
VAD_FRAME = 480               # 30 ms
PREROLL_FRAMES = 10           # 300 ms before speech onset
PARTIAL_EVERY_FRAMES = 12     # about 360 ms
END_SILENCE_FRAMES = 9        # 270 ms
MAX_SEGMENT_FRAMES = 117      # about 3.5 s
MIN_SEGMENT_FRAMES = 10       # about 0.3 s

MODEL_REPO = "Systran/faster-whisper-base"
MODEL_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")
MODEL_ORIGIN = os.environ.get("DSH_ASR_MODEL_ORIGIN", "https://hf-mirror.com")


def now_ms() -> int:
    return int(time.time() * 1000)


def emit(payload: dict[str, Any]) -> None:
    """Write one JSON event without letting a broken pipe kill the process."""
    try:
        with _EMIT_LOCK:
            sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    except Exception:
        pass


_EMIT_LOCK = threading.Lock()


def log(message: str) -> None:
    try:
        sys.stderr.write(f"[realtime-subtitles] {message}\n")
        sys.stderr.flush()
    except Exception:
        pass


def pcm_to_wav(frames: list[Any]) -> bytes:
    if not frames:
        return b""
    pcm = np.concatenate(frames, axis=0)
    if pcm.ndim > 1:
        pcm = pcm[:, 0]
    pcm16 = np.clip(pcm, -1.0, 1.0)
    pcm16 = (pcm16 * 32767.0).astype(np.int16)
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm16.tobytes())
    return out.getvalue()


def rms_level(block: Any) -> float:
    if block.size == 0:
        return 0.0
    mono = block[:, 0] if block.ndim > 1 else block
    rms = float(np.sqrt(np.mean(np.square(mono, dtype=np.float64))))
    # Map a useful speech range to 0..1 for the UI meter.
    value = (rms - 0.002) / 0.16
    return max(0.0, min(1.0, value))


def _asset_size(path: str) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def ensure_whisper_model(model_dir: str, repo: str = MODEL_REPO, origin: str = MODEL_ORIGIN) -> None:
    """Download the CTranslate2 Whisper files once, with visible progress."""
    os.makedirs(model_dir, exist_ok=True)
    for name in MODEL_FILES:
        dest = os.path.join(model_dir, name)
        current = _asset_size(dest)
        minimum = 1_000_000 if name == "model.bin" else 32
        if current >= minimum:
            continue
        url = f"{origin.rstrip('/')}/{repo}/resolve/main/{name}"
        emit({
            "type": "asr-prepare",
            "phase": "downloading",
            "resource": name,
            "completedBytes": 0,
            "totalBytes": 0,
            "message": f"正在下载语音模型 {name}…",
        })
        tmp = f"{dest}.part"
        request = urllib.request.Request(url, headers={"User-Agent": "DSH-Realtime-Subtitles/1.1"})
        last_report = 0.0
        completed = 0
        with urllib.request.urlopen(request, timeout=120) as response, open(tmp, "wb") as out:
            try:
                total = int(response.headers.get("Content-Length") or 0)
            except Exception:
                total = 0
            while True:
                block = response.read(1024 * 256)
                if not block:
                    break
                out.write(block)
                completed += len(block)
                now = time.time()
                if now - last_report >= 0.4:
                    last_report = now
                    emit({
                        "type": "asr-prepare",
                        "phase": "downloading",
                        "resource": name,
                        "completedBytes": completed,
                        "totalBytes": total,
                        "message": f"正在下载语音模型 {name}…",
                    })
        if completed < minimum:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise RuntimeError(f"语音模型文件不完整：{name}")
        os.replace(tmp, dest)


class LocalAsr:
    """faster-whisper on CPU, optimized for short draft windows."""

    def __init__(self, model_dir: str, repo: str, device: str = "cpu", compute_type: str = "int8") -> None:
        self.model_dir = model_dir
        self.repo = repo
        self.device = device if device in ("cpu", "cuda") else "cpu"
        self.compute_type = compute_type
        self.model: Any = None
        self.lock = threading.Lock()

    def prepare(self) -> None:
        ensure_whisper_model(self.model_dir, self.repo)
        emit({"type": "asr-prepare", "phase": "loading", "message": "正在加载 Whisper 识别模型…"})
        try:
            from faster_whisper import WhisperModel
        except Exception as exc:
            raise RuntimeError(
                "faster-whisper 尚未安装。请运行：python -m pip install --user "
                "faster-whisper==1.2.1 ctranslate2==4.5.0"
            ) from exc
        try:
            self.model = WhisperModel(
                self.model_dir,
                device=self.device,
                compute_type=self.compute_type,
                cpu_threads=8,
                num_workers=1,
            )
        except Exception:
            if self.device == "cpu":
                raise
            # A missing CUDA runtime should not disable subtitles.
            self.device = "cpu"
            self.compute_type = "int8"
            self.model = WhisperModel(
                self.model_dir,
                device="cpu",
                compute_type="int8",
                cpu_threads=8,
                num_workers=1,
            )
        emit({
            "type": "asr-prepare",
            "phase": "ready",
            "message": "语音识别模型已就绪",
            "device": self.device,
        })

    def transcribe(self, audio: bytes, language: str) -> str:
        with wave.open(io.BytesIO(audio), "rb") as wav:
            raw = wav.readframes(wav.getnframes())
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        language_arg = None if language == "auto" else language
        with self.lock:
            segments, _info = self.model.transcribe(
                samples,
                language=language_arg,
                beam_size=1,
                best_of=1,
                temperature=0.0,
                vad_filter=False,
                condition_on_previous_text=False,
                without_timestamps=True,
                word_timestamps=False,
            )
            return "".join(segment.text for segment in segments).strip()


class AsrWorker:
    """Serialize Whisper calls while preferring final windows over drafts.

    Draft windows use the tiny model (about 0.2 s per call) and finals use the
    base model (about 0.4 s), keeping the displayed draft close to live speech.
    """

    def __init__(self, asr: LocalAsr, draft: LocalAsr | None, language: str) -> None:
        self.asr = asr
        self.draft = draft
        self.language = language
        self.items: list[dict[str, Any]] = []
        self.condition = threading.Condition()
        self.stop_requested = False
        self.thread = threading.Thread(target=self._run, name="asr", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        with self.condition:
            self.stop_requested = True
            self.condition.notify_all()

    def submit(self, chunk: dict[str, Any]) -> None:
        with self.condition:
            if chunk.get("final"):
                self.items = [item for item in self.items if item.get("final")]
                self.items.append(chunk)
            else:
                segment_id = chunk.get("segmentId", 0)
                self.items = [
                    item for item in self.items
                    if item.get("final") or item.get("segmentId", 0) > segment_id
                ]
                self.items.append(chunk)
            self.condition.notify()

    def _run(self) -> None:
        while True:
            with self.condition:
                while not self.items and not self.stop_requested:
                    self.condition.wait(0.2)
                if self.stop_requested:
                    return
                chunk = self.items.pop(0)
            started = time.time()
            try:
                model = self.asr if chunk.get("final") or self.draft is None else self.draft
                text = model.transcribe(
                    base64.b64decode(chunk.get("audio", "")),
                    chunk.get("language") or self.language,
                )
            except Exception as exc:
                emit({"type": "asr-error", "message": str(exc)})
                continue
            emit({
                "type": "transcript",
                "final": bool(chunk.get("final")),
                "segmentId": chunk.get("segmentId", 0),
                "language": chunk.get("language") or self.language,
                "text": text,
                "durationMs": chunk.get("durationMs", 0),
                "asrMs": int((time.time() - started) * 1000),
            })


class Segmenter:
    """Energy/WebRTC VAD state machine producing bounded WAV payloads."""

    def __init__(self, language: str, vad_aggressiveness: int = 2) -> None:
        self.language = language
        self.vad = webrtcvad.Vad(vad_aggressiveness) if webrtcvad is not None else None
        self.energy_threshold = 0.0075
        self.pre: deque[Any] = deque(maxlen=PREROLL_FRAMES)
        self.reset()

    def reset(self) -> None:
        self.active = False
        self.speech_run = 0
        self.silence_run = 0
        self.seg_frames: list[Any] = []
        self.last_partial_at = 0
        self.segment_id = 0
        self.started_at = 0.0

    def _is_speech(self, frame: Any) -> bool:
        if self.vad is not None:
            try:
                pcm = np.clip(frame[:, 0] if frame.ndim > 1 else frame, -1.0, 1.0)
                data = (pcm * 32767.0).astype(np.int16).tobytes()
                if len(data) == VAD_FRAME * 2:
                    return bool(self.vad.is_speech(data, SAMPLE_RATE))
            except Exception:
                pass
        mono = frame[:, 0] if frame.ndim > 1 else frame
        return float(np.sqrt(np.mean(np.square(mono, dtype=np.float64)))) >= self.energy_threshold

    def _final_payload(self, frames: list[Any]) -> dict[str, Any]:
        wav = pcm_to_wav(frames)
        return {
            "type": "chunk",
            "final": True,
            "segmentId": self.segment_id,
            "language": self.language,
            "startedAt": now_ms(),
            "audio": base64.b64encode(wav).decode("ascii"),
            "durationMs": int(len(frames) * 30),
        }

    def _partial_payload(self, frames: list[Any]) -> dict[str, Any]:
        wav = pcm_to_wav(frames)
        return {
            "type": "chunk",
            "final": False,
            "segmentId": self.segment_id,
            "language": self.language,
            "startedAt": now_ms(),
            "audio": base64.b64encode(wav).decode("ascii"),
            "durationMs": int(len(frames) * 30),
        }

    def push(self, frames: list[Any]) -> list[dict[str, Any]]:
        """Consume 30 ms frames and return chunk events."""
        events: list[dict[str, Any]] = []
        for frame in frames:
            speech = self._is_speech(frame)
            level = rms_level(frame)

            if not self.active:
                self.pre.append(frame)
                if speech:
                    self.speech_run += 1
                else:
                    self.speech_run = 0
                if self.speech_run >= 2:
                    self.active = True
                    self.started_at = time.time()
                    self.seg_frames = list(self.pre)
                    self.pre.clear()
                    self.silence_run = 0
                    self.speech_run = 0
                    self.last_partial_at = len(self.seg_frames)
                    events.append({"type": "speech", "speaking": True, "level": level})
                continue

            self.seg_frames.append(frame)
            if speech:
                self.silence_run = 0
            else:
                self.silence_run += 1

            should_end = (
                self.silence_run >= END_SILENCE_FRAMES
                or len(self.seg_frames) >= MAX_SEGMENT_FRAMES
            )
            if should_end:
                frames_out = self.seg_frames[:]
                if self.silence_run >= END_SILENCE_FRAMES:
                    trim = min(self.silence_run, 6)
                    frames_out = frames_out[:-trim] if len(frames_out) > trim else frames_out
                if len(frames_out) >= MIN_SEGMENT_FRAMES:
                    events.append(self._final_payload(frames_out))
                self.segment_id += 1
                tail = self.seg_frames[-PREROLL_FRAMES:]
                self.active = False
                self.speech_run = 0
                self.silence_run = 0
                self.seg_frames = []
                self.pre.clear()
                self.pre.extend(tail)
                events.append({"type": "speech", "speaking": False, "level": level})
                continue

            frames_since_partial = len(self.seg_frames) - self.last_partial_at
            if (
                len(self.seg_frames) >= 18
                and frames_since_partial >= PARTIAL_EVERY_FRAMES
            ):
                self.last_partial_at = len(self.seg_frames)
                events.append(self._partial_payload(self.seg_frames[:]))

        return events


class Overlay:
    """Borderless, click-through, always-on-top subtitle window owned by the Tk thread."""

    def __init__(self, font_size: int, opacity: float, position: str) -> None:
        self.font_size = max(14, min(72, int(font_size)))
        self.opacity = max(0.25, min(1.0, float(opacity)))
        self.position = position if position in ("bottom", "top") else "bottom"
        self.visible = False
        self.hide_after_ms = 6500
        self.after_id: str | None = None
        self.events: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.root: Any = None
        self.frame: Any = None
        self.translation_label: Any = None
        self.source_label: Any = None
        self.error: str | None = None
        self.done = threading.Event()

    def run(self) -> None:
        """Create and run the overlay on the calling (main) thread.

        Tkinter must be created, driven and destroyed on one thread.  Keeping it on
        the process main thread avoids Tcl's "async handler deleted by the wrong
        thread" error during interpreter shutdown.
        """
        try:
            import tkinter as tk

            root = tk.Tk()
            self.root = root
            root.withdraw()
            root.overrideredirect(True)
            root.attributes("-topmost", True)
            root.attributes("-alpha", self.opacity)
            root.configure(bg="#08090c")

            frame = tk.Frame(root, bg="#08090c", padx=28, pady=18)
            frame.pack(fill="both", expand=True)
            self.frame = frame
            self.translation_label = tk.Label(
                frame,
                text="",
                fg="#ffffff",
                bg="#08090c",
                font=("Microsoft YaHei UI", self.font_size, "bold"),
                justify="center",
                anchor="center",
                wraplength=1100,
            )
            self.translation_label.pack(fill="x")
            self.source_label = tk.Label(
                frame,
                text="",
                fg="#c8cbd4",
                bg="#08090c",
                font=("Microsoft YaHei UI", max(12, self.font_size - 8)),
                justify="center",
                anchor="center",
                wraplength=1100,
            )
            self.source_label.pack(fill="x", pady=(6, 0))

            root.after(60, self._apply_click_through)
            root.after(40, self._drain)
            root.mainloop()
        except Exception as exc:  # pragma: no cover - environment dependent
            self.error = str(exc)
            log(f"overlay failed: {exc}")
            emit({"type": "overlay-error", "message": str(exc)})
        finally:
            self.done.set()

    def _apply_click_through(self) -> None:
        """Let clicks pass through the overlay on Windows."""
        try:
            import ctypes

            hwnd = ctypes.windll.user32.GetParent(self.root.winfo_id())
            style = ctypes.windll.user32.GetWindowLongW(hwnd, -20)
            style |= 0x00080000  # WS_EX_LAYERED
            style |= 0x00000020  # WS_EX_TRANSPARENT
            style |= 0x08000000  # WS_EX_NOACTIVATE
            ctypes.windll.user32.SetWindowLongW(hwnd, -20, style)
        except Exception:
            pass

    def _schedule_hide(self) -> None:
        if self.after_id is not None:
            try:
                self.root.after_cancel(self.after_id)
            except Exception:
                pass
        self.after_id = self.root.after(self.hide_after_ms, self.hide)

    def show(self, translation: str, source: str) -> None:
        self.events.put(("show", (translation, source)))

    def set_visible(self, visible: bool) -> None:
        self.events.put(("visible", bool(visible)))

    def configure(self, font_size: int | None = None, position: str | None = None) -> None:
        self.events.put(("configure", (font_size, position)))

    def hide(self) -> None:
        self.events.put(("hide", None))

    def quit(self) -> None:
        self.events.put(("quit", None))

    def _drain(self) -> None:
        if self.root is None:
            return
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "show":
                    self._show_now(*value)
                elif kind == "visible":
                    self.visible = bool(value)
                    if not self.visible:
                        self._hide_now()
                elif kind == "hide":
                    self._hide_now()
                elif kind == "configure":
                    self._configure_now(*value)
                elif kind == "quit":
                    try:
                        self.root.destroy()
                    except Exception:
                        pass
                    return
        except queue.Empty:
            pass
        try:
            self.root.after(40, self._drain)
        except Exception:
            pass

    def _show_now(self, translation: str, source: str) -> None:
        if self.root is None:
            return
        self.translation_label.configure(text=translation or "")
        self.source_label.configure(text=source or "")
        self.source_label.pack_configure(pady=(6, 0) if source else (0, 0))
        self._place()
        if self.visible:
            try:
                self.root.deiconify()
                self.root.attributes("-topmost", True)
                self._apply_click_through()
            except Exception:
                pass
        self._schedule_hide()

    def _configure_now(self, font_size: int | None, position: str | None) -> None:
        if font_size is not None:
            self.font_size = max(14, min(72, int(font_size)))
            try:
                self.translation_label.configure(
                    font=("Microsoft YaHei UI", self.font_size, "bold")
                )
                self.source_label.configure(
                    font=("Microsoft YaHei UI", max(12, self.font_size - 8))
                )
            except Exception:
                pass
        if position in ("bottom", "top"):
            self.position = position
        self._place()

    def _place(self) -> None:
        if self.root is None:
            return
        try:
            self.root.update_idletasks()
            screen_w = self.root.winfo_screenwidth()
            screen_h = self.root.winfo_screenheight()
            width = max(520, int(screen_w * 0.78))
            try:
                self.translation_label.configure(wraplength=width - 64)
                self.source_label.configure(wraplength=width - 64)
                self.root.update_idletasks()
                needed = int(self.frame.winfo_reqheight()) + 12
            except Exception:
                needed = int(self.font_size * 4.4) + 44
            height = max(140, min(int(screen_h * 0.34), needed))
            x = max(0, (screen_w - width) // 2)
            if self.position == "top":
                y = max(24, int(screen_h * 0.08))
            else:
                y = max(0, screen_h - height - max(48, int(screen_h * 0.055)))
            self.root.geometry(f"{width}x{height}+{x}+{y}")
            try:
                self.translation_label.configure(wraplength=width - 64)
                self.source_label.configure(wraplength=width - 64)
            except Exception:
                pass
        except Exception:
            pass

    def _hide_now(self) -> None:
        try:
            if self.root is not None:
                self.root.withdraw()
        except Exception:
            pass


class Engine:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.stop = threading.Event()
        self.speaking = False
        self.overlay = Overlay(args.font_size, args.opacity, args.position)
        self.capture_thread: threading.Thread | None = None
        self.reader_thread: threading.Thread | None = None
        self.asr: LocalAsr | None = None
        self.asr_worker: AsrWorker | None = None
        self.stats = {"blocks": 0, "speechChunks": 0, "lastError": None}

    # ---------------------------------------------------------------- control
    def start(self) -> None:
        self.reader_thread = threading.Thread(target=self._read_stdin, name="control", daemon=True)
        self.reader_thread.start()

        if self.args.asr_model_dir:
            emit({"type": "asr-prepare", "phase": "checking", "message": "正在检查本地 Whisper 模型…"})
            try:
                self.asr = LocalAsr(
                    self.args.asr_model_dir,
                    self.args.asr_repo,
                    self.args.asr_device,
                    self.args.asr_compute,
                )
                self.asr.prepare()
                draft = None
                if self.args.asr_draft_model_dir:
                    draft = LocalAsr(
                        self.args.asr_draft_model_dir,
                        self.args.asr_draft_repo,
                        self.args.asr_device,
                        self.args.asr_compute,
                    )
                    draft.prepare()
                self.asr_worker = AsrWorker(self.asr, draft, self.args.lang)
                self.asr_worker.start()
            except Exception as exc:
                log(traceback.format_exc())
                emit({"type": "asr-error", "message": str(exc)})
                self.stop.set()
                return

        self.capture_thread = threading.Thread(target=self._capture_loop, name="capture", daemon=True)
        self.capture_thread.start()
        emit({
            "type": "ready",
            "device": self.args.device or "",
            "language": self.args.lang,
            "vad": "webrtc" if webrtcvad is not None else "energy",
            "asr": "faster-whisper" if self.asr is not None else "none",
            "asrDevice": self.asr.device if self.asr is not None else "",
            "python": sys.version.split()[0],
        })
        self.overlay.run()
        # If the overlay cannot start (for example a Python build without Tk),
        # keep capturing so the in-app subtitle stream still works.
        while not self.stop.is_set():
            self.stop.wait(0.4)
        self.stop.set()
        if self.asr_worker is not None:
            self.asr_worker.stop()

    def _read_stdin(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                command = json.loads(line)
            except Exception:
                continue
            kind = command.get("cmd")
            if kind == "subtitle":
                self.overlay.show(
                    str(command.get("translation") or ""),
                    str(command.get("source") or ""),
                )
            elif kind == "overlay":
                if "visible" in command:
                    self.overlay.set_visible(bool(command["visible"]))
                if "fontSize" in command or "position" in command:
                    self.overlay.configure(command.get("fontSize"), command.get("position"))
                if "opacity" in command:
                    try:
                        self.overlay.opacity = max(0.25, min(1.0, float(command["opacity"])))
                    except Exception:
                        pass
                if command.get("visible") and command.get("text"):
                    self.overlay.show(str(command.get("text")), str(command.get("source") or ""))
            elif kind == "hide":
                self.overlay.hide()
            elif kind == "quit":
                self.stop.set()
                self.overlay.quit()
                return

    # ---------------------------------------------------------------- capture
    def _find_loopback(self) -> Any:
        if sc is None:
            raise RuntimeError(f"soundcard is unavailable: {_SOUNDCARD_ERROR}")
        if np is None:
            raise RuntimeError(f"numpy is unavailable: {_NUMPY_ERROR}")
        requested = (self.args.device or "").strip()
        if requested:
            wanted = requested.casefold()
            for mic in sc.all_microphones(include_loopback=True):
                if wanted in str(mic.name).casefold():
                    return mic
            for speaker in sc.all_speakers():
                if wanted in str(speaker.name).casefold():
                    return sc.get_microphone(id=str(speaker.name), include_loopback=True)
            raise RuntimeError(f"找不到音频设备：{requested}")
        speaker = sc.default_speaker()
        return sc.get_microphone(id=str(speaker.name), include_loopback=True)

    def _capture_loop(self) -> None:
        try:
            mic = self._find_loopback()
        except Exception as exc:
            self.stats["lastError"] = str(exc)
            emit({"type": "error", "code": "audio-device", "message": str(exc)})
            return

        emit({"type": "audio-device", "name": str(mic.name)})
        segmenter = Segmenter(self.args.lang)
        level_at = 0.0
        last_speech_emit = 0.0
        try:
            with mic.recorder(samplerate=SAMPLE_RATE, channels=1, blocksize=BLOCK_FRAMES) as recorder:
                while not self.stop.is_set():
                    block = recorder.record(numframes=BLOCK_FRAMES)
                    if block is None or len(block) == 0:
                        continue
                    self.stats["blocks"] += 1
                    level = rms_level(block)
                    now = time.time()
                    if now - level_at >= 0.2:
                        level_at = now
                        emit({"type": "level", "level": round(level, 3)})
                    if now - last_speech_emit >= 1.0 and self.speaking:
                        last_speech_emit = now
                        emit({"type": "speech", "speaking": True, "level": level})

                    # Split the 100 ms block into 30 ms VAD frames.
                    frames = []
                    for start in range(0, len(block), VAD_FRAME):
                        frame = block[start:start + VAD_FRAME]
                        if len(frame) == VAD_FRAME:
                            frames.append(frame)
                    for event in segmenter.push(frames):
                        if event.get("type") == "speech":
                            self.speaking = bool(event.get("speaking"))
                            if self.speaking:
                                last_speech_emit = time.time()
                            emit(event)
                        elif event.get("type") == "chunk":
                            self.stats["speechChunks"] += 1
                            if self.asr_worker is not None:
                                self.asr_worker.submit(event)
                            else:
                                emit(event)
        except Exception as exc:
            self.stats["lastError"] = str(exc)
            log(traceback.format_exc())
            emit({"type": "error", "code": "capture", "message": str(exc)})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lang", default="ja", choices=["ja", "en", "auto"])
    parser.add_argument("--device", default="")
    parser.add_argument("--font-size", type=int, default=30)
    parser.add_argument("--opacity", type=float, default=0.9)
    parser.add_argument("--position", default="bottom", choices=["bottom", "top"])
    parser.add_argument("--asr-model-dir", default="")
    parser.add_argument("--asr-repo", default="Systran/faster-whisper-base")
    parser.add_argument("--asr-draft-model-dir", default="")
    parser.add_argument("--asr-draft-repo", default="Systran/faster-whisper-tiny")
    parser.add_argument("--asr-device", default="cpu", choices=["cpu", "cuda", "auto"])
    parser.add_argument("--asr-compute", default="int8")
    args = parser.parse_args()

    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
    except Exception:
        pass

    engine = Engine(args)
    engine.start()
    engine.stop.set()
    engine.overlay.quit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
