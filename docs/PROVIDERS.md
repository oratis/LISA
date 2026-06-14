# LLM Provider configurations

> Lisa supports any LLM that exposes either Anthropic's Messages API or
> OpenAI's `/chat/completions` API. Most major providers expose one or
> the other. This doc lists configurations that work out of the box plus
> a generic catch-all path for anything else.
>
> Last updated: 2026-05-13.

---

## Picking a model

Lisa routes requests by **model name prefix** (case-insensitive):

| Model name starts with… | Routes to | API |
|---|---|---|
| `claude-` | Anthropic | Anthropic Messages |
| `gemini-` | Google | Gemini (own protocol) |
| `gpt-` / `o1` / `o3` / `o4` / `chatgpt-` | OpenAI | OpenAI Chat Completions |
| `deepseek-` | DeepSeek | OpenAI-compat |
| `mistral-` / `codestral-` / `magistral-` / `ministral-` / `pixtral-` | Mistral AI | OpenAI-compat |
| `sonar` / `sonar-` | Perplexity (Sonar) | OpenAI-compat |
| `grok-` | xAI | OpenAI-compat |
| `doubao-` / `ep-` | Volcengine Ark (Doubao) | OpenAI-compat |
| `qwen-` / `qwen2*` / `qwen3*` | Aliyun DashScope | OpenAI-compat |
| `moonshot-` / `kimi-` | Moonshot (Kimi) | OpenAI-compat |
| `glm-` / `chatglm-` | Zhipu | OpenAI-compat |
| `step-` | Stepfun | OpenAI-compat |
| `yi-` | 01.AI (Yi) | OpenAI-compat |
| `baichuan-` / `baichuan2*` / `baichuan3*` / `baichuan4*` | Baichuan | OpenAI-compat |
| `abab*` / `minimax-` | MiniMax | OpenAI-compat |
| `hunyuan-` | Tencent Hunyuan | OpenAI-compat |
| anything else (with `LISA_BASE_URL` set) | catch-all | OpenAI-compat |

Pass model with `--model <name>` or `LISA_MODEL=...` (set globally) or via the REPL.

**Providers without unique prefixes** (Groq / Together / Fireworks / OpenRouter etc. — they all host third-party models like Llama / Qwen / DeepSeek) → use the **catch-all path** (Recipe 10).

---

## Birth ritual: minimum model

[`lisa birth`](../src/soul/birth.ts) requires the model to output **strict JSON** with five fields (identity / purpose / constitution / first_value / first_desire). Smaller / quantized models fail this. Recommended floor:

| Provider | Birth-capable models |
|---|---|
| Anthropic | `claude-sonnet-4-5-20250929` and up |
| OpenAI | `gpt-4o`, `gpt-5`, `o3`, `o4` |
| Google Gemini | `gemini-2.5-pro` / `gemini-2.5-flash` (and up) |
| DeepSeek | `deepseek-chat` (V3.x) |
| Mistral | `mistral-large-latest`, `magistral-large-latest` |
| Perplexity | `sonar-pro`, `sonar-reasoning-pro` |
| xAI Grok | `grok-2`, `grok-3` |
| Volcengine | `doubao-1.5-pro-32k` and up |
| Aliyun | `qwen3-72b-instruct` and up |
| Moonshot | `moonshot-v1-32k` and up |
| Zhipu | `glm-4.5`, `glm-4-plus` |
| Stepfun | `step-2-16k`, `step-1-256k` |
| 01.AI | `yi-large`, `yi-lightning` |
| Baichuan | `Baichuan4` |
| MiniMax | `MiniMax-Text-01`, `abab6.5s-chat` |
| Hunyuan | `hunyuan-large`, `hunyuan-turbo-latest` |
| Local Ollama | `qwen2.5-32b-instruct`, `llama3.1-70b-instruct` and up |

After birth completes (one-time), daily conversations can use a cheaper / smaller model — the birth artifact (her seed and identity) is durable.

---

## Recipe 1: Anthropic Claude (default)

