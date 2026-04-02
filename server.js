const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const WebSocket = require("ws");
const { WebSocketServer } = require("ws");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const line = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

loadEnvFile(path.join(__dirname, ".env"));

function getEnv(keys, fallback = "") {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return fallback;
}

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3010);
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_BASE_URL = getEnv(
  ["VOICERUNTIME_BASE_URL", "LORARUNTIME_BASE_URL"],
  "http://127.0.0.1:8080/v1"
);
const DEFAULT_MODEL = getEnv(
  ["VOICERUNTIME_MODEL", "LORARUNTIME_MODEL"],
  "Qwen/Qwen3.5-9B"
);
const DEFAULT_SYSTEM_PROMPT =
  getEnv(["VOICERUNTIME_SYSTEM_PROMPT", "LORARUNTIME_SYSTEM_PROMPT"]) ||
  "You are a concise, capable assistant running in VoiceRuntime.";
const DEFAULT_MAX_TOKENS = Number(
  getEnv(["VOICERUNTIME_MAX_TOKENS", "LORARUNTIME_MAX_TOKENS"], "4096")
);
const DEFAULT_VOICE_WS_PATH = "/ws/voice";
const ASR_PYTHON_BIN = getEnv(["VOICERUNTIME_ASR_PYTHON", "LORARUNTIME_ASR_PYTHON"], "python3");
const ASR_WS_HOST = getEnv(["VOICERUNTIME_ASR_HOST", "LORARUNTIME_ASR_HOST"], "127.0.0.1");
const ASR_WS_PORT = Number(getEnv(["VOICERUNTIME_ASR_PORT", "LORARUNTIME_ASR_PORT"], "10096"));
const ASR_WS_URL =
  getEnv(["VOICERUNTIME_ASR_URL", "LORARUNTIME_ASR_URL"]) || `ws://${ASR_WS_HOST}:${ASR_WS_PORT}`;
const ASR_AUTOSTART = getEnv(["VOICERUNTIME_ASR_AUTOSTART", "LORARUNTIME_ASR_AUTOSTART"], "true") !== "false";
const ASR_SCRIPT_PATH = path.join(__dirname, "services", "funasr_ws_server.py");
const TTS_HOST = getEnv(["VOICERUNTIME_TTS_HOST", "LORARUNTIME_TTS_HOST"], "127.0.0.1");
const TTS_PORT = Number(getEnv(["VOICERUNTIME_TTS_PORT", "LORARUNTIME_TTS_PORT"], "10097"));
const TTS_BASE_URL =
  getEnv(["VOICERUNTIME_TTS_URL", "LORARUNTIME_TTS_URL"]) || `http://${TTS_HOST}:${TTS_PORT}`;
const TTS_AUTOSTART = getEnv(["VOICERUNTIME_TTS_AUTOSTART", "LORARUNTIME_TTS_AUTOSTART"], "true") !== "false";
const TTS_PYTHON_BIN = getEnv(["VOICERUNTIME_TTS_PYTHON", "LORARUNTIME_TTS_PYTHON"], "python3");
const TTS_SCRIPT_PATH = path.join(__dirname, "services", "melotts_http_server.py");
const TTS_TIMEOUT_MS = Number(
  getEnv(["VOICERUNTIME_TTS_TIMEOUT_MS", "LORARUNTIME_TTS_TIMEOUT_MS"], "120000")
);
const TTS_MAX_CHARS = Number(process.env.MELOTTS_MAX_CHARS || 1200);
const VOICE_SAMPLE_RATE = Number(process.env.FUNASR_SAMPLE_RATE || 16000);
const VOICE_ENCODING = "pcm_s16le";
const VOICE_CHANNELS = 1;
const VOICE_FRAME_MS = 20;
const VOICE_CHUNK_SIZE = String(process.env.FUNASR_CHUNK_SIZE || "0,8,4")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value));

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

let asrProcess = null;
let ttsProcess = null;

function logChildOutput(prefix, chunk) {
  const text = String(chunk || "").trim();
  if (!text) {
    return;
  }

  for (const line of text.split("\n")) {
    console.log(`[${prefix}] ${line}`);
  }
}

