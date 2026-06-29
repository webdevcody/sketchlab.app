import { ICONS_SORTED } from "../render/icons";
import { parseGeneratedGraph, type GeneratedGraph } from "../state/generatedGraph";
import type { Board, ShapeKind } from "../state/types";

export const OPENAI_DIAGRAM_MODEL = "gpt-5.5";

const SESSION_KEY = "sketchlab:openai-api-key";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const CONTEXT_MAX_NODES = 48;
const CONTEXT_MAX_EDGES = 96;
const CONTEXT_MAX_LAYERS = 48;
const CONTEXT_MAX_TEXT = 160;
const CONTEXT_MAX_NAME = 80;

export type DiagramGenerationMode = "generate" | "modify";

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

export class OpenAIDiagramError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenAIDiagramError";
  }
}

export function getSessionOpenAIKey(): string {
  try {
    return sessionStorage.getItem(SESSION_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setSessionOpenAIKey(key: string): void {
  try {
    const trimmed = key.trim();
    if (trimmed) sessionStorage.setItem(SESSION_KEY, trimmed);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Browsers can disable sessionStorage; generation still works for this call.
  }
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

Return only data that matches the provided JSON schema. Do not include markdown.

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

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new OpenAIDiagramError("OpenAI returned an unexpected response shape");
}

function extractOutputText(payload: unknown): string {
  const root = readRecord(payload);
  if (typeof root.output_text === "string") return root.output_text;

  const output = root.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const itemRecord = readRecord(item);
      const content = itemRecord.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const partRecord = readRecord(part);
        if (typeof partRecord.text === "string") return partRecord.text;
      }
    }
  }

  throw new OpenAIDiagramError("OpenAI did not return diagram JSON");
}

async function readErrorMessage(res: Response): Promise<string> {
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
  if (res.status === 401) return "OpenAI rejected the API key.";
  if (res.status === 429) return "OpenAI rate limited the request or the key has no quota.";
  return `OpenAI request failed (${res.status} ${res.statusText || "error"}).`;
}

export async function generateDiagramWithOpenAI(opts: {
  apiKey: string;
  prompt: string;
  mode?: DiagramGenerationMode;
  currentBoard?: Board;
  signal?: AbortSignal;
}): Promise<GeneratedGraph> {
  const apiKey = opts.apiKey.trim();
  const prompt = opts.prompt.trim();
  const mode = opts.mode ?? "generate";
  if (!apiKey) throw new OpenAIDiagramError("Enter an OpenAI API key.");
  if (!prompt) throw new OpenAIDiagramError(
    mode === "modify" ? "Describe how to modify the diagram." : "Describe the diagram you want to generate.",
  );
  if (mode === "modify" && !opts.currentBoard) {
    throw new OpenAIDiagramError("There is no current diagram to modify.");
  }

  let res: Response;
  try {
    res = await fetch(RESPONSES_URL, {
      method: "POST",
      signal: opts.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_DIAGRAM_MODEL,
        input: promptContext(prompt, mode, opts.currentBoard),
        max_output_tokens: 4096,
        text: {
          format: {
            type: "json_schema",
            name: "sketch_lab_generated_graph",
            strict: true,
            schema: GENERATED_GRAPH_SCHEMA,
          },
        },
      }),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new OpenAIDiagramError("Generation was cancelled.");
    }
    throw new OpenAIDiagramError("Could not reach OpenAI. Check your connection and key.");
  }

  if (!res.ok) throw new OpenAIDiagramError(await readErrorMessage(res), res.status);

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractOutputText(await res.json()));
  } catch (err) {
    if (err instanceof OpenAIDiagramError) throw err;
    throw new OpenAIDiagramError("OpenAI returned invalid diagram JSON.");
  }

  try {
    return parseGeneratedGraph(parsed);
  } catch (err) {
    throw new OpenAIDiagramError(err instanceof Error ? err.message : "Generated diagram was invalid.");
  }
}
