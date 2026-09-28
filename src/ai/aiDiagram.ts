import { ICONS_SORTED } from "../render/icons";
import { parseGeneratedGraph, type GeneratedGraph } from "../state/generatedGraph";
import type { Board, ShapeKind } from "../state/types";

// First-visit default, before the user has ever picked a model. Once they pick one it's
// remembered (see getDefaultModel/setDefaultModel) and becomes the new default from then on.
export const DEFAULT_DIAGRAM_MODEL = "z-ai/glm-5.3-flash";

const CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODELS_URL = "https://openrouter.ai/api/v1/models";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const CONTEXT_MAX_NODES = 48;
const CONTEXT_MAX_EDGES = 96;
const CONTEXT_MAX_LAYERS = 48;
const CONTEXT_MAX_TEXT = 160;
const CONTEXT_MAX_NAME = 80;

export type DiagramGenerationMode = "generate" | "modify";

export interface DiagramModelOption {
  id: string;
  label: string;
}

// The app talks to one of two backends. OpenRouter is the default (many vendors behind a single
// key); OpenAI's own Responses API stays available because its strict json_schema mode pins the
// output shape better than OpenRouter's json_object does.
export type DiagramPlatform = "openrouter" | "openai";

export const DEFAULT_PLATFORM: DiagramPlatform = "openrouter";

export const OPENAI_DIAGRAM_MODEL = "gpt-5.5";

export const OPENAI_MODELS: DiagramModelOption[] = [
  { id: OPENAI_DIAGRAM_MODEL, label: "GPT-5.5" },
];

// Keys and model choices are stored per platform, so switching platforms never clobbers the
// other one's key or the model you last picked there.
const KEY_SESSION_KEYS: Record<DiagramPlatform, string> = {
  openrouter: "sketchlab:openrouter-api-key",
  openai: "sketchlab:openai-api-key",
};

const MODEL_STORAGE_KEYS: Record<DiagramPlatform, string> = {
  openrouter: "sketchlab:openrouter-model",
  openai: "sketchlab:openai-model",
};

const PLATFORM_STORAGE_KEY = "sketchlab:diagram-platform";

export function platformDisplayName(platform: DiagramPlatform): string {
  return platform === "openai" ? "OpenAI" : "OpenRouter";
}

export function defaultModelForPlatform(platform: DiagramPlatform): string {
  return platform === "openai" ? OPENAI_DIAGRAM_MODEL : DEFAULT_DIAGRAM_MODEL;
}

export const DEFAULT_PROVIDER = "z-ai";

// OpenRouter's catalog spans 60+ underlying vendors (Baidu, Rekaai, Prism MI, ...) -- listing
// all of them as "providers" makes a single-key OpenRouter integration look like 60 separate
// ones. The Provider picker only offers this well-known subset; everything else is still
// reachable via the Popular row or "+ Add custom model id", both of which accept any id.
export const KNOWN_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "meta-llama",
  "mistralai",
  "deepseek",
  "x-ai",
  "qwen",
  "cohere",
  "z-ai",
];

// OpenRouter model ids are "<provider>/<model>" (e.g. "openai/gpt-4o-mini").
export function modelProvider(modelId: string): string {
  return modelId.split("/")[0] || modelId;
}

// A few providers have a conventional display casing that plain title-casing gets wrong.
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  "meta-llama": "Meta",
  nvidia: "NVIDIA",
  "z-ai": "Z.ai",
  "x-ai": "xAI",
};

export function isFreeModel(id: string): boolean {
  return id.endsWith(":free");
}

export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Doubles as the "Popular" quick-pick row: current, cheap-tier models per major vendor. Picked
// for being both recent and inexpensive -- an older checkpoint left in this list often ends up
// pricier than its newer replacement once a vendor's current generation ships, so re-check
// pricing (not just "does it still exist") when updating this list, not just swapping names.
export const FALLBACK_MODELS: DiagramModelOption[] = [
  { id: "z-ai/glm-5.3-flash", label: "Z.ai: GLM 5.3 Flash" },
  { id: "openai/gpt-5-nano", label: "OpenAI: GPT-5 Nano" },
  { id: "anthropic/claude-haiku-4.5", label: "Anthropic: Claude Haiku 4.5" },
  { id: "google/gemini-3.5-flash", label: "Google: Gemini 3.5 Flash" },
];