function ensureAsrService() {
  if (!ASR_AUTOSTART || asrProcess) {
    return;
  }

  asrProcess = spawn(ASR_PYTHON_BIN, [ASR_SCRIPT_PATH], {
    cwd: __dirname,
    env: {
      ...process.env,
      VOICERUNTIME_ASR_HOST: ASR_WS_HOST,
      VOICERUNTIME_ASR_PORT: String(ASR_WS_PORT),
      LORARUNTIME_ASR_HOST: ASR_WS_HOST,
      LORARUNTIME_ASR_PORT: String(ASR_WS_PORT),
      FUNASR_WS_HOST: ASR_WS_HOST,
      FUNASR_WS_PORT: String(ASR_WS_PORT)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  asrProcess.stdout.on("data", (chunk) => logChildOutput("asr", chunk));
  asrProcess.stderr.on("data", (chunk) => logChildOutput("asr", chunk));
  asrProcess.on("exit", (code, signal) => {
    console.log(`[asr] exited code=${code} signal=${signal}`);
    asrProcess = null;
  });
}

function shutdownAsrService() {
  if (!asrProcess) {
    return;
  }

  asrProcess.kill("SIGTERM");
  asrProcess = null;
}

function ensureTtsService() {
  if (!TTS_AUTOSTART || ttsProcess) {
    return;
  }

  ttsProcess = spawn(TTS_PYTHON_BIN, [TTS_SCRIPT_PATH], {
    cwd: __dirname,
    env: {
      ...process.env,
      VOICERUNTIME_TTS_HOST: TTS_HOST,
      VOICERUNTIME_TTS_PORT: String(TTS_PORT),
      LORARUNTIME_TTS_HOST: TTS_HOST,
      LORARUNTIME_TTS_PORT: String(TTS_PORT)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  ttsProcess.stdout.on("data", (chunk) => logChildOutput("tts", chunk));
  ttsProcess.stderr.on("data", (chunk) => logChildOutput("tts", chunk));
  ttsProcess.on("exit", (code, signal) => {
    console.log(`[tts] exited code=${code} signal=${signal}`);
    ttsProcess = null;
  });
}

function shutdownTtsService() {
  if (!ttsProcess) {
    return;
  }

  ttsProcess.kill("SIGTERM");
  ttsProcess = null;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;

      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });

    req.on("error", reject);
  });
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withProtocol);
  return url.toString().replace(/\/+$/, "");
}

function getChatMessages(body) {
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    return body.messages;
  }

  const message = String(body.message || "").trim();
  if (!message) {
    return [];
  }

  return [{ role: "user", content: message }];
}

async function handleHealth(res) {
  const upstream = DEFAULT_BASE_URL.replace(/\/v1\/?$/, "");
  let upstreamOk = false;
  let upstreamStatus = null;
  let ttsOk = false;
  let ttsStatus = null;

  try {
    const response = await fetch(`${upstream}/health`, { method: "GET" });
    upstreamOk = response.ok;
    upstreamStatus = response.status;
  } catch (error) {
    upstreamOk = false;
  }

  try {
    const response = await fetch(`${TTS_BASE_URL}/health`, { method: "GET" });
    ttsOk = response.ok;
    ttsStatus = response.status;
  } catch (error) {
    ttsOk = false;
  }

  sendJson(res, 200, {
    app: "VoiceRuntime",
    status: "ok",
    upstreamOk,
    upstreamStatus,
    defaults: {
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      maxTokens: DEFAULT_MAX_TOKENS
    },
    voice: {
      wsPath: DEFAULT_VOICE_WS_PATH,
      asrAutostart: ASR_AUTOSTART,
      audio: {
        sampleRate: VOICE_SAMPLE_RATE,
        channels: VOICE_CHANNELS,
        encoding: VOICE_ENCODING,
        frameMs: VOICE_FRAME_MS
      },
      asr: {
        chunkSize: VOICE_CHUNK_SIZE
      }
    },
    tts: {
      enabled: true,
      autostart: TTS_AUTOSTART,
      baseUrl: TTS_BASE_URL,
      upstreamOk: ttsOk,
      upstreamStatus: ttsStatus,
      maxChars: TTS_MAX_CHARS
    }
  });
}

