const runtimeConfig = window.VoiceRuntimeConfig || window.LoraRuntimeConfig || {};
const apiConfig = runtimeConfig.api || {};
const runtimeDefaultsConfig = runtimeConfig.runtime?.defaults || {};
const voiceConfig = runtimeConfig.voice || {};
const ttsConfig = runtimeConfig.tts || {};
const API_HEALTH_PATH = apiConfig.healthPath || "/api/health";
const API_CHAT_PATH = apiConfig.chatPath || "/api/chat";
const API_TTS_PATH = apiConfig.ttsPath || "/api/tts";
const API_VOICE_WS_PATH = apiConfig.voiceWsPath || "/ws/voice";

const state = {
  messages: [],
  streaming: false,
  mode: "text",
  voice: {
    interactionMode: "manual",
    wakeWord: voiceConfig.defaultWakeWord || "hey jarvis",
    wsPath: API_VOICE_WS_PATH,
    sampleRate: 16000,
    channels: 1,
    format: "pcm_s16le",
    frameMs: 20,
    socket: null,
    mediaStream: null,
    audioContext: null,
    sourceNode: null,
    workletNode: null,
    recording: false,
    waitingFinal: false,
    partialText: "",
    finalText: "",
    holdActive: false,
    wakeListening: false,
    wakeTriggered: false,
    shouldSendOnStop: false,
    resumeWakeAfterSend: false,
    autoStopTimer: null
  },
  tts: {
    enabled: ttsConfig.autoPlay !== false,
    speaking: false,
    audio: null,
    audioUrl: "",
    fetchController: null,
    queue: [],
    pendingText: "",
    spokenText: "",
    generation: 0,
    segmentId: 0,
    finalizing: false,
    drainPromise: Promise.resolve(),
    drainResolver: null
  },
  settings: {
    enableThinking: true,
    hideThinking: true,
    renderMarkdown: true
  }
};

const STORAGE_KEY = "voiceruntime.settings.v2";
const LEGACY_STORAGE_KEY = "loraruntime.settings.v2";
const WAKE_PROMPT_IDLE_MS = Number(voiceConfig.wakePromptIdleMs) || 4000;
const WAKE_CONTENT_IDLE_MS = Number(voiceConfig.wakeContentIdleMs) || 5000;
const DEFAULT_TEMPERATURE = Number(runtimeDefaultsConfig.temperature);
const DEFAULT_MAX_TOKENS = Number(runtimeDefaultsConfig.maxTokens);

const elements = {
  appShell: document.querySelector("#appShell"),
  messages: document.querySelector("#messages"),
  chatForm: document.querySelector("#chatForm"),
  promptInput: document.querySelector("#promptInput"),
  sendButton: document.querySelector("#sendButton"),
  clearButton: document.querySelector("#clearButton"),
  pingButton: document.querySelector("#pingButton"),
  healthBadge: document.querySelector("#healthBadge"),
  streamIndicator: document.querySelector("#streamIndicator"),
  baseUrlInput: document.querySelector("#baseUrlInput"),
  modelInput: document.querySelector("#modelInput"),
  systemPromptInput: document.querySelector("#systemPromptInput"),
  temperatureInput: document.querySelector("#temperatureInput"),
  maxTokensInput: document.querySelector("#maxTokensInput"),
  enableThinkingInput: document.querySelector("#enableThinkingInput"),
  hideThinkingInput: document.querySelector("#hideThinkingInput"),
  renderMarkdownInput: document.querySelector("#renderMarkdownInput"),
  autoSpeakInput: document.querySelector("#autoSpeakInput"),
  textModeButton: document.querySelector("#textModeButton"),
  voiceModeButton: document.querySelector("#voiceModeButton"),
  voicePanel: document.querySelector("#voicePanel"),
  voiceHint: document.querySelector("#voiceHint"),
  voiceStatus: document.querySelector("#voiceStatus"),
  voiceTranscript: document.querySelector("#voiceTranscript"),
  manualVoiceButton: document.querySelector("#manualVoiceButton"),
  wakeVoiceButton: document.querySelector("#wakeVoiceButton"),
  holdToTalkButton: document.querySelector("#holdToTalkButton"),
  toggleRecordingButton: document.querySelector("#toggleRecordingButton"),
  wakeListeningButton: document.querySelector("#wakeListeningButton"),
  template: document.querySelector("#messageTemplate")
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPlainText(targetNode, text) {
  targetNode.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
  );
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return html;
}

function markdownToHtml(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const output = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let quoteLines = [];
  let codeFence = null;
  let codeLines = [];

  function flushParagraph() {
    if (paragraph.length === 0) {
      return;
    }

    output.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!listType || listItems.length === 0) {
      return;
    }

    const tag = listType === "ol" ? "ol" : "ul";
    const items = listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("");
    output.push(`<${tag}>${items}</${tag}>`);
    listType = null;
    listItems = [];
  }

  function flushQuote() {
    if (quoteLines.length === 0) {
      return;
    }

    output.push(`<blockquote><p>${renderInlineMarkdown(quoteLines.join(" "))}</p></blockquote>`);
    quoteLines = [];
  }

  function flushCode() {
    if (codeFence === null) {
      return;
    }

    const languageClass = codeFence ? ` class="language-${escapeHtml(codeFence)}"` : "";
    output.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeFence = null;
    codeLines = [];
  }

  for (const line of lines) {
    if (codeFence !== null) {
      if (/^```/.test(line)) {
        flushCode();
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const fenceMatch = line.match(/^```([\w-]+)?\s*$/);
    if (fenceMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      codeFence = fenceMatch[1] || "";
      codeLines = [];
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = headingMatch[1].length;
      output.push(`<h${level}>${renderInlineMarkdown(headingMatch[2].trim())}</h${level}>`);
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1]);
      continue;
    }

    const orderedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (orderedMatch) {
      flushParagraph();
      flushQuote();
      if (listType && listType !== "ol") {
        flushList();
      }
      listType = "ol";
      listItems.push(orderedMatch[1].trim());
      continue;
    }

    const bulletMatch = line.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      flushParagraph();
      flushQuote();
      if (listType && listType !== "ul") {
        flushList();
      }
      listType = "ul";
      listItems.push(bulletMatch[1].trim());
      continue;
    }

    if (listType || quoteLines.length > 0) {
      flushList();
      flushQuote();
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushQuote();
  flushCode();

  return output.join("");
}

