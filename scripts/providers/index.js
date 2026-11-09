/**
 * LLM providers. Every provider exposes
 *   complete({ system, user, schema, signal }) -> Promise<{ text, usage: { input, output } }>
 * All requests are made directly from the GM's browser with `fetch`, so only APIs that allow
 * browser (CORS) requests can be used. DeepL, for example, does not and is therefore not offered.
 */

export const PROVIDERS = {
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-5-mini",
    keyUrl: "https://platform.openai.com/api-keys",
    create: (cfg) => openAICompatible({ ...cfg, baseUrl: "https://api.openai.com/v1", strictSchema: true })
  },
  anthropic: {
    label: "Anthropic (Claude)",
    defaultModel: "claude-opus-5-5",
    keyUrl: "https://platform.claude.com/settings/keys",
    create: (cfg) => anthropic(cfg)
  },
  gemini: {
    label: "Google Gemini",
    defaultModel: "gemini-2.5-flash",
    keyUrl: "https://aistudio.google.com/apikey",
    create: (cfg) => gemini(cfg)
  },
  compatible: {
    label: "OpenAI-compatible (OpenRouter, Mistral, Ollama, LM Studio, ...)",
    defaultModel: "",
    keyUrl: "",
    create: (cfg) => openAICompatible({ ...cfg, strictSchema: false })
  }
};

export class ProviderError extends Error {
  constructor(message, { status, fatal = false } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.fatal = fatal;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });

/** POST JSON with retries on rate limits, overload and network errors. */
export async function postJSON(url, { headers, body, signal, retries = 5, fetchImpl = globalThis.fetch }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = new ProviderError(`Network error: ${err.message}`);
      await sleep(Math.min(30000, 1000 * 2 ** attempt), signal);
      continue;
    }
    if (res.ok) return res.json();

    let detail = "";
    try {
      const j = await res.json();
      detail = j?.error?.message ?? j?.message ?? JSON.stringify(j);
    } catch {
      detail = res.statusText;
    }
    const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
    // 401/403: wrong key; 404: unknown model. Retrying cannot help, so stop the whole job.
    const fatal = [401, 403, 404].includes(res.status);
    lastError = new ProviderError(`HTTP ${res.status}: ${detail}`, { status: res.status, fatal });
    if (!retryable) throw lastError;
    const ra = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60000, 2000 * 2 ** attempt), signal);
  }
  throw lastError;
}

function requireKey(apiKey, label) {
  if (!apiKey) throw new ProviderError(`No API key configured for ${label}.`, { fatal: true });
}

/** OpenAI Chat Completions, and any server that speaks the same protocol. */
export function openAICompatible({ apiKey, model, baseUrl, strictSchema, fetchImpl }) {
  if (!baseUrl) throw new ProviderError("No base URL configured for the OpenAI-compatible provider.", { fatal: true });
  if (strictSchema) requireKey(apiKey, "OpenAI");
  if (!model) throw new ProviderError("No model configured.", { fatal: true });
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    async complete({ system, user, schema, signal }) {
      const body = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        response_format: strictSchema
          ? { type: "json_schema", json_schema: { name: "translations", strict: true, schema } }
          : { type: "json_object" }
      };
      const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
      const data = await postJSON(url, { headers, body, signal, fetchImpl });
      const choice = data.choices?.[0];
      if (choice?.finish_reason === "length") throw new ProviderError("Response was cut off (output limit).");
      if (choice?.message?.refusal) throw new ProviderError(`Model refused: ${choice.message.refusal}`);
      return {
        text: choice?.message?.content ?? "",
        usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 }
      };
    }
  };
}

/** Anthropic Messages API, called directly from the browser. */
export function anthropic({ apiKey, model, effort, fetchImpl }) {
  requireKey(apiKey, "Anthropic");
  // Server-side fallback on safety refusals, supported by these models on the Claude API.
  const supportsFallback = /^claude-(opus-5-5|fable-5-1|sonnet-5-5)$/.test(model);
  return {
    async complete({ system, user, schema, signal }) {
      const body = {
        model,
        max_tokens: 32000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
        output_config: {
          ...(effort ? { effort } : {}),
          format: { type: "json_schema", schema }
        }
      };
      const headers = {
        "x-api-key": apiKey,
        "anthropic-version": "2026-10-21",
        "anthropic-dangerous-direct-browser-access": "true"
      };
      if (supportsFallback) {
        body.fallbacks = "default";
        headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
      }
      const data = await postJSON("https://api.anthropic.com/v1/messages", { headers, body, signal, fetchImpl });
      if (data.stop_reason === "refusal") {
        throw new ProviderError(`Model declined the request${data.stop_details?.category ? ` (${data.stop_details.category})` : ""}.`);
      }
      if (data.stop_reason === "max_tokens") throw new ProviderError("Response was cut off (output limit).");
      const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
      const u = data.usage ?? {};
      return {
        text,
        usage: {
          input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          output: u.output_tokens ?? 0
        }
      };
    }
  };
}

/** Google Gemini generateContent. */
export function gemini({ apiKey, model, fetchImpl }) {
  requireKey(apiKey, "Google Gemini");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  return {
    async complete({ system, user, signal }) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: { translations: { type: "ARRAY", items: { type: "STRING" } } },
            required: ["translations"]
          }
        }
      };
      const data = await postJSON(url, { headers: { "x-goog-api-key": apiKey }, body, signal, fetchImpl });
      const cand = data.candidates?.[0];
      if (!cand) throw new ProviderError(`No answer${data.promptFeedback?.blockReason ? ` (${data.promptFeedback.blockReason})` : ""}.`);
      if (cand.finishReason === "MAX_TOKENS") throw new ProviderError("Response was cut off (output limit).");
      const text = (cand.content?.parts ?? []).map((p) => p.text ?? "").join("");
      return {
        text,
        usage: { input: data.usageMetadata?.promptTokenCount ?? 0, output: data.usageMetadata?.candidatesTokenCount ?? 0 }
      };
    }
  };
}
