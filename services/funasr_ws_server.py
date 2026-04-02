import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from funasr import AutoModel
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

try:
    import openwakeword
    from openwakeword.model import Model as OpenWakeWordModel
except ImportError:
    openwakeword = None
    OpenWakeWordModel = None


def load_env_file():
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.is_file():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        if line.startswith("export "):
            line = line[7:].strip()

        if "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue

        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]

        os.environ[key] = value.replace("\\n", "\n")


load_env_file()


def get_env(keys, fallback=""):
    for key in keys:
        value = os.environ.get(key)
        if value not in (None, ""):
            return value
    return fallback


HOST = os.environ.get("FUNASR_WS_HOST", "127.0.0.1")
PORT = int(os.environ.get("FUNASR_WS_PORT", "10096"))
MODEL_NAME = os.environ.get("FUNASR_MODEL", "paraformer-zh-streaming")
CHUNK_SIZE = [int(x) for x in os.environ.get("FUNASR_CHUNK_SIZE", "0,8,4").split(",")]
ENCODER_LOOK_BACK = int(os.environ.get("FUNASR_ENCODER_LOOK_BACK", "4"))
DECODER_LOOK_BACK = int(os.environ.get("FUNASR_DECODER_LOOK_BACK", "1"))
SAMPLE_RATE = int(os.environ.get("FUNASR_SAMPLE_RATE", "16000"))
CHUNK_STRIDE_SAMPLES = int(CHUNK_SIZE[1] * SAMPLE_RATE * 0.06)
CHUNK_STRIDE_BYTES = CHUNK_STRIDE_SAMPLES * 2
SIGNAL_RMS_THRESHOLD = float(os.environ.get("FUNASR_SIGNAL_RMS_THRESHOLD", "0.003"))
SIGNAL_PEAK_THRESHOLD = int(os.environ.get("FUNASR_SIGNAL_PEAK_THRESHOLD", "256"))
OPENWAKEWORD_MODEL = os.environ.get("OPENWAKEWORD_MODEL", "hey_jarvis").strip().lower()
OPENWAKEWORD_MODEL_PATH = os.environ.get("OPENWAKEWORD_MODEL_PATH", "").strip()
OPENWAKEWORD_THRESHOLD = float(os.environ.get("OPENWAKEWORD_THRESHOLD", "0.5"))
OPENWAKEWORD_PATIENCE = int(os.environ.get("OPENWAKEWORD_PATIENCE", "1"))
OPENWAKEWORD_VAD_THRESHOLD = float(os.environ.get("OPENWAKEWORD_VAD_THRESHOLD", "0"))
OPENWAKEWORD_ENABLE_SPEEX = os.environ.get("OPENWAKEWORD_ENABLE_SPEEX", "false").lower() == "true"


logging.basicConfig(level=logging.INFO, format="[funasr-ws] %(message)s")
logger = logging.getLogger("funasr-ws")


@dataclass
class SessionState:
    cache: dict = field(default_factory=dict)
    chunk_index: int = 0
    final_text: str = ""
    partial_text: str = ""
    transcript_text: str = ""
    sample_rate: int = SAMPLE_RATE
    pending_pcm: bytearray = field(default_factory=bytearray)
    wake_buffer: bytearray = field(default_factory=bytearray)
    audio_bytes: int = 0
    signal_detected: bool = False
    wake_word_enabled: bool = False
    wake_word_detected: bool = False
    wake_word_label: str = ""
    wake_model_key: str = ""
    wake_detector: object | None = None
    wake_frame_length: int = 1280
    wake_consecutive_hits: int = 0


OPENWAKEWORD_MODELS = {}
if openwakeword is not None:
    OPENWAKEWORD_MODELS = dict(openwakeword.models)


def openwakeword_config_status() -> tuple[bool, str]:
    if openwakeword is None or OpenWakeWordModel is None:
        return False, "openWakeWord is not installed."

    if OPENWAKEWORD_MODEL_PATH and not os.path.exists(OPENWAKEWORD_MODEL_PATH):
        return False, f"Model file not found: {OPENWAKEWORD_MODEL_PATH}"

    if not OPENWAKEWORD_MODEL_PATH and OPENWAKEWORD_MODEL not in OPENWAKEWORD_MODELS:
        return False, f"Unsupported wake word model: {OPENWAKEWORD_MODEL!r}."

    return True, "ok"


def humanize_wake_label(label: str) -> str:
    text = os.path.splitext(os.path.basename(label))[0]
    text = text.replace("_v0.1", "")
    text = text.replace("_", " ").strip()
    return text


def create_wake_detector():
    configured, reason = openwakeword_config_status()
    if not configured:
        raise RuntimeError(reason)

    if OPENWAKEWORD_MODEL_PATH:
        model_path = OPENWAKEWORD_MODEL_PATH
        wake_word_label = humanize_wake_label(model_path)
    else:
        model_path = OPENWAKEWORD_MODELS[OPENWAKEWORD_MODEL]["model_path"]
        wake_word_label = humanize_wake_label(OPENWAKEWORD_MODEL)

    detector = OpenWakeWordModel(
        wakeword_model_paths=[model_path],
        vad_threshold=OPENWAKEWORD_VAD_THRESHOLD,
        enable_speex_noise_suppression=OPENWAKEWORD_ENABLE_SPEEX,
    )
    wake_model_key = next(iter(detector.models.keys()))
    return detector, wake_model_key, wake_word_label