function findAnswerStart(text) {
  const patterns = [
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:final(?:\s+(?:answer|response|decision|version|polish))?|最终(?:答案|回答|答复|版本)?|正式回答|最终输出)\s*(?:\*\*)?\s*[:：-]\s*/gim,
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:answer|response|回答|答复)\s*(?:\*\*)?\s*[:：-]\s*/gim
  ];

  let bestMatch = null;

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(text)) !== null) {
      bestMatch = {
        index: match.index,
        end: match.index + match[0].length
      };
    }
  }

  return bestMatch;
}

function extractVisibleAssistantContent(rawContent) {
  let text = String(rawContent || "").replace(/\r/g, "");
  let hidden = false;

  if (!text.trim()) {
    return { text: "", hidden: false, waiting: false };
  }

  const thinkTagPattern = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
  if (thinkTagPattern.test(text)) {
    hidden = true;
    text = text.replace(thinkTagPattern, "").trim();
  }

  const leadingThinking = /^\s*(?:thinking process|thinking|reasoning|analysis|思考过程|推理过程|思路)\s*[:：]?\s*/i;
  if (leadingThinking.test(text)) {
    hidden = true;
    const answerStart = findAnswerStart(text);

    if (answerStart) {
      const answerText = text.slice(answerStart.end).trim();
      if (answerText) {
        text = answerText;
      } else {
        return { text: "", hidden, waiting: true };
      }
    } else {
      return { text: "", hidden, waiting: true };
    }
  }

  return { text: text.trim(), hidden, waiting: false };
}

function getAssistantPresentation(rawContent) {
  if (!state.settings.hideThinking) {
    return { text: rawContent, placeholder: false };
  }

  const extracted = extractVisibleAssistantContent(rawContent);
  if (extracted.text) {
    return { text: extracted.text, placeholder: false };
  }

  if (extracted.hidden && extracted.waiting) {
    return { text: "思考过程已隐藏，等待最终回答...", placeholder: true };
  }

  if (extracted.hidden) {
    return { text: "思考过程已隐藏。", placeholder: true };
  }

  return { text: rawContent, placeholder: false };
}

function saveSettings() {
  const payload = {
    mode: state.mode,
    voiceInteractionMode: state.voice.interactionMode,
    baseUrl: elements.baseUrlInput.value.trim(),
    model: elements.modelInput.value.trim(),
    systemPrompt: elements.systemPromptInput.value,
    temperature: elements.temperatureInput.value,
    maxTokens: elements.maxTokensInput.value,
    enableThinking: elements.enableThinkingInput.checked,
    hideThinking: elements.hideThinkingInput.checked,
    renderMarkdown: elements.renderMarkdownInput.checked,
    autoSpeak: elements.autoSpeakInput.checked
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function applyConfigDefaults() {
  if (!elements.baseUrlInput.value.trim() && runtimeDefaultsConfig.baseUrl) {
    elements.baseUrlInput.value = String(runtimeDefaultsConfig.baseUrl).trim();
  }

  if (!elements.modelInput.value.trim() && runtimeDefaultsConfig.model) {
    elements.modelInput.value = String(runtimeDefaultsConfig.model).trim();
  }

  if (
    !elements.systemPromptInput.value.trim() &&
    typeof runtimeDefaultsConfig.systemPrompt === "string"
  ) {
    elements.systemPromptInput.value = runtimeDefaultsConfig.systemPrompt;
  }

  if (!elements.temperatureInput.value.trim() && Number.isFinite(DEFAULT_TEMPERATURE)) {
    elements.temperatureInput.value = String(DEFAULT_TEMPERATURE);
  }

  if (!elements.maxTokensInput.value.trim() && Number.isFinite(DEFAULT_MAX_TOKENS)) {
    elements.maxTokensInput.value = String(DEFAULT_MAX_TOKENS);
  }
}

function applyStoredSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      return;
    }

    const saved = JSON.parse(raw);
    if (saved.mode === "voice") {
      state.mode = "voice";
    }
    if (saved.voiceInteractionMode === "wake") {
      state.voice.interactionMode = "wake";
    }
    if (saved.baseUrl) {
      elements.baseUrlInput.value = saved.baseUrl;
    }
    if (saved.model) {
      elements.modelInput.value = saved.model;
    }
    if (typeof saved.systemPrompt === "string") {
      elements.systemPromptInput.value = saved.systemPrompt;
    }
    if (saved.temperature) {
      elements.temperatureInput.value = saved.temperature;
    }
    if (saved.maxTokens) {
      elements.maxTokensInput.value = saved.maxTokens;
    }
    if (typeof saved.enableThinking === "boolean") {
      elements.enableThinkingInput.checked = saved.enableThinking;
    }
    if (typeof saved.hideThinking === "boolean") {
      elements.hideThinkingInput.checked = saved.hideThinking;
    }
    if (typeof saved.renderMarkdown === "boolean") {
      elements.renderMarkdownInput.checked = saved.renderMarkdown;
    }
    if (typeof saved.autoSpeak === "boolean") {
      elements.autoSpeakInput.checked = saved.autoSpeak;
    }
  } catch (error) {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
}