async function handleTts(req, res) {
  ensureTtsService();

  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const text = String(body.text || "").trim();
  if (!text) {
    sendJson(res, 400, { error: "Text is required." });
    return;
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), TTS_TIMEOUT_MS);

  let upstreamResponse;

  try {
    upstreamResponse = await fetch(`${TTS_BASE_URL}/synthesize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        speed: body.speed
      }),
      signal: abortController.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    sendJson(res, 502, {
      error: "Failed to reach TTS service.",
      details: error.message
    });
    return;
  }

  clearTimeout(timeout);

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text().catch(() => "");
    sendJson(res, upstreamResponse.status || 502, {
      error: "TTS service returned an error.",
      details: errorText || upstreamResponse.statusText
    });
    return;
  }

  const audioBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
  res.writeHead(200, {
    "Content-Type": upstreamResponse.headers.get("content-type") || "audio/wav",
    "Content-Length": String(audioBuffer.length),
    "Cache-Control": "no-store"
  });
  res.end(audioBuffer);
}

async function handleChat(req, res) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const messages = getChatMessages(body);
  if (messages.length === 0) {
    sendJson(res, 400, { error: "At least one user message is required." });
    return;
  }

  const baseUrl = normalizeBaseUrl(body.baseUrl || DEFAULT_BASE_URL);
  const model = String(body.model || DEFAULT_MODEL).trim();
  const systemPrompt = String(body.systemPrompt || DEFAULT_SYSTEM_PROMPT).trim();

  const upstreamPayload = {
    model,
    stream: true,
    temperature: Number.isFinite(Number(body.temperature))
      ? Number(body.temperature)
      : 0.7,
    max_tokens: Number.isFinite(Number(body.maxTokens))
      ? Number(body.maxTokens)
      : DEFAULT_MAX_TOKENS,
    messages: systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...messages]
      : messages
  };

  if (typeof body.enableThinking === "boolean") {
    upstreamPayload.chat_template_kwargs = {
      enable_thinking: body.enableThinking
    };
  }

  let upstreamResponse;

  try {
    upstreamResponse = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify(upstreamPayload)
    });
  } catch (error) {
    sendJson(res, 502, {
      error: "Failed to reach upstream model service.",
      details: error.message,
      baseUrl
    });
    return;
  }

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    const errorText = await upstreamResponse.text().catch(() => "");
    sendJson(res, upstreamResponse.status || 502, {
      error: "Upstream model service returned an error.",
      status: upstreamResponse.status,
      details: errorText || upstreamResponse.statusText,
      baseUrl,
      model
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const metadata = JSON.stringify({ baseUrl, model });
  res.write(`event: meta\ndata: ${metadata}\n\n`);

  try {
    for await (const chunk of upstreamResponse.body) {
      res.write(chunk);
    }
  } catch (error) {
    const message = JSON.stringify({
      error: "Streaming interrupted.",
      details: error.message
    });
    res.write(`event: error\ndata: ${message}\n\n`);
  } finally {
    res.end();
  }
}

function serveStaticFile(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden." });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (error.code === "ENOENT") {
        sendJson(res, 404, { error: "Not found." });
        return;
      }

      sendJson(res, 500, { error: "Failed to read static asset." });
      return;
    }

    const contentType = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const { pathname } = requestUrl;

  if (req.method === "GET" && pathname === "/api/health") {
    await handleHealth(res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/chat") {
    await handleChat(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/tts") {
    await handleTts(req, res);
    return;
  }

  if (req.method === "GET") {
    serveStaticFile(req, res, pathname);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed." });
});

const voiceWss = new WebSocketServer({ noServer: true });

voiceWss.on("connection", (client) => {
  ensureAsrService();
  console.log("[voice] browser connected");

  const upstream = new WebSocket(ASR_WS_URL, {
    maxPayload: 16 * 1024 * 1024
  });

  const pendingFrames = [];
  let upstreamReady = false;

  function flushPendingFrames() {
    while (pendingFrames.length > 0 && upstreamReady && upstream.readyState === WebSocket.OPEN) {
      const [frame, isBinary] = pendingFrames.shift();
      upstream.send(frame, { binary: isBinary });
    }
  }

  function forwardToUpstream(frame, isBinary) {
    if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
      upstream.send(frame, { binary: isBinary });
      return;
    }

    pendingFrames.push([frame, isBinary]);
  }

  upstream.on("open", () => {
    upstreamReady = true;
    console.log("[voice] asr upstream connected");
    client.send(JSON.stringify({ type: "gateway", status: "connected" }));
    flushPendingFrames();
  });

  upstream.on("message", (frame, isBinary) => {
    client.send(frame, { binary: isBinary });
  });

  upstream.on("close", () => {
    console.log("[voice] asr upstream closed");
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "gateway", status: "disconnected" }));
      client.close();
    }
  });

  upstream.on("error", (error) => {
    console.log(`[voice] asr upstream error: ${error.message}`);
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type: "error",
          message: `ASR upstream error: ${error.message}`
        })
      );
      client.close();
    }
  });

  client.on("message", (frame, isBinary) => {
    forwardToUpstream(frame, isBinary);
  });

  client.on("close", () => {
    console.log("[voice] browser disconnected");
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  });

  client.on("error", () => {
    console.log("[voice] browser socket error");
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  });
});

server.on("upgrade", (req, socket, head) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname !== DEFAULT_VOICE_WS_PATH) {
    socket.destroy();
    return;
  }

  voiceWss.handleUpgrade(req, socket, head, (ws) => {
    voiceWss.emit("connection", ws, req);
  });
});

server.listen(PORT, HOST, () => {
  ensureAsrService();
  ensureTtsService();
  console.log(`VoiceRuntime listening on http://${HOST}:${PORT}`);
  console.log(`Default upstream: ${DEFAULT_BASE_URL}`);
  console.log(`Default model: ${DEFAULT_MODEL}`);
  console.log(`Voice websocket: ws://${HOST}:${PORT}${DEFAULT_VOICE_WS_PATH}`);
  console.log(`ASR upstream: ${ASR_WS_URL}`);
  console.log(`TTS upstream: ${TTS_BASE_URL}`);
});

process.on("SIGINT", () => {
  shutdownAsrService();
  shutdownTtsService();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdownAsrService();
  shutdownTtsService();
  process.exit(0);
});