const GENERATED_GRAPH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    layers: {
      type: "array",
      maxItems: 48,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1 },
          color: {
            type: "string",
            pattern: "^#[0-9a-fA-F]{6}$",
          },
        },
        required: ["name", "color"],
      },
    },
    nodes: {
      type: "array",
      minItems: 1,
      maxItems: 48,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          label: { type: "string", minLength: 1 },
          kind: { type: "string", enum: ["rect", "circle", "icon", "text"] },
          icon: { type: "string" },
          color: {
            type: "string",
            pattern: "^#[0-9a-fA-F]{6}$",
          },
          layer: { type: "integer", minimum: 0, maximum: 47 },
        },
        required: ["id", "label", "kind", "icon", "color", "layer"],
      },
    },
    edges: {
      type: "array",
      maxItems: 96,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "string", minLength: 1 },
          to: { type: "string", minLength: 1 },
          label: { type: "string" },
          directed: { type: "boolean" },
        },
        required: ["from", "to", "label", "directed"],
      },
    },
  },
  required: ["name", "layers", "nodes", "edges"],
} as const;

export class DiagramGenerationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DiagramGenerationError";
  }
}

export function getSessionApiKey(platform: DiagramPlatform): string {
  try {
    return sessionStorage.getItem(KEY_SESSION_KEYS[platform]) ?? "";
  } catch {
    return "";
  }
}

export function setSessionApiKey(platform: DiagramPlatform, key: string): void {
  try {
    const trimmed = key.trim();
    if (trimmed) sessionStorage.setItem(KEY_SESSION_KEYS[platform], trimmed);
    else sessionStorage.removeItem(KEY_SESSION_KEYS[platform]);
  } catch {
    // Browsers can disable sessionStorage; generation still works for this call.
  }
}

// The platform choice persists the same way the model choice does: picking one IS "setting the
// new default", so a user who prefers OpenAI's direct API keeps it across tabs and restarts.
export function getDefaultPlatform(): DiagramPlatform {
  try {
    return localStorage.getItem(PLATFORM_STORAGE_KEY) === "openai" ? "openai" : DEFAULT_PLATFORM;
  } catch {
    return DEFAULT_PLATFORM;
  }
}

export function setDefaultPlatform(platform: DiagramPlatform): void {
  try {
    localStorage.setItem(PLATFORM_STORAGE_KEY, platform);
  } catch {
    // Ignore; falls back to DEFAULT_PLATFORM next time.
  }
}

// Unlike the API key (sessionStorage -- cleared when the tab closes), the model choice lives
// in localStorage: picking a model IS "setting the new default" -- it persists across tabs and
// browser restarts, with the platform's default model only used the very first time.
export function getDefaultModel(platform: DiagramPlatform): string {
  const fallback = defaultModelForPlatform(platform);
  try {
    return localStorage.getItem(MODEL_STORAGE_KEYS[platform]) || fallback;
  } catch {
    return fallback;
  }
}

export function setDefaultModel(platform: DiagramPlatform, model: string): void {
  try {
    if (model.trim()) localStorage.setItem(MODEL_STORAGE_KEYS[platform], model.trim());
  } catch {
    // Ignore; falls back to the platform's default model next time.
  }
}

let modelsPromise: Promise<DiagramModelOption[]> | null = null;

// Fetches OpenRouter's public model catalog (no API key required) and caches it for the
// lifetime of the page so opening the panel repeatedly doesn't refetch every time.
export function fetchAvailableModels(): Promise<DiagramModelOption[]> {
  if (!modelsPromise) {
    modelsPromise = fetch(MODELS_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`OpenRouter models request failed (${res.status})`);
        return res.json();
      })
      .then((payload: unknown) => {
        const data = (payload as { data?: unknown }).data;
        if (!Array.isArray(data)) throw new Error("Unexpected models response shape");
        const models = data
          .map((entry) => {
            const record = entry as { id?: unknown; name?: unknown };
            return typeof record.id === "string"
              ? { id: record.id, label: typeof record.name === "string" ? record.name : record.id }
              : null;
          })
          .filter((m): m is DiagramModelOption => m !== null)
          // "openrouter/*" ids are OpenRouter's own meta-routers (auto, free-model-router,
          // fusion, ...) — they pick a backend model dynamically rather than naming one, so
          // they don't fit "pick a provider, then a model" and can hang unpredictably.
          .filter((m) => modelProvider(m.id) !== "openrouter")
          .sort((a, b) => a.label.localeCompare(b.label));
        return models.length ? models : FALLBACK_MODELS;
      })
      .catch(() => FALLBACK_MODELS);
  }
  return modelsPromise;
}