function syncSettingsFromInputs() {
  state.settings.enableThinking = elements.enableThinkingInput.checked;
  state.settings.hideThinking = elements.hideThinkingInput.checked;
  state.settings.renderMarkdown = elements.renderMarkdownInput.checked;
  state.tts.enabled = elements.autoSpeakInput.checked;
}

function setMode(mode) {
  state.mode = mode;
  elements.appShell.dataset.mode = mode;
  elements.textModeButton.classList.toggle("is-active", mode === "text");
  elements.voiceModeButton.classList.toggle("is-active", mode === "voice");
  saveSettings();
}

function setStreaming(streaming) {
  state.streaming = streaming;
  elements.sendButton.disabled = streaming;
  elements.promptInput.disabled = streaming;
  elements.streamIndicator.textContent = streaming ? "Streaming" : "Idle";
}

function scrollMessagesToBottom() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function autoGrowPrompt() {
  elements.promptInput.style.height = "0px";
  const nextHeight = Math.min(elements.promptInput.scrollHeight, 220);
  elements.promptInput.style.height = `${Math.max(nextHeight, 56)}px`;
}

function renderMessageContent(message) {
  const { role, contentNode, content } = message;

  if (role === "user") {
    contentNode.classList.remove("is-placeholder");
    renderPlainText(contentNode, content);
    return;
  }

  const presentation = getAssistantPresentation(content);
  contentNode.classList.toggle("is-placeholder", presentation.placeholder);

  if (state.settings.renderMarkdown && !presentation.placeholder) {
    contentNode.innerHTML = markdownToHtml(presentation.text || " ");
  } else {
    renderPlainText(contentNode, presentation.text || " ");
  }
}

function rerenderMessages() {
  for (const message of state.messages) {
    if (message.contentNode) {
      renderMessageContent(message);
    }
  }
}

function createMessage(role, content) {
  const fragment = elements.template.content.cloneNode(true);
  const article = fragment.querySelector(".message");
  const roleNode = fragment.querySelector(".message-role");

  article.dataset.role = role;
  roleNode.textContent = role === "user" ? "User" : "Assistant";

  elements.messages.appendChild(fragment);
  const mountedArticle = elements.messages.lastElementChild;
  const mountedContentNode = mountedArticle.querySelector(".message-content");

  const message = {
    role,
    content,
    article: mountedArticle,
    contentNode: mountedContentNode
  };

  renderMessageContent(message);
  scrollMessagesToBottom();
  return message;
}

function renderWelcome() {
  if (state.messages.length > 0) {
    return;
  }

  createMessage("assistant", "你好，我可以直接回答问题，也支持语音输入。");
}

function buildSpeechText(rawContent) {
  const presentation = getAssistantPresentation(rawContent);
  if (presentation.placeholder) {
    return "";
  }

  let text = String(presentation.text || "");
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  text = text.replace(/https?:\/\/\S+/g, "");
  text = text.replace(/\n+/g, "。");
  text = text.replace(/\s+/g, " ");
  return text.trim();
}

function resetSpeechDrain() {
  state.tts.drainPromise = new Promise((resolve) => {
    state.tts.drainResolver = resolve;
  });
}

function resolveSpeechDrainIfIdle() {
  if (
    !state.tts.finalizing ||
    state.tts.fetchController ||
    state.tts.speaking ||
    state.tts.queue.length > 0
  ) {
    return;
  }

  const resolver = state.tts.drainResolver;
  state.tts.drainResolver = null;
  if (resolver) {
    resolver();
  }
}

function clearSpeechQueue() {
  for (const item of state.tts.queue) {
    if (item.audioUrl) {
      URL.revokeObjectURL(item.audioUrl);
    }
  }
  state.tts.queue = [];
}

function finishSpeechPlayback() {
  const audio = state.tts.audio;
  const audioUrl = state.tts.audioUrl;

  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.src = "";
  }

  if (audioUrl) {
    URL.revokeObjectURL(audioUrl);
  }

  state.tts.audio = null;
  state.tts.audioUrl = "";
  state.tts.speaking = false;
}

function stopSpeechPlayback() {
  state.tts.generation += 1;

  if (state.tts.fetchController) {
    state.tts.fetchController.abort();
  }

  finishSpeechPlayback();
  clearSpeechQueue();

  state.tts.fetchController = null;
  state.tts.pendingText = "";
  state.tts.spokenText = "";
  state.tts.segmentId = 0;
  state.tts.finalizing = false;

  if (state.tts.drainResolver) {
    state.tts.drainResolver();
    state.tts.drainResolver = null;
  }

  state.tts.drainPromise = Promise.resolve();
}

function startSpeechStream() {
  stopSpeechPlayback();

  if (!state.tts.enabled) {
    return;
  }

  state.tts.pendingText = "";
  state.tts.spokenText = "";
  state.tts.segmentId = 0;
  state.tts.finalizing = false;
  resetSpeechDrain();
}

function waitForSpeechDrain() {
  return state.tts.drainPromise || Promise.resolve();
}

