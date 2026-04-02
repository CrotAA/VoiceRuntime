window.VoiceRuntimeConfig = {
  api: {
    // 前端公开接口。改这里不会影响服务端真实上游，只影响浏览器请求入口。
    healthPath: "/api/health",
    chatPath: "/api/chat",
    ttsPath: "/api/tts",
    voiceWsPath: "/ws/voice"
  },
  runtime: {
    // 这里只是前端默认展示值。真实默认值以服务端环境变量和 /api/health 返回为准。
    defaults: {
      baseUrl: "",
      model: "",
      systemPrompt: "",
      temperature: 0.7,
      maxTokens: 4096
    }
  },
  deployment: {
    // 这些信息会一起提交到仓库，适合放公开说明，不适合放私有地址或密钥。
    profile: "generic",
    validatedHardware: "RTX 4090",
    validatedModels: {
      llm: "Qwen/Qwen3.5-9B",
      tts: "MeloTTS Chinese voice"
    }
  },
  voice: {
    // 唤醒后但还没开始说正文时，最多等待多久再结束，单位毫秒。
    wakePromptIdleMs: 4000,

    // 已经开始说正文后，静音多久就自动发送，单位毫秒。
    wakeContentIdleMs: 2000,

    // 前端默认展示的唤醒词名称。真正启用的词以服务端返回为准。
    defaultWakeWord: "hey jarvis"
  },
  tts: {
    // 回答完成后是否自动请求 TTS 并播放。
    autoPlay: true
  }
};

window.LoraRuntimeConfig = window.VoiceRuntimeConfig;