function generatedKind(kind: ShapeKind): "rect" | "circle" | "icon" | "text" {
  return kind === "circle" || kind === "icon" || kind === "text" ? kind : "rect";
}

function clipText(value: string | undefined, max = CONTEXT_MAX_TEXT): string {
  const text = (value ?? "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function boardContext(board: Board): string {
  const sourceShapes = Object.values(board.shapes).slice(0, CONTEXT_MAX_NODES);
  const included = new Set(sourceShapes.map((shape) => shape.id));
  const shapes = sourceShapes.map((shape) => ({
    id: clipText(shape.id, 48),
    label: clipText(shape.text),
    kind: generatedKind(shape.kind),
    icon: clipText(shape.icon, 48),
    color: clipText(shape.fill, 16),
    layer: shape.layer ?? 0,
  }));
  const edges = Object.values(board.edges).filter((edge) =>
    edge.from !== undefined && edge.to !== undefined && included.has(edge.from) && included.has(edge.to),
  ).slice(0, CONTEXT_MAX_EDGES).map((edge) => ({
    from: clipText(edge.from, 48),
    to: clipText(edge.to, 48),
    label: clipText(edge.label),
    directed: !!edge.directed,
  }));
  const layers = (board.layers ?? []).slice(0, CONTEXT_MAX_LAYERS).map((layer) => ({
    name: clipText(layer.name, CONTEXT_MAX_NAME),
    color: clipText(layer.color, 16),
  }));
  return JSON.stringify({ name: clipText(board.name, CONTEXT_MAX_NAME), layers, nodes: shapes, edges });
}

function promptContext(userPrompt: string, mode: DiagramGenerationMode, currentBoard?: Board): string {
  const iconKeys = ICONS_SORTED.map((icon) => icon.key).join(", ");
  const modifyContext = mode === "modify" && currentBoard
    ? `
Current Sketch Lab graph JSON:
${boardContext(currentBoard)}

Modification mode:
- Apply the user request to the current graph.
- Return the full updated graph after the modification, not a partial patch.
- Preserve useful existing node ids, labels, edges, and layers unless the user asks to change them.
- Preserve each node's existing "layer" unless the change calls for moving it; keep the existing "layers" floors unless asked to restructure them.
- You may add, remove, rename, regroup, reconnect, or re-floor nodes when needed.
`
    : `
Generation mode:
- Create a new diagram from the user prompt.
`;
  return `You generate Sketch Lab architecture diagrams.

Respond with ONLY a single JSON object matching this JSON Schema — no markdown, no code fences, no commentary before or after it:
${JSON.stringify(GENERATED_GRAPH_SCHEMA)}

Sketch Lab graph rules:
- nodes become board shapes.
- edges connect node ids by "from" and "to".
- kind must be one of: rect, circle, icon, text.
- Use kind "icon" for infrastructure components, services, databases, queues, networks, users, clients, files, and cloud resources.
- Use kind "text" only for standalone annotations.
- Use valid #RRGGBB colors that read well on a dark canvas.
- Keep diagrams concise: prefer 4-14 nodes unless the user asks for more.
- Prefer directed edges for data flow, request flow, dependencies, or sequences.
- Valid icon keys: ${iconKeys}

Floors (layers):
- A board is a stack of named horizontal floors rendered in 3D. "layers" lists them bottom→top; index 0 is the ground floor.
- Every node has a "layer": the 0-based index of the floor it sits on. It must reference a floor in "layers" (or 0 for the ground floor).
- Use floors to separate a system into stacked tiers, zones, or planes — e.g. Client / Edge / Application / Data, or network segments, or environments. Put nodes that belong to the same tier on the same floor; edges (dependencies, data/request flow) may cross floors.
- Prefer floors only when the system has a natural vertical layering; 2-5 meaningful floors is typical. For a simple single-tier diagram, return "layers": [] and "layer": 0 for every node.
- Order floors bottom (foundational, e.g. Data) to top (user-facing, e.g. Client). The number of floors must cover the highest "layer" you use.
- Give each floor a short "name" and a bright, saturated #RRGGBB "color" that reads as a glowing frame on a dark canvas (e.g. #38bdf8 cyan, #4ade80 green, #fbbf24 amber, #fb923c orange, #f472b6 pink, #c084fc violet).
${modifyContext}

User prompt:
${userPrompt.trim()}`;
}

// Best-effort extraction for models that ignore the JSON-only instruction and wrap the
// object in prose or a markdown code fence.
function extractJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new DiagramGenerationError("The model did not return diagram JSON.");
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new DiagramGenerationError("The model returned invalid diagram JSON.");
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new DiagramGenerationError("The model returned an unexpected response shape");
}