function normalizeSpeechSegment(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSpeechSegments(force = false) {
  const segments = [];
  let buffer = state.tts.pendingText;

  while (buffer) {
    let splitIndex = -1;

    for (let index = 0; index < buffer.length; index += 1) {
      const char = buffer[index];
      const isMajorBoundary = /[。！？!?；;\n]/.test(char);
      const isMinorBoundary = /[，、,:：]/.test(char) && index >= 18;

      if (isMajorBoundary || isMinorBoundary) {
        splitIndex = index + 1;
        break;
      }
    }

    if (splitIndex === -1) {
      break;
    }

    const segment = normalizeSpeechSegment(buffer.slice(0, splitIndex));
    buffer = buffer.slice(splitIndex).trimStart();

    if (segment) {
      segments.push(segment);
    }
  }

  if (!force && buffer.length >= 48) {
    const segment = normalizeSpeechSegment(buffer.slice(0, 40));
    buffer = buffer.slice(40).trimStart();
    if (segment) {
      segments.push(segment);
    }
  }

  if (force) {
    const tail = normalizeSpeechSegment(buffer);
    buffer = "";
    if (tail) {
      segments.push(tail);
    }
  }

  state.tts.pendingText = buffer;
  return segments;
}

async function fetchSpeechSegment(item, generation) {
  const controller = new AbortController();
  state.tts.fetchController = controller;

  try {
    const response = await fetch(API_TTS_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text: item.text }),
      signal: controller.signal
    });

    if (!response.ok) {
      console.error("TTS request failed", await response.text().catch(() => response.statusText));
      item.status = "error";
      return;
    }

    const audioBlob = await response.blob();
    if (generation !== state.tts.generation || controller.signal.aborted) {
      return;
    }

    item.audioUrl = URL.createObjectURL(audioBlob);
    item.status = "ready";
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error("TTS request failed", error);
    }
    item.status = "error";
  } finally {
    if (state.tts.fetchController === controller) {
      state.tts.fetchController = null;
    }

    if (generation === state.tts.generation) {
      if (item.status === "error") {
        state.tts.queue = state.tts.queue.filter((queued) => queued.id !== item.id);
      }
      pumpSpeechQueue(generation);
    }
  }
}

function playSpeechSegment(item, generation) {
  if (!item.audioUrl) {
    return;
  }

  const audio = new Audio(item.audioUrl);
  state.tts.audio = audio;
  state.tts.audioUrl = item.audioUrl;
  state.tts.speaking = true;
  item.status = "playing";

  const finishSegment = () => {
    if (generation !== state.tts.generation) {
      return;
    }

    finishSpeechPlayback();
    state.tts.queue = state.tts.queue.filter((queued) => queued.id !== item.id);
    pumpSpeechQueue(generation);
  };

  audio.onended = finishSegment;
  audio.onerror = finishSegment;
  audio.play().catch((error) => {
    console.error("TTS playback failed", error);
    finishSegment();
  });
}

function pumpSpeechQueue(generation = state.tts.generation) {
  if (generation !== state.tts.generation) {
    return;
  }

  if (!state.tts.fetchController) {
    const nextPending = state.tts.queue.find((item) => item.status === "pending");
    if (nextPending) {
      nextPending.status = "loading";
      void fetchSpeechSegment(nextPending, generation);
    }
  }

  if (!state.tts.speaking) {
    const nextReady = state.tts.queue[0];
    if (nextReady && nextReady.status === "ready") {
      playSpeechSegment(nextReady, generation);
      return;
    }
  }

  resolveSpeechDrainIfIdle();
}

function enqueueSpeechSegment(text) {
  const normalized = normalizeSpeechSegment(text);
  if (!normalized) {
    return;
  }

  state.tts.segmentId += 1;
  state.tts.queue.push({
    id: state.tts.segmentId,
    text: normalized,
    status: "pending",
    audioUrl: ""
  });
  pumpSpeechQueue();
}

function updateSpeechStream(rawContent, options = {}) {
  if (!state.tts.enabled) {
    return;
  }

  const force = options.force === true;
  const nextText = buildSpeechText(rawContent);
  if (!nextText) {
    if (force) {
      state.tts.finalizing = true;
      resolveSpeechDrainIfIdle();
    }
    return;
  }

  const previousText = state.tts.spokenText;
  if (!nextText.startsWith(previousText)) {
    if (force && state.tts.queue.length === 0 && !state.tts.speaking && !state.tts.fetchController) {
      state.tts.pendingText = nextText;
      state.tts.spokenText = nextText;
    }
  } else {
    const deltaText = nextText.slice(previousText.length);
    if (deltaText) {
      state.tts.pendingText += deltaText;
      state.tts.spokenText = nextText;
    }
  }

  const segments = extractSpeechSegments(force);
  for (const segment of segments) {
    enqueueSpeechSegment(segment);
  }

  if (force) {
    state.tts.finalizing = true;
    pumpSpeechQueue();
  }
}

function getDefaultVoiceTranscript() {
  if (state.voice.interactionMode === "wake") {
    return `等待唤醒词 “${state.voice.wakeWord}”...`;
  }

  return "按住说话，或点击开始说话。";
}

function resetVoiceTranscript(text = getDefaultVoiceTranscript()) {
  elements.voiceTranscript.textContent = text;
}

function updateVoiceStatus(text) {
  elements.voiceStatus.textContent = text;
}

async function playVoiceCue(type) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return;
  }

  const context =
    state.voice.audioContext && state.voice.audioContext.state !== "closed"
      ? state.voice.audioContext
      : new AudioContextCtor({ latencyHint: "interactive" });
  const shouldClose = context !== state.voice.audioContext;

  if (context.state === "suspended") {
    await context.resume().catch(() => {});
  }

  const now = context.currentTime + 0.01;
  const notes =
    type === "end"
      ? [
          { freq: 880, start: now, duration: 0.06 },
          { freq: 660, start: now + 0.1, duration: 0.08 }
        ]
      : [
          { freq: 660, start: now, duration: 0.06 },
          { freq: 880, start: now + 0.1, duration: 0.08 }
        ];

  for (const note of notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = note.freq;
    gain.gain.setValueAtTime(0.0001, note.start);
    gain.gain.exponentialRampToValueAtTime(0.12, note.start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, note.start + note.duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(note.start);
    oscillator.stop(note.start + note.duration);
  }

  if (shouldClose) {
    const endAt = notes[notes.length - 1].start + notes[notes.length - 1].duration + 0.05;
    window.setTimeout(() => {
      context.close().catch(() => {});
    }, Math.max(0, Math.ceil((endAt - context.currentTime) * 1000)));
  }
}