```sh
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> ~/.lisa/config.env
# default model is set in src/llm.ts; override per-session:
lisa --model claude-sonnet-4-5-20250929
```

If your network blocks `api.anthropic.com`:
```sh
echo 'ANTHROPIC_BASE_URL=https://your-proxy.example/anthropic' >> ~/.lisa/config.env
```
Or set `HTTPS_PROXY=http://127.0.0.1:7890` (Lisa auto-bridges to undici via [proxy-bootstrap.ts](../src/proxy-bootstrap.ts)).

---

## Recipe 2: OpenAI GPT (vanilla)

```sh
echo 'OPENAI_API_KEY=sk-...' >> ~/.lisa/config.env
lisa --model gpt-4o
```

For Azure OpenAI, point `OPENAI_BASE_URL` at your Azure endpoint:
```sh
echo 'OPENAI_BASE_URL=https://YOUR-RESOURCE.openai.azure.com/openai/v1' >> ~/.lisa/config.env
```

---

## Recipe 2.5: Google Gemini

```sh
echo 'GEMINI_API_KEY=...' >> ~/.lisa/config.env
# (GOOGLE_API_KEY also accepted — Google ships under both names.)
lisa --model gemini-2.5-pro
lisa --model gemini-2.5-flash         # fast & cheap, birth-capable
lisa --model gemini-2.0-flash         # earlier gen
```

Gemini uses its **own protocol** (not OpenAI-compatible), so Lisa ships
a dedicated provider class. Tool-use, system-instruction, and streaming
all work; tool-result text is wrapped as `{output: text}` (Gemini's
functionResponse needs a JSON object, not a string).