function extractMessageContent(payload: unknown): string {
  const root = readRecord(payload);
  const choices = root.choices;
  if (Array.isArray(choices) && choices.length) {
    const message = readRecord(choices[0]).message;
    if (message) {
      const content = readRecord(message).content;
      if (typeof content === "string") return content;
    }
  }
  throw new DiagramGenerationError("The model did not return diagram JSON");
}

// OpenAI's Responses API returns the text in `output_text` (or as text parts under `output`),
// not in a chat-completions `choices[0].message.content`.
function extractOutputText(payload: unknown): string {
  const root = readRecord(payload);
  if (typeof root.output_text === "string") return root.output_text;

  const output = root.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const content = readRecord(item).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const text = readRecord(part).text;
        if (typeof text === "string") return text;
      }
    }
  }

  throw new DiagramGenerationError("The model did not return diagram JSON");
}

async function readErrorMessage(res: Response, platform: DiagramPlatform): Promise<string> {
  const name = platformDisplayName(platform);
  try {
    const data = readRecord(await res.json());
    const error = data.error;
    if (typeof error === "object" && error !== null && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  } catch {
    // Fall through to status-based messaging.
  }
  if (res.status === 401) return `${name} rejected the API key.`;
  if (res.status === 402 && platform === "openrouter") return "OpenRouter account has no credit for this model.";
  if (res.status === 429) return `${name} rate limited the request or the key has no quota.`;
  return `${name} request failed (${res.status} ${res.statusText || "error"}).`;
}

export async function generateDiagram(opts: {
  apiKey: string;
  platform?: DiagramPlatform;
  model: string;
  prompt: string;
  mode?: DiagramGenerationMode;
  currentBoard?: Board;
  signal?: AbortSignal;
}): Promise<GeneratedGraph> {
  const platform = opts.platform ?? DEFAULT_PLATFORM;
  const apiKey = opts.apiKey.trim();
  const model = opts.model.trim() || defaultModelForPlatform(platform);
  const prompt = opts.prompt.trim();
  const mode = opts.mode ?? "generate";
  if (!apiKey) throw new DiagramGenerationError(`Enter an ${platformDisplayName(platform)} API key.`);
  if (!prompt) throw new DiagramGenerationError(
    mode === "modify" ? "Describe how to modify the diagram." : "Describe the diagram you want to generate.",
  );
  if (mode === "modify" && !opts.currentBoard) {
    throw new DiagramGenerationError("There is no current diagram to modify.");
  }

  const input = promptContext(prompt, mode, opts.currentBoard);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  let body: unknown;
  if (platform === "openai") {
    body = {
      model,
      input,
      max_output_tokens: 4096,
      text: {
        format: {
          type: "json_schema",
          name: "sketch_lab_generated_graph",
          strict: true,
          schema: GENERATED_GRAPH_SCHEMA,
        },
      },
    };
  } else {
    headers["HTTP-Referer"] = "https://sketch-lab.carvisgsi.xyz";
    headers["X-Title"] = "Sketch Lab";
    body = {
      model,
      messages: [{ role: "user", content: input }],
      max_tokens: 4096,
      response_format: { type: "json_object" },
    };
  }

  let res: Response;
  try {
    res = await fetch(platform === "openai" ? RESPONSES_URL : CHAT_COMPLETIONS_URL, {
      method: "POST",
      signal: opts.signal,
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new DiagramGenerationError("Generation was cancelled.");
    }
    throw new DiagramGenerationError(`Could not reach ${platformDisplayName(platform)}. Check your connection and key.`);
  }

  if (!res.ok) throw new DiagramGenerationError(await readErrorMessage(res, platform), res.status);

  const payload = await res.json();
  const parsed = extractJsonObject(
    platform === "openai" ? extractOutputText(payload) : extractMessageContent(payload),
  );

  try {
    return parseGeneratedGraph(parsed);
  } catch (err) {
    throw new DiagramGenerationError(err instanceof Error ? err.message : "Generated diagram was invalid.");
  }
}