function clearWakeAutoStopTimer() {
  if (!state.voice.autoStopTimer) {
    return;
  }

  clearTimeout(state.voice.autoStopTimer);
  state.voice.autoStopTimer = null;
}

function getWakeWordRegex(flags = "i") {
  return new RegExp("h(?:ey|ei|i)\\s*[,.!?，。！？、\\s-]*l\\s*o\\s*r\\s*a", flags);
}

function stripLeadingWakeWords(text) {
  const source = String(text || "").trim();
  if (!source) {
    return "";
  }

  const pattern = new RegExp(
    `^(?:\\s*(?:${getWakeWordRegex().source})[,.!?，。！？、\\s-]*)+`,
    "i"
  );

  return source.replace(pattern, "").trim();
}

function getWakeWordMatch(text) {
  const source = String(text || "");
  const match = getWakeWordRegex("i").exec(source);
  if (!match) {
    return null;
  }

  return {
    index: match.index,
    end: match.index + match[0].length
  };
}

function getWakeVisibleTranscript(text) {
  const source = String(text || "");
  const match = getWakeWordMatch(source);
  if (!match) {
    return null;
  }

  return stripLeadingWakeWords(source.slice(match.index));
}

function activateWakeSession(word) {
  state.voice.wakeTriggered = true;
  state.voice.shouldSendOnStop = true;
  state.voice.partialText = "";
  state.voice.finalText = "";
  updateVoiceStatus(`已唤醒，正在听 “${word || state.voice.wakeWord}” 后的内容`);
  resetVoiceTranscript("已唤醒，请继续说...");
  syncVoiceInteractionUi();
  scheduleWakeAutoStop(false);
  playVoiceCue("start");
}

function scheduleWakeAutoStop(hasContent = false) {
  clearWakeAutoStopTimer();

  if (
    !state.voice.recording ||
    !state.voice.wakeListening ||
    !state.voice.wakeTriggered ||
    state.streaming
  ) {
    return;
  }

  state.voice.autoStopTimer = window.setTimeout(() => {
    stopVoiceCapture("wake-timeout");
  }, hasContent ? WAKE_CONTENT_IDLE_MS : WAKE_PROMPT_IDLE_MS);
}

function syncVoiceInteractionUi() {
  elements.voicePanel.dataset.voiceMode = state.voice.interactionMode;
  elements.manualVoiceButton.classList.toggle("is-active", state.voice.interactionMode === "manual");
  elements.wakeVoiceButton.classList.toggle("is-active", state.voice.interactionMode === "wake");

  if (state.voice.interactionMode === "wake") {
    elements.voiceHint.textContent = `持续监听麦克风，命中唤醒词 “${state.voice.wakeWord}” 后开始会话。`;
    elements.wakeListeningButton.textContent = state.voice.recording ? "停止待命" : "开始待命";
    return;
  }

  elements.voiceHint.textContent = "按住说话，或点击开始说话。";
  elements.toggleRecordingButton.textContent = state.voice.recording ? "点击停止说话" : "点击开始说话";
}

function getVoiceCapabilityError() {
  if (!window.isSecureContext) {
    return "当前页面不是安全上下文。语音模式请使用 https 页面，或在本机通过 localhost 访问。";
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    return "当前浏览器环境不支持 mediaDevices.getUserMedia。";
  }

  if (typeof AudioContext === "undefined") {
    return "当前浏览器环境不支持 AudioContext。";
  }

  if (typeof AudioWorkletNode === "undefined") {
    return "当前浏览器环境不支持 AudioWorklet。";
  }

  return "";
}

async function cleanupVoiceCapture() {
  if (state.voice.workletNode) {
    state.voice.workletNode.port.onmessage = null;
    state.voice.workletNode.disconnect();
    state.voice.workletNode = null;
  }

  if (state.voice.sourceNode) {
    state.voice.sourceNode.disconnect();
    state.voice.sourceNode = null;
  }

  if (state.voice.mediaStream) {
    for (const track of state.voice.mediaStream.getTracks()) {
      track.stop();
    }
    state.voice.mediaStream = null;
  }

  if (state.voice.audioContext) {
    await state.voice.audioContext.close();
    state.voice.audioContext = null;
  }
}

function disconnectVoiceSocket() {
  if (state.voice.socket) {
    if (
      state.voice.socket.readyState === WebSocket.OPEN ||
      state.voice.socket.readyState === WebSocket.CONNECTING
    ) {
      state.voice.socket.close();
    }
    state.voice.socket = null;
  }
}

async function finishVoiceSession() {
  clearWakeAutoStopTimer();
  await cleanupVoiceCapture();
  disconnectVoiceSocket();
  state.voice.recording = false;
  state.voice.waitingFinal = false;
  state.voice.wakeListening = false;
  state.voice.wakeTriggered = false;
  state.voice.shouldSendOnStop = false;
  elements.holdToTalkButton.disabled = false;
  elements.toggleRecordingButton.disabled = false;
  elements.wakeListeningButton.disabled = false;
  syncVoiceInteractionUi();
}