def normalize_result(result) -> str:
    if not result:
        return ""

    if isinstance(result, dict):
        text = result.get("text", "")
        if isinstance(text, str):
            return text.strip()
        return ""

    if isinstance(result, list):
        collected_text = []

        for item in reversed(result):
            if isinstance(item, dict):
                text = item.get("text", "")
                if isinstance(text, str) and text.strip():
                    collected_text.append(text.strip())
                continue

            if isinstance(item, str) and item.strip():
                collected_text.append(item.strip())

        if collected_text:
            return " ".join(reversed(collected_text)).strip()

        return ""

    if isinstance(result, str):
        return result.strip()

    return ""


logger.info("loading model %s", MODEL_NAME)
model = AutoModel(model=MODEL_NAME)
logger.info("model loaded")


async def send_json(websocket, payload: dict):
    await websocket.send(json.dumps(payload, ensure_ascii=False))


def reset_asr_state(state: SessionState):
    state.cache = {}
    state.chunk_index = 0
    state.final_text = ""
    state.partial_text = ""
    state.transcript_text = ""
    state.pending_pcm.clear()
    state.audio_bytes = 0
    state.signal_detected = False
    state.wake_consecutive_hits = 0


def has_signal(pcm_int16: np.ndarray) -> bool:
    if pcm_int16.size == 0:
        return False

    peak = int(np.max(np.abs(pcm_int16)))
    rms = float(np.sqrt(np.mean(np.square(pcm_int16.astype(np.float32) / 32768.0))))
    return peak >= SIGNAL_PEAK_THRESHOLD or rms >= SIGNAL_RMS_THRESHOLD


def merge_transcript(existing: str, incoming: str) -> str:
    left = str(existing or "").strip()
    right = str(incoming or "").strip()

    if not right:
        return left

    if not left:
        return right

    if right.startswith(left):
        return right

    if left.endswith(right):
        return left

    if right in left:
        return left

    if left in right:
        return right

    max_overlap = min(len(left), len(right))
    for size in range(max_overlap, 0, -1):
        if left.endswith(right[:size]):
            return left + right[size:]

    return left + right


async def transcribe_chunk(websocket, state: SessionState, pcm_bytes: bytes, is_final: bool):
    if not pcm_bytes and not is_final:
        return

    state.chunk_index += 1
    pcm_int16 = np.frombuffer(pcm_bytes, dtype=np.int16)
    pcm = pcm_int16.astype(np.float32) / 32768.0

    result = model.generate(
        input=pcm,
        cache=state.cache,
        is_final=is_final,
        chunk_size=CHUNK_SIZE,
        encoder_chunk_look_back=ENCODER_LOOK_BACK,
        decoder_chunk_look_back=DECODER_LOOK_BACK,
    )

    text = normalize_result(result)
    if not text:
        return

    merged_text = merge_transcript(state.transcript_text, text)
    logger.info(
        "transcript chunk=%s final=%s raw=%r merged=%r",
        state.chunk_index,
        is_final,
        text,
        merged_text,
    )

    if is_final:
        state.transcript_text = merged_text
        state.final_text = state.transcript_text
        await send_json(
            websocket,
            {
                "type": "transcript",
                "text": state.final_text,
                "rawText": text,
                "isFinal": True,
                "chunkIndex": state.chunk_index
            },
        )
        return

    if merged_text != state.transcript_text or text != state.partial_text:
        state.transcript_text = merged_text
        state.partial_text = text
        await send_json(
            websocket,
            {
                "type": "transcript",
                "text": state.transcript_text,
                "rawText": text,
                "isFinal": False,
                "chunkIndex": state.chunk_index
            },
        )


async def flush_pending_chunks(websocket, state: SessionState):
    while len(state.pending_pcm) >= CHUNK_STRIDE_BYTES:
        pcm_bytes = bytes(state.pending_pcm[:CHUNK_STRIDE_BYTES])
        del state.pending_pcm[:CHUNK_STRIDE_BYTES]

        pcm_int16 = np.frombuffer(pcm_bytes, dtype=np.int16)
        if not state.signal_detected and not has_signal(pcm_int16):
            continue

        state.signal_detected = True
        await transcribe_chunk(websocket, state, pcm_bytes, is_final=False)


