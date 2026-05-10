# LLM Provider configurations

> Lisa supports any LLM that exposes either Anthropic's Messages API or
> OpenAI's `/chat/completions` API. Most major providers expose one or
> the other. This doc lists configurations that work out of the box plus
> a generic catch-all path for anything else.
>
> Last updated: 2026-05-10.

---

## Picking a model

Lisa routes requests by **model name prefix**:

| Model name starts with… | Routes to | API |
|---|---|---|
| `claude-` | Anthropic | Anthropic Messages |
| `gpt-` / `o1` / `o3` / `o4` / `chatgpt-` | OpenAI | OpenAI Chat Completions |
| `deepseek-` | DeepSeek | OpenAI-compat |
| `doubao-` / `ep-` | Volcengine Ark | OpenAI-compat |
| `qwen-` / `qwen2*` / `qwen3*` | Aliyun DashScope | OpenAI-compat |
| `moonshot-` / `kimi-` | Moonshot | OpenAI-compat |
| `grok-` | xAI | OpenAI-compat |
| `glm-` / `chatglm-` | Zhipu | OpenAI-compat |
| anything else (with `LISA_BASE_URL` set) | catch-all | OpenAI-compat |

Pass model with `--model <name>` or `LISA_MODEL=...` (set globally) or via the REPL.

---

## Birth ritual: minimum model

[`lisa birth`](../src/soul/birth.ts) requires the model to output **strict JSON** with five fields (identity / purpose / constitution / first_value / first_desire). Smaller / quantized models fail this. Recommended floor:

| Provider | Birth-capable models |
|---|---|
| Anthropic | `claude-sonnet-4-5-20250929` and up |
| OpenAI | `gpt-4o`, `gpt-5`, `o3`, `o4` |
| DeepSeek | `deepseek-chat` (V3.x) |
| Volcengine | `doubao-1.5-pro-32k` and up |
| Aliyun | `qwen3-72b-instruct` and up |
| Moonshot | `moonshot-v1-32k` and up |
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

## Recipe 10: Anything else (catch-all)

Any OpenAI-compatible endpoint works via the catch-all override:

```sh
echo 'LISA_BASE_URL=https://your-endpoint.example/v1' >> ~/.lisa/config.env
echo 'LISA_API_KEY=...' >> ~/.lisa/config.env
lisa --model whatever-model-name
```

This route fires when the model name doesn't match any preset prefix. Useful for:
- `one-api` self-hosted relay
- `openrouter` (proxy)
- Internal company LLM gateways
- Any new provider not yet in the preset table

If you'd like a new provider added to the preset table, send a PR or open an issue with: provider name, baseURL, API key env var, model name pattern.

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
| DeepSeek | Good tool-use as of V3. Birth works. Streaming OK. |
| Volcengine | Tool-use varies by model. Doubao-1.5-pro tested. China-direct. |
| Ollama | Tool-use depends on model. `qwen2.5` and `llama3.1` work. Smaller models often fake tool calls. |
| Moonshot | Tool-use OK. Long context strong (128k). |
| Aliyun Qwen | Tool-use OK on Qwen 2.5+ / Qwen 3. |
| Grok | Tool-use OK. Streaming OK. |
| Zhipu | Tool-use OK on GLM-4.5+. |

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