function getVoiceSocketUrl() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${state.voice.wsPath}`;
}

async function sendChatPrompt(prompt) {
  const normalizedPrompt = String(prompt || "").trim();
  if (!normalizedPrompt || state.streaming) {
    return;
  }

  const userMessage = createMessage("user", normalizedPrompt);
  state.messages.push(userMessage);
  saveSettings();
  await streamChat();
}

async function handleVoiceTranscriptCommit() {
  const transcript = stripLeadingWakeWords(
    (state.voice.finalText || state.voice.partialText || "").trim()
  );
  if (!transcript) {
    resetVoiceTranscript("没有识别到有效语音。");
    await maybeResumeWakeStandby();
    return;
  }

  updateVoiceStatus("识别完成");
  resetVoiceTranscript(transcript);
  await sendChatPrompt(transcript);
}

function buildPayload() {
  return {
    baseUrl: elements.baseUrlInput.value.trim(),
    model: elements.modelInput.value.trim(),
    systemPrompt: elements.systemPromptInput.value.trim(),
    temperature: Number(elements.temperatureInput.value),
    maxTokens: Number(elements.maxTokensInput.value),
    enableThinking: elements.enableThinkingInput.checked,
    messages: state.messages.map(({ role, content }) => ({ role, content }))
  };
}

function parseSseEvent(rawEvent) {
  const lines = rawEvent.replace(/\r/g, "").split("\n");
  let eventName = "message";
  const dataParts = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataParts.push(line.slice(5).trimStart());
    }
  }

  return {
    event: eventName,
    data: dataParts.join("\n")
  };
}

function appendAssistantDelta(message, data) {
  if (!data || data === "[DONE]") {
    return false;
  }

  try {
    const payload = JSON.parse(data);
    const delta = payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content ?? "";
    if (delta) {
      message.content += delta;
      renderMessageContent(message);
      scrollMessagesToBottom();
    }
  } catch (error) {
    message.content += data;
    renderMessageContent(message);
    scrollMessagesToBottom();
  }

  return true;
}

async function streamChat() {
  setStreaming(true);
  startSpeechStream();

  const assistantMessage = createMessage("assistant", "");
  let shouldSpeak = false;

  try {
    const response = await fetch(API_CHAT_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildPayload())
    });

    if (!response.ok || !response.body) {
      const errorPayload = await response.json().catch(() => ({ error: "Request failed." }));
      assistantMessage.content = `请求失败：${errorPayload.error || "Unknown error"}${
        errorPayload.details ? `\n${errorPayload.details}` : ""
      }`;
      renderMessageContent(assistantMessage);
      return;
    }

    shouldSpeak = true;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.replace(/\r\n/g, "\n").split("\n\n");
      buffer = events.pop() || "";

      for (const rawEvent of events) {
        const { event, data } = parseSseEvent(rawEvent);

        if (event === "meta") {
          continue;
        }

        if (event === "error") {
          try {
            const payload = JSON.parse(data);
            assistantMessage.content += `\n[stream error] ${payload.details || payload.error}`;
          } catch (error) {
            assistantMessage.content += `\n[stream error] ${data}`;
          }
          renderMessageContent(assistantMessage);
          continue;
        }

        const shouldContinue = appendAssistantDelta(assistantMessage, data);
        if (shouldSpeak) {
          updateSpeechStream(assistantMessage.content);
        }
        if (!shouldContinue && data === "[DONE]") {
          break;
        }
      }
    }
  } catch (error) {
    assistantMessage.content = `请求异常：${error.message}`;
    renderMessageContent(assistantMessage);
  } finally {
    assistantMessage.content = assistantMessage.content.trim() || "模型没有返回内容。";
    renderMessageContent(assistantMessage);
    state.messages.push(assistantMessage);
    setStreaming(false);
    scrollMessagesToBottom();
    if (shouldSpeak) {
      updateSpeechStream(assistantMessage.content, { force: true });
      await waitForSpeechDrain();
    }
    await maybeResumeWakeStandby();
  }
}

async function loadHealth() {
  elements.healthBadge.textContent = "检查模型服务中...";

  try {
    const response = await fetch(API_HEALTH_PATH);
    const payload = await response.json();

    if (!elements.baseUrlInput.value.trim()) {
      elements.baseUrlInput.value = payload.defaults.baseUrl;
    }
    if (!elements.modelInput.value.trim()) {
      elements.modelInput.value = payload.defaults.model;
    }
    if (!elements.systemPromptInput.value.trim()) {
      elements.systemPromptInput.value = payload.defaults.systemPrompt;
    }
    if (!elements.maxTokensInput.value.trim() && payload.defaults.maxTokens) {
      elements.maxTokensInput.value = payload.defaults.maxTokens;
    }
    if (payload.voice?.wsPath) {
      state.voice.wsPath = payload.voice.wsPath;
    }
    if (payload.voice?.audio?.sampleRate) {
      state.voice.sampleRate = payload.voice.audio.sampleRate;
    }
    if (payload.voice?.audio?.channels) {
      state.voice.channels = payload.voice.audio.channels;
    }
    if (payload.voice?.audio?.encoding) {
      state.voice.format = payload.voice.audio.encoding;
    }
    if (payload.voice?.audio?.frameMs) {
      state.voice.frameMs = payload.voice.audio.frameMs;
    }

    const ttsStatus = payload.tts?.upstreamOk ? "TTS Ready" : "TTS Unavailable";
    elements.healthBadge.textContent = payload.upstreamOk
      ? `Upstream Ready · ${payload.defaults.model} · ${ttsStatus}`
      : `Upstream Unreachable · ${ttsStatus}`;
    saveSettings();
  } catch (error) {
    elements.healthBadge.textContent = "Health Check Failed";
  }
}

function handleWakeTranscript(text, isFinal) {
  if (!state.voice.wakeTriggered) {
    return;
  }

  const visibleText = stripLeadingWakeWords(String(text || "").trim());
  if (isFinal) {
    state.voice.finalText = visibleText || state.voice.finalText;
  }
  if (visibleText) {
    state.voice.partialText = visibleText;
    scheduleWakeAutoStop(true);
  } else {
    scheduleWakeAutoStop(false);
  }

  resetVoiceTranscript(state.voice.finalText || state.voice.partialText || "已唤醒，请继续说...");
}

async function maybeResumeWakeStandby() {
  if (
    state.mode !== "voice" ||
    state.voice.interactionMode !== "wake" ||
    !state.voice.resumeWakeAfterSend ||
    state.voice.recording ||
    state.streaming
  ) {
    return;
  }

  state.voice.resumeWakeAfterSend = false;
  await startVoiceCapture("wake");
}

async function openVoiceSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(getVoiceSocketUrl());
    socket.binaryType = "arraybuffer";

    socket.addEventListener(
      "open",
      () => {
        state.voice.socket = socket;
        socket.send(
          JSON.stringify({
            type: "start",
            sampleRate: state.voice.sampleRate,
            channels: state.voice.channels,
            format: state.voice.format,
            frameMs: state.voice.frameMs,
            wakeWordEnabled: state.voice.interactionMode === "wake"
          })
        );
        resolve(socket);
      },
      { once: true }
    );

    socket.addEventListener("message", async (event) => {
      try {
        const payload = JSON.parse(event.data);

        if (payload.type === "ready" || payload.type === "started") {
          if (payload.wakeWordLabel) {
            state.voice.wakeWord = payload.wakeWordLabel;
            syncVoiceInteractionUi();
          }

          if (
            state.voice.interactionMode === "wake" &&
            payload.wakeWordEnabled !== false &&
            payload.wakeWordConfigured === false
          ) {
            updateVoiceStatus("唤醒词不可用");
            resetVoiceTranscript(payload.wakeWordReason || "Wake word engine unavailable.");
            return;
          }

          updateVoiceStatus(
            state.voice.interactionMode === "wake"
              ? `待命中，等待唤醒词 “${state.voice.wakeWord}”`
              : "正在聆听..."
          );
          return;
        }

        if (payload.type === "gateway" && payload.status === "connected") {
          updateVoiceStatus("语音链路已连接");
          return;
        }

        if (payload.type === "wake") {
          activateWakeSession(payload.word);
          return;
        }

        if (payload.type === "transcript") {
          if (state.voice.interactionMode === "wake" && state.voice.wakeListening) {
            handleWakeTranscript(payload.text, payload.isFinal);
            return;
          }

          if (payload.isFinal) {
            state.voice.finalText = payload.text || state.voice.finalText;
            state.voice.partialText = payload.text || state.voice.partialText;
          } else {
            state.voice.partialText = payload.text || state.voice.partialText;
          }

          resetVoiceTranscript(state.voice.finalText || state.voice.partialText || "正在识别...");
          return;
        }

        if (payload.type === "stopped") {
          const shouldSendOnStop = state.voice.shouldSendOnStop;
          const shouldResumeWakeAfterSend =
            state.voice.interactionMode === "wake" && state.voice.wakeTriggered && shouldSendOnStop;

          if (payload.text) {
            state.voice.finalText = payload.text;
            state.voice.partialText = payload.text;
          }
          await finishVoiceSession();
          if (shouldSendOnStop) {
            state.voice.resumeWakeAfterSend = shouldResumeWakeAfterSend;
            await handleVoiceTranscriptCommit();
          } else {
            updateVoiceStatus("待命已停止");
            resetVoiceTranscript(getDefaultVoiceTranscript());
          }
          return;
        }

        if (payload.type === "error") {
          updateVoiceStatus("识别出错");
          resetVoiceTranscript(payload.message || "语音识别服务异常。");
          await finishVoiceSession();
        }
      } catch (error) {
        console.error(error);
      }
    });

    socket.addEventListener(
      "error",
      () => {
        reject(new Error("Voice websocket connection failed."));
      },
      { once: true }
    );

    socket.addEventListener("close", () => {
      if (state.voice.recording || state.voice.waitingFinal) {
        updateVoiceStatus("语音连接已关闭");
      }
    });
  });
}

async function startVoiceCapture(trigger) {
  if (state.voice.recording || state.streaming) {
    return;
  }

  const capabilityError = getVoiceCapabilityError();
  if (capabilityError) {
    resetVoiceTranscript(`语音启动失败：${capabilityError}`);
    updateVoiceStatus("待命");
    return;
  }

  state.voice.partialText = "";
  state.voice.finalText = "";
  state.voice.waitingFinal = false;
  state.voice.wakeListening = trigger === "wake";
  state.voice.wakeTriggered = false;
  state.voice.shouldSendOnStop = trigger !== "wake";
  state.voice.resumeWakeAfterSend = false;
  clearWakeAutoStopTimer();

  if (trigger === "wake") {
    updateVoiceStatus(`待命中，等待唤醒词 “${state.voice.wakeWord}”`);
    resetVoiceTranscript(`等待唤醒词 “${state.voice.wakeWord}”...`);
  } else {
    updateVoiceStatus(trigger === "hold" ? "按住录音中..." : "录音中...");
    resetVoiceTranscript("正在建立语音链路...");
  }

  try {
    await openVoiceSocket();
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true
      }
    });

    const audioContext = new AudioContext({
      sampleRate: state.voice.sampleRate,
      latencyHint: "interactive"
    });
    await audioContext.audioWorklet.addModule("/audio-worklet.js");

    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    const workletNode = new AudioWorkletNode(audioContext, "pcm16-worklet");

    workletNode.port.onmessage = ({ data }) => {
      if (state.voice.socket?.readyState === WebSocket.OPEN) {
        state.voice.socket.send(data);
      }
    };

    sourceNode.connect(workletNode);

    state.voice.mediaStream = mediaStream;
    state.voice.audioContext = audioContext;
    state.voice.sourceNode = sourceNode;
    state.voice.workletNode = workletNode;
    state.voice.recording = true;

    if (state.voice.wakeListening) {
      updateVoiceStatus(`待命中，等待唤醒词 “${state.voice.wakeWord}”`);
      resetVoiceTranscript(`等待唤醒词 “${state.voice.wakeWord}”...`);
    } else {
      updateVoiceStatus("正在聆听...");
      resetVoiceTranscript("请开始说话...");
      playVoiceCue("start");
    }
    syncVoiceInteractionUi();
  } catch (error) {
    resetVoiceTranscript(`语音启动失败：${error.message}`);
    updateVoiceStatus("待命");
    await finishVoiceSession();
  }
}

async function stopVoiceCapture(reason = "manual") {
  if (!state.voice.recording) {
    return;
  }

  state.voice.recording = false;
  state.voice.waitingFinal = true;
  clearWakeAutoStopTimer();
  playVoiceCue("end");
  updateVoiceStatus(reason === "wake-timeout" ? "检测到停顿，正在发送..." : "正在收尾识别...");
  elements.holdToTalkButton.disabled = true;
  elements.toggleRecordingButton.disabled = true;
  elements.wakeListeningButton.disabled = true;
  elements.toggleRecordingButton.textContent = "处理中...";
  await cleanupVoiceCapture();

  if (state.voice.socket?.readyState === WebSocket.OPEN) {
    state.voice.socket.send(JSON.stringify({ type: "stop" }));
  } else {
    await finishVoiceSession();
  }
}

async function toggleVoiceRecording() {
  if (state.voice.recording) {
    await stopVoiceCapture();
    return;
  }

  await startVoiceCapture("toggle");
}

function setVoiceInteractionMode(mode) {
  if (state.voice.recording || state.voice.waitingFinal) {
    return;
  }

  if (state.voice.interactionMode === mode) {
    return;
  }

  clearWakeAutoStopTimer();
  state.voice.interactionMode = mode;
  state.voice.resumeWakeAfterSend = false;

  if (!state.voice.recording) {
    updateVoiceStatus("待命");
    resetVoiceTranscript();
  }

  syncVoiceInteractionUi();
  saveSettings();
}

async function toggleWakeStandby() {
  if (state.voice.recording) {
    state.voice.resumeWakeAfterSend = false;
    await stopVoiceCapture("manual");
    return;
  }

  await startVoiceCapture("wake");
}

async function beginHoldRecording(event) {
  event.preventDefault();
  if (state.voice.recording) {
    return;
  }

  if (typeof elements.holdToTalkButton.setPointerCapture === "function") {
    elements.holdToTalkButton.setPointerCapture(event.pointerId);
  }

  state.voice.holdActive = true;
  await startVoiceCapture("hold");
}

async function endHoldRecording(event) {
  if (event) {
    event.preventDefault();
  }

  if (!state.voice.holdActive) {
    return;
  }

  state.voice.holdActive = false;
  await stopVoiceCapture();
}

function clearConversation() {
  stopSpeechPlayback();
  state.messages = [];
  elements.messages.innerHTML = "";
  renderWelcome();
  resetVoiceTranscript();
}

elements.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const prompt = elements.promptInput.value.trim();
  if (!prompt) {
    elements.promptInput.focus();
    return;
  }

  elements.promptInput.value = "";
  autoGrowPrompt();
  await sendChatPrompt(prompt);
});

elements.promptInput.addEventListener("input", autoGrowPrompt);
elements.promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.chatForm.requestSubmit();
  }
});

for (const input of [
  elements.baseUrlInput,
  elements.modelInput,
  elements.systemPromptInput,
  elements.temperatureInput,
  elements.maxTokensInput
]) {
  input.addEventListener("change", saveSettings);
}

elements.textModeButton.addEventListener("click", () => setMode("text"));
elements.voiceModeButton.addEventListener("click", () => setMode("voice"));
elements.manualVoiceButton.addEventListener("click", () => setVoiceInteractionMode("manual"));
elements.wakeVoiceButton.addEventListener("click", () => setVoiceInteractionMode("wake"));
elements.enableThinkingInput.addEventListener("change", () => {
  syncSettingsFromInputs();
  saveSettings();
});
elements.hideThinkingInput.addEventListener("change", () => {
  syncSettingsFromInputs();
  saveSettings();
  rerenderMessages();
});
elements.renderMarkdownInput.addEventListener("change", () => {
  syncSettingsFromInputs();
  saveSettings();
  rerenderMessages();
});
elements.autoSpeakInput.addEventListener("change", () => {
  syncSettingsFromInputs();
  saveSettings();
  if (!state.tts.enabled) {
    stopSpeechPlayback();
  }
});

elements.toggleRecordingButton.addEventListener("click", toggleVoiceRecording);
elements.wakeListeningButton.addEventListener("click", toggleWakeStandby);
elements.holdToTalkButton.addEventListener("pointerdown", beginHoldRecording);
elements.holdToTalkButton.addEventListener("pointerup", endHoldRecording);
elements.holdToTalkButton.addEventListener("pointercancel", endHoldRecording);
elements.holdToTalkButton.addEventListener("lostpointercapture", endHoldRecording);
window.addEventListener("pointerup", endHoldRecording);

elements.clearButton.addEventListener("click", clearConversation);
elements.pingButton.addEventListener("click", loadHealth);

window.addEventListener("beforeunload", () => {
  clearWakeAutoStopTimer();
  stopSpeechPlayback();
  disconnectVoiceSocket();
});

applyStoredSettings();
applyConfigDefaults();
syncSettingsFromInputs();
setMode(state.mode);
syncVoiceInteractionUi();
renderWelcome();
autoGrowPrompt();
loadHealth();
