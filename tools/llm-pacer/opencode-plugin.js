const PROVIDER_ID = "llm-pacer"
const PROVIDER_NAME = "LLM Pacer"
const BASE_URL = __LLM_PACER_BASE_URL__
const STATIC_CATALOG = __LLM_PACER_STATIC_CATALOG__
const DISCOVERY_TIMEOUT_MS = 2000

const ALLOWED_MODALITIES = new Set(["text", "audio", "image", "video", "pdf"])

function positive(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function boolean(value) {
  return typeof value === "boolean" ? value : undefined
}

function modalityList(value) {
  if (!Array.isArray(value)) return
  if (!value.every((item) => ALLOWED_MODALITIES.has(item))) return
  return [...value]
}

function toOpenCodeModel(item) {
  if (!item || typeof item !== "object") return
  if (typeof item.id !== "string" || item.id.trim() === "") return

  const metadata =
    item["x-llm-pacer"] && typeof item["x-llm-pacer"] === "object"
      ? item["x-llm-pacer"]
      : {}
  const capabilities =
    metadata.capabilities && typeof metadata.capabilities === "object"
      ? metadata.capabilities
      : {}
  const modalities =
    metadata.modalities && typeof metadata.modalities === "object"
      ? metadata.modalities
      : {}

  const context = positive(metadata.context_window)
  const output = positive(metadata.max_output_tokens)
  const inputModalities = modalityList(modalities.input)
  const outputModalities = modalityList(modalities.output)

  const model = {
    name:
      typeof metadata.name === "string" && metadata.name.trim() !== ""
        ? metadata.name
        : item.id,
    // OpenCode otherwise assumes tool support for a custom compatible model.
    tool_call: boolean(capabilities.tool_call) ?? false,
    reasoning: boolean(capabilities.reasoning) ?? false,
    attachment: boolean(capabilities.attachment) ?? false,
    temperature: boolean(capabilities.temperature) ?? false,
  }

  if (context !== undefined && output !== undefined) {
    model.limit = { context, output }
  }
  if (inputModalities !== undefined || outputModalities !== undefined) {
    model.modalities = {
      ...(inputModalities === undefined ? {} : { input: inputModalities }),
      ...(outputModalities === undefined ? {} : { output: outputModalities }),
    }
  }
  return [item.id, model]
}

function catalogItem(id, model) {
  const limits = model && typeof model.limits === "object" ? model.limits : {}
  return {
    id,
    object: "model",
    created: Number.isSafeInteger(model?.created) ? model.created : 0,
    owned_by:
      typeof model?.owner === "string" && model.owner.trim() !== ""
        ? model.owner
        : "upstream",
    "x-llm-pacer": {
      name:
        typeof model?.name === "string" && model.name.trim() !== ""
          ? model.name
          : id,
      context_window: limits.context,
      max_output_tokens: limits.output,
      capabilities:
        model && typeof model.capabilities === "object" ? model.capabilities : {},
      modalities: model && typeof model.modalities === "object" ? model.modalities : {},
    },
  }
}

function staticModels() {
  return Object.fromEntries(
    Object.entries(STATIC_CATALOG)
      .map(([id, model]) => toOpenCodeModel(catalogItem(id, model)))
      .filter(Boolean),
  )
}

async function discover(apiKey) {
  const response = await fetch(`${BASE_URL.replace(/\/+$/, "")}/models`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })

  if (!response.ok) throw new Error("model discovery failed")
  const payload = await response.json()
  if (!payload || payload.object !== "list" || !Array.isArray(payload.data)) {
    throw new Error("invalid model catalogue")
  }
  const entries = payload.data.map(toOpenCodeModel).filter(Boolean)
  if (entries.length === 0) throw new Error("empty model catalogue")
  return Object.fromEntries(entries)
}

export const LLMPacerProvider = async () => ({
  config: async (config) => {
    const apiKey = process.env.LLM_PACER_API_KEY
    let models = staticModels()

    if (apiKey) {
      try {
        models = await discover(apiKey)
      } catch {
        console.warn(
          "llm-pacer: model discovery unavailable; using the static catalogue",
        )
      }
    }

    config.provider ??= {}
    config.provider[PROVIDER_ID] = {
      name: PROVIDER_NAME,
      npm: "@ai-sdk/openai-compatible",
      env: ["LLM_PACER_API_KEY"],
      options: {
        baseURL: BASE_URL,
        headerTimeout: false,
        timeout: false,
      },
      models,
    }
  },
})
