import io
import json
import logging
import os
import re
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import soundfile


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


DEFAULT_MELOTTS_REPO = str(Path(__file__).resolve().parents[1] / "MeloTTS")

HOST = get_env(["VOICERUNTIME_TTS_HOST", "LORARUNTIME_TTS_HOST"], "127.0.0.1")
PORT = int(get_env(["VOICERUNTIME_TTS_PORT", "LORARUNTIME_TTS_PORT"], "10097"))
MELOTTS_REPO = os.environ.get("MELOTTS_REPO", DEFAULT_MELOTTS_REPO)
MELOTTS_LANGUAGE = os.environ.get("MELOTTS_LANGUAGE", "ZH")
MELOTTS_SPEAKER = os.environ.get("MELOTTS_SPEAKER", "ZH")
MELOTTS_DEVICE = os.environ.get("MELOTTS_DEVICE", "cpu")
MELOTTS_SPEED = float(os.environ.get("MELOTTS_SPEED", "1.0"))
MELOTTS_MAX_CHARS = int(os.environ.get("MELOTTS_MAX_CHARS", "1200"))
MELOTTS_WARMUP = os.environ.get("MELOTTS_WARMUP", "true").lower() != "false"


logging.basicConfig(level=logging.INFO, format="[melotts] %(message)s")
logger = logging.getLogger("melotts-http")


if not os.path.isdir(MELOTTS_REPO):
    raise RuntimeError(
        f"MeloTTS repo not found: {MELOTTS_REPO}. Set MELOTTS_REPO in .env if needed."
    )

sys.path.insert(0, MELOTTS_REPO)

from melo.api import TTS  # noqa: E402


logger.info("loading MeloTTS language=%s device=%s", MELOTTS_LANGUAGE, MELOTTS_DEVICE)
model = TTS(language=MELOTTS_LANGUAGE, device=MELOTTS_DEVICE)
speaker_ids = dict(model.hps.data.spk2id.items())

if MELOTTS_SPEAKER not in speaker_ids:
    raise RuntimeError(
        f"Speaker {MELOTTS_SPEAKER!r} not found. Available speakers: {sorted(speaker_ids)}"
    )

speaker_id = speaker_ids[MELOTTS_SPEAKER]
sample_rate = int(model.hps.data.sampling_rate)
logger.info(
    "model ready speaker=%s sample_rate=%s speakers=%s",
    MELOTTS_SPEAKER,
    sample_rate,
    sorted(speaker_ids.keys()),
)


def synthesize_wav_bytes(text: str, speed: float) -> bytes:
    audio = model.tts_to_file(
        text=text,
        speaker_id=speaker_id,
        output_path=None,
        speed=speed,
        quiet=True,
    )
    buffer = io.BytesIO()
    soundfile.write(buffer, audio, sample_rate, format="WAV")
    return buffer.getvalue()


def sanitize_tts_text(text: str) -> str:
    cleaned = str(text or "").replace("\r", "\n")
    cleaned = re.sub(r"https?://\S+", " ", cleaned)
    cleaned = re.sub(r"[A-Za-z0-9_./:-]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


if MELOTTS_WARMUP:
    try:
        synthesize_wav_bytes("你好", MELOTTS_SPEED)
        logger.info("warmup complete")
    except Exception as error:
        logger.warning("warmup failed: %s", error)


class MeloTtsHandler(BaseHTTPRequestHandler):
    server_version = "MeloTTSHTTP/0.1"

    def do_GET(self):
        if self.path != "/health":
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return

        payload = {
            "status": "ok",
            "engine": "MeloTTS",
            "language": MELOTTS_LANGUAGE,
            "speaker": MELOTTS_SPEAKER,
            "sampleRate": sample_rate,
            "device": MELOTTS_DEVICE,
            "maxChars": MELOTTS_MAX_CHARS,
        }
        self.send_json(HTTPStatus.OK, payload)

    def do_POST(self):
        if self.path != "/synthesize":
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid Content-Length."})
            return

        try:
            body = self.rfile.read(content_length) if content_length > 0 else b"{}"
            payload = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON body."})
            return

        text = sanitize_tts_text(payload.get("text", ""))
        if not text:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Text is required."})
            return

        if len(text) > MELOTTS_MAX_CHARS:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                {"error": f"Text too long. Max {MELOTTS_MAX_CHARS} characters."},
            )
            return

        raw_speed = payload.get("speed", MELOTTS_SPEED)
        try:
            speed = float(raw_speed)
        except (TypeError, ValueError):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid speed value."})
            return

        try:
            wav_bytes = synthesize_wav_bytes(text, speed)
        except Exception as error:
            logger.exception("synthesis failed")
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)})
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav_bytes)))
        self.end_headers()
        self.wfile.write(wav_bytes)

    def log_message(self, fmt, *args):
        logger.info("%s - %s", self.address_string(), fmt % args)

    def send_json(self, status: HTTPStatus, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer((HOST, PORT), MeloTtsHandler)
    logger.info("listening on http://%s:%s", HOST, PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()