Limitations vs Anthropic / OpenAI:
- No prompt caching (Gemini has its own caching API but Lisa doesn't wire it yet)
- Single function-call per turn on some Gemini variants — Lisa handles
  multiple if emitted but doesn't rely on it.

To route through a Gemini-compatible relay, set `GEMINI_BASE_URL`.

---

## Recipe 3: DeepSeek (cheap, ~10x cheaper than GPT-4o)

```sh
echo 'DEEPSEEK_API_KEY=sk-...' >> ~/.lisa/config.env
lisa --model deepseek-chat        # daily use, V3
lisa --model deepseek-reasoner    # reasoning model
```

Lisa auto-routes `deepseek-*` to `https://api.deepseek.com/v1`. No other config needed.

DeepSeek has good tool-use compatibility with the OpenAI schema as of 2026.

---

## Recipe 4: Volcengine Ark / 豆包 (China-friendly)

You're already using this for Seedream pixel art if `SEEDREAM_API_KEY` is set. The same key works for LLM:

```sh
# ARK_API_KEY may be the same as your Seedream key (Volcengine unified billing).
echo 'ARK_API_KEY=...' >> ~/.lisa/config.env
lisa --model doubao-1.5-pro-32k
# Or: lisa --model ep-20260101010101-xxxxx  (custom endpoint ID)
```

Routes to `https://ark.cn-beijing.volces.com/api/v3`. Direct from mainland China without a proxy.

---

## Recipe 5: Ollama (local, fully offline)

[Install Ollama](https://ollama.com), pull a model, then point Lisa at it:

```sh
ollama pull qwen2.5-32b-instruct       # ~20 GB, birth-capable
ollama serve &                          # default port 11434

# In ~/.lisa/config.env:
echo 'LISA_BASE_URL=http://localhost:11434/v1' >> ~/.lisa/config.env
echo 'LISA_API_KEY=ollama' >> ~/.lisa/config.env  # any non-empty string

lisa --model qwen2.5-32b-instruct
```

Ollama's OpenAI-compat is at `/v1`. Tool use depends on the underlying model — `qwen2.5` and `llama3.1` both support it; smaller models often don't.

**Two ways to use local models, to be clear about what LISA does:**
- **Bring your own endpoint** (above) — you run Ollama / LM Studio / vLLM and point `LISA_BASE_URL` at it. LISA is just an OpenAI-compat client; it does not manage the server.
- **Managed lifecycle** — `lisa model list / install <model> / use local://<model> / health` drives a local Ollama backend for you (pull + switch). Same runtime as above; it just automates the pull and the config switch. It does **not** bundle or fine-tune a model.

---

## Recipe 6: Moonshot (Kimi, China)

```sh
echo 'MOONSHOT_API_KEY=sk-...' >> ~/.lisa/config.env
lisa --model moonshot-v1-32k       # 32k context
lisa --model moonshot-v1-128k      # 128k context
```

Routes to `https://api.moonshot.cn/v1`. Strong long-context.

---

## Recipe 7: Aliyun DashScope (Qwen, China)

```sh
echo 'DASHSCOPE_API_KEY=sk-...' >> ~/.lisa/config.env
lisa --model qwen3-72b-instruct
lisa --model qwen-max
```

Routes to `https://dashscope.aliyuncs.com/compatible-mode/v1`.

---

## Recipe 8: xAI Grok

```sh
echo 'XAI_API_KEY=xai-...' >> ~/.lisa/config.env
lisa --model grok-2-latest
lisa --model grok-3
```

Routes to `https://api.x.ai/v1`.

---

## Recipe 9: Zhipu GLM (China)

```sh
echo 'ZHIPU_API_KEY=...' >> ~/.lisa/config.env
lisa --model glm-4-plus
lisa --model glm-4.5
```

Routes to `https://open.bigmodel.cn/api/paas/v4`.

---

## Recipe 10: Mistral AI

```sh
echo 'MISTRAL_API_KEY=...' >> ~/.lisa/config.env
lisa --model mistral-large-latest
lisa --model magistral-large-latest    # reasoning
lisa --model codestral-latest          # code
lisa --model ministral-8b-latest       # cheap & fast
```

Routes to `https://api.mistral.ai/v1`. Strong on European-language work; good tool-use fidelity from `mistral-large` upward.

---

## Recipe 11: Perplexity (Sonar)

```sh
echo 'PERPLEXITY_API_KEY=pplx-...' >> ~/.lisa/config.env
lisa --model sonar              # cheap online search
lisa --model sonar-pro          # better quality
lisa --model sonar-reasoning-pro
```

Routes to `https://api.perplexity.ai`. Sonar models include built-in web search — useful when Lisa needs current information and you don't want her to spin up `web_search` separately.

---

## Recipe 12: Stepfun (Step, China)

```sh
echo 'STEPFUN_API_KEY=...' >> ~/.lisa/config.env
lisa --model step-2-16k
lisa --model step-1-256k        # very long context
```

Routes to `https://api.stepfun.com/v1`. Stepfun is one of the newer Chinese labs; tool-use solid in `step-2`.

---

## Recipe 13: 01.AI (Yi, China)

```sh
echo 'LINGYI_API_KEY=...' >> ~/.lisa/config.env
lisa --model yi-large
lisa --model yi-lightning       # cheap
lisa --model yi-vision          # multi-modal
```

Routes to `https://api.lingyiwanwu.com/v1`. (env var is `LINGYI_API_KEY` per 01.ai's docs; company name is 零一万物 / Lingyi Wanwu.)

---

## Recipe 14: Baichuan (China)

```sh
echo 'BAICHUAN_API_KEY=sk-...' >> ~/.lisa/config.env
lisa --model Baichuan4
lisa --model Baichuan2-Turbo
```

Routes to `https://api.baichuan-ai.com/v1`. Model IDs ship in title-case; Lisa's prefix match is case-insensitive so `--model Baichuan4` works directly.

---

## Recipe 15: MiniMax (China)

```sh
echo 'MINIMAX_API_KEY=...' >> ~/.lisa/config.env
lisa --model MiniMax-Text-01        # newer flagship
lisa --model abab6.5s-chat          # cheap & fast
```

Routes to `https://api.minimax.io/v1`. Both the `abab*` family (older naming) and the `MiniMax-*` family (newer) work.

---

## Recipe 16: Tencent Hunyuan

```sh
echo 'HUNYUAN_API_KEY=...' >> ~/.lisa/config.env
lisa --model hunyuan-large
lisa --model hunyuan-turbo-latest
```

Routes to `https://api.hunyuan.cloud.tencent.com/v1`. Tencent's flagship; direct from mainland China with no proxy.

---

## Recipe 17: Anything else (catch-all)

Any OpenAI-compatible endpoint works via the catch-all override — set `LISA_BASE_URL` and use any model name your endpoint accepts:

```sh
echo 'LISA_BASE_URL=https://your-endpoint.example/v1' >> ~/.lisa/config.env
echo 'LISA_API_KEY=...' >> ~/.lisa/config.env
lisa --model whatever-model-name
```

This route fires when the model name doesn't match any preset prefix. Common configurations:

### Groq (very fast inference of open-weight models)

```sh
echo 'LISA_BASE_URL=https://api.groq.com/openai/v1' >> ~/.lisa/config.env
echo 'LISA_API_KEY=gsk_...' >> ~/.lisa/config.env
lisa --model llama-3.3-70b-versatile     # birth-capable
lisa --model llama-3.1-8b-instant        # too small for birth, fine for chat
lisa --model mixtral-8x7b-32768
```

Sub-second token latency on Llama / Mixtral / Gemma — great for daily chat once Lisa is born.

### Together AI

```sh
echo 'LISA_BASE_URL=https://api.together.xyz/v1' >> ~/.lisa/config.env
echo 'LISA_API_KEY=...' >> ~/.lisa/config.env
lisa --model meta-llama/Llama-3.3-70B-Instruct-Turbo
lisa --model deepseek-ai/DeepSeek-V3
lisa --model Qwen/Qwen2.5-72B-Instruct-Turbo
```

Together hosts a huge model catalog. Use their exact slug (quote it — contains a `/`).

### Fireworks AI

```sh
echo 'LISA_BASE_URL=https://api.fireworks.ai/inference/v1' >> ~/.lisa/config.env
echo 'LISA_API_KEY=fw_...' >> ~/.lisa/config.env
lisa --model accounts/fireworks/models/llama-v3p3-70b-instruct
lisa --model accounts/fireworks/models/qwen2p5-72b-instruct
```

### OpenRouter (one key, 100+ models)

```sh
echo 'LISA_BASE_URL=https://openrouter.ai/api/v1' >> ~/.lisa/config.env
echo 'LISA_API_KEY=sk-or-...' >> ~/.lisa/config.env
lisa --model "anthropic/claude-sonnet-4-5"
lisa --model "google/gemini-2.5-pro"
lisa --model "deepseek/deepseek-chat"
```

⚠ OpenRouter's slugs contain `/`. Quote the model name. Also: `LISA_BASE_URL` being set means Lisa **doesn't** re-route based on the slug's prefix — `anthropic/claude-...` goes through OpenRouter, not directly to Anthropic.

### Azure OpenAI

```sh
echo 'OPENAI_BASE_URL=https://YOUR-RESOURCE.openai.azure.com/openai/v1' >> ~/.lisa/config.env
echo 'OPENAI_API_KEY=...' >> ~/.lisa/config.env
lisa --model gpt-4o
```

### one-api / new-api / self-hosted relay

```sh
echo 'LISA_BASE_URL=https://your-one-api.example/v1' >> ~/.lisa/config.env
echo 'LISA_API_KEY=sk-...' >> ~/.lisa/config.env
lisa --model <whatever-channel-name>
```

If `curl https://your-one-api/v1/models` works, Lisa works.

### LM Studio / vLLM / llama.cpp server (local)

```sh
echo 'LISA_BASE_URL=http://localhost:1234/v1' >> ~/.lisa/config.env   # LM Studio default
echo 'LISA_API_KEY=lm-studio' >> ~/.lisa/config.env
lisa --model qwen2.5-coder-32b-instruct
```

Same idea as Ollama (Recipe 5); only the port + key string differs.

---

If you'd like a new provider added to the preset table (no `LISA_BASE_URL` needed), send a PR or open an issue with: provider name, baseURL, API key env var, the unique model-name prefix(es).

---

## Mixing providers in one session

Lisa picks the provider per request based on the active model. You can switch mid-session:

```sh
# Birth with claude (most reliable JSON)
lisa --model claude-sonnet-4-5-20250929 birth

# Daily chat with deepseek (cheap)
lisa --model deepseek-chat
```

Her soul / journal / desires don't care which model wrote them. The birth artifact is one-time; subsequent sessions can use any model that supports tool-use.

---

## Caveats by provider

| Provider | Notes |
|---|---|
| Anthropic | Best tool-use fidelity. Native streaming. Birth ritual most reliable. |
| OpenAI | Equal tool-use. Rate limits more aggressive on free tier. |
| Google Gemini | Tool-use + streaming OK. No prompt caching wired (yet). Some models emit at most one function call per turn. |
| DeepSeek | Good tool-use as of V3. Birth works. Streaming OK. |
| Volcengine | Tool-use varies by model. Doubao-1.5-pro tested. China-direct. |
| Ollama | Tool-use depends on model. `qwen2.5` and `llama3.1` work. Smaller models often fake tool calls. |
| Moonshot | Tool-use OK. Long context strong (128k). |
| Aliyun Qwen | Tool-use OK on Qwen 2.5+ / Qwen 3. |
| Grok | Tool-use OK. Streaming OK. |
| Zhipu | Tool-use OK on GLM-4.5+. |
| Mistral | Tool-use solid from `mistral-large`+. EU-hosted. |
| Perplexity Sonar | Built-in web search; tool-use limited (the model already retrieves). Use for current-events queries. |
| Stepfun | Tool-use solid on `step-2`. Long context up to 256k on `step-1`. |
| 01.AI Yi | Tool-use OK on `yi-large`. `yi-vision` for multimodal. |
| Baichuan | Tool-use OK on `Baichuan4`. Older `Baichuan2-Turbo` is text-only. |
| MiniMax | Tool-use stable on `MiniMax-Text-01`+. `abab*` legacy. |
| Hunyuan | Tool-use OK on `hunyuan-large`/`hunyuan-turbo-latest`. China-direct. |
| Groq | OpenAI-compat. Llama/Mixtral/Gemma. Sub-second latency. Tool-use depends on model. |
| Together / Fireworks | Open-weight aggregators. Tool-use depends on the specific model you select. |
| OpenRouter | Routes to many providers behind one API. Tool-use depends on the underlying model. |

If birth or a tool-heavy session fails on a given provider, fall back to Claude or GPT for that session.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `403 forbidden — Request not allowed` | Geo-blocked from Anthropic | Set `HTTPS_PROXY` or `ANTHROPIC_BASE_URL=...` |
| Birth ritual returns malformed JSON | Model too small / weak | Use a birth-capable model (table above) |
| `Could not resolve authentication method` | Missing API key for selected model | Set the right `*_API_KEY` env var |
| Empty / gzip-garbled response | Local proxy strips Content-Encoding | Already handled by [proxy-bootstrap.ts](../src/proxy-bootstrap.ts) |
| Tool calls don't fire on Ollama | Model doesn't support tool-use | Use `qwen2.5` / `llama3.1-70b+` |
| Wrong baseURL on custom model | Model name doesn't match any preset | Set `LISA_BASE_URL` explicitly |

---

## Implementation notes

- Routing logic: [src/providers/registry.ts](../src/providers/registry.ts) — `OPENAI_COMPAT_PRESETS` table + `providerForModel()`.
- Anthropic provider: [src/providers/anthropic.ts](../src/providers/anthropic.ts) — accepts `baseURL`.
- OpenAI provider: [src/providers/openai.ts](../src/providers/openai.ts) — accepts `baseURL` + `apiKey` per request preset.
- Proxy bridge: [src/proxy-bootstrap.ts](../src/proxy-bootstrap.ts) — undici ProxyAgent + Content-Type re-injection (Clash-friendly).

To add a new preset, append to `OPENAI_COMPAT_PRESETS` in [src/providers/registry.ts](../src/providers/registry.ts). Five lines.