async def process_wake_frames(websocket, state: SessionState, pcm_bytes: bytes):
    if not state.wake_detector:
        return False

    state.wake_buffer.extend(pcm_bytes)
    frame_bytes = state.wake_frame_length * 2

    while len(state.wake_buffer) >= frame_bytes:
        frame = bytes(state.wake_buffer[:frame_bytes])
        del state.wake_buffer[:frame_bytes]

        pcm_int16 = np.frombuffer(frame, dtype=np.int16)
        predictions = state.wake_detector.predict(pcm_int16)
        score = float(predictions.get(state.wake_model_key, 0.0))

        if score >= OPENWAKEWORD_THRESHOLD:
            state.wake_consecutive_hits += 1
        else:
            state.wake_consecutive_hits = 0

        if state.wake_consecutive_hits >= OPENWAKEWORD_PATIENCE:
            state.wake_word_detected = True
            state.wake_buffer.clear()
            reset_asr_state(state)
            await send_json(
                websocket,
                {
                    "type": "wake",
                    "word": state.wake_word_label
                },
            )
            logger.info(
                "wake detected word=%r model=%r score=%.3f patience=%s",
                state.wake_word_label,
                state.wake_model_key,
                score,
                state.wake_consecutive_hits,
            )
            return True

    return False


async def handle_connection(websocket):
    wake_configured, wake_reason = openwakeword_config_status()
    state = SessionState()
    await send_json(
        websocket,
        {
            "type": "ready",
            "sampleRate": SAMPLE_RATE,
            "model": MODEL_NAME,
            "chunkSize": CHUNK_SIZE,
            "chunkStrideSamples": CHUNK_STRIDE_SAMPLES,
            "wakeWordConfigured": wake_configured,
            "wakeWordReason": wake_reason,
        },
    )

    try:
        async for message in websocket:
            if isinstance(message, bytes):
                if state.wake_word_enabled and not state.wake_word_detected:
                    detected = await process_wake_frames(websocket, state, message)
                    if detected:
                        continue
                    if not state.wake_word_detected:
                        continue

                state.audio_bytes += len(message)
                state.pending_pcm.extend(message)
                await flush_pending_chunks(websocket, state)
                continue

            try:
                payload = json.loads(message)
            except json.JSONDecodeError:
                await send_json(websocket, {"type": "error", "message": "Invalid JSON control message."})
                continue

            msg_type = payload.get("type")

            if msg_type == "start":
                requested_sample_rate = int(payload.get("sampleRate", SAMPLE_RATE))
                requested_channels = int(payload.get("channels", 1))
                requested_format = str(payload.get("format", "pcm_s16le"))
                requested_wake_word = bool(payload.get("wakeWordEnabled"))

                if requested_sample_rate != SAMPLE_RATE:
                    await send_json(
                        websocket,
                        {
                            "type": "error",
                            "message": f"Unsupported sample rate: {requested_sample_rate}. Expected {SAMPLE_RATE}."
                        },
                    )
                    continue

                if requested_channels != 1 or requested_format != "pcm_s16le":
                    await send_json(
                        websocket,
                        {
                            "type": "error",
                            "message": "Unsupported audio format. Expected mono pcm_s16le."
                        },
                    )
                    continue

                state = SessionState(sample_rate=requested_sample_rate)
                state.wake_word_enabled = requested_wake_word

                if state.wake_word_enabled:
                    configured, reason = openwakeword_config_status()
                    if not configured:
                        await send_json(
                            websocket,
                            {
                                "type": "error",
                                "message": f"Wake word engine unavailable: {reason}"
                            },
                        )
                        continue

                    try:
                        detector, wake_model_key, wake_word_label = create_wake_detector()
                    except Exception as error:
                        await send_json(
                            websocket,
                            {
                                "type": "error",
                                "message": f"Failed to initialize wake word engine: {error}"
                            },
                        )
                        continue

                    state.wake_detector = detector
                    state.wake_frame_length = 1280
                    state.wake_model_key = wake_model_key
                    state.wake_word_label = wake_word_label

                await send_json(
                    websocket,
                    {
                        "type": "started",
                        "sampleRate": state.sample_rate,
                        "chunkStrideSamples": CHUNK_STRIDE_SAMPLES,
                        "wakeWordEnabled": state.wake_word_enabled,
                        "wakeWordLabel": state.wake_word_label,
                    },
                )
                continue

            if msg_type == "stop":
                if state.wake_word_enabled and not state.wake_word_detected:
                    state.pending_pcm.clear()
                    state.wake_buffer.clear()
                    await send_json(websocket, {"type": "stopped", "text": ""})
                    continue

                if not state.signal_detected:
                    state.pending_pcm.clear()
                    await send_json(websocket, {"type": "stopped", "text": ""})
                    continue

                final_pcm = bytes(state.pending_pcm)
                state.pending_pcm.clear()

                if final_pcm:
                    await transcribe_chunk(websocket, state, final_pcm, is_final=True)
                else:
                    await transcribe_chunk(websocket, state, b"", is_final=True)

                await send_json(
                    websocket,
                    {
                        "type": "stopped",
                        "text": state.final_text or state.transcript_text or state.partial_text
                    },
                )
                continue

            if msg_type == "ping":
                await send_json(websocket, {"type": "pong"})
                continue

            await send_json(websocket, {"type": "error", "message": f"Unsupported message type: {msg_type}"})
    except ConnectionClosed:
        logger.info("client disconnected")
    finally:
        if state.wake_detector is not None:
            try:
                state.wake_detector.reset()
            except Exception:
                pass


async def main():
    async with serve(handle_connection, HOST, PORT, max_size=None):
        logger.info("listening on ws://%s:%s", HOST, PORT)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
