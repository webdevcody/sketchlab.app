import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DIAGRAM_MODEL,
  DEFAULT_PLATFORM,
  DiagramGenerationError,
  defaultModelForPlatform,
  fetchAvailableModels,
  generateDiagram,
  getDefaultModel,
  getDefaultPlatform,
  isFreeModel,
  modelProvider,
  OPENAI_DIAGRAM_MODEL,
  platformDisplayName,
  providerDisplayName,
  setDefaultModel,
  setDefaultPlatform,
} from "../src/ai/aiDiagram";

describe("modelProvider / providerDisplayName / isFreeModel", () => {
  it("splits the provider prefix off an OpenRouter model id", () => {
    expect(modelProvider("openai/gpt-4o-mini")).toBe("openai");
    expect(modelProvider("meta-llama/llama-3.3-70b-instruct:free")).toBe("meta-llama");
  });

  it("title-cases a hyphenated provider slug, with a few known-name overrides", () => {
    expect(providerDisplayName("openai")).toBe("OpenAI");
    expect(providerDisplayName("meta-llama")).toBe("Meta");
    expect(providerDisplayName("google")).toBe("Google");
  });

  it("flags a :free-suffixed model id as free", () => {
    expect(isFreeModel("meta-llama/llama-3.3-70b-instruct:free")).toBe(true);
    expect(isFreeModel("openai/gpt-4o-mini")).toBe(false);
  });
});

describe("fetchAvailableModels filtering", () => {
  it("excludes OpenRouter's own meta-router models (openrouter/*)", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: "openrouter/free", name: "Free Models Router" },
            { id: "openrouter/auto", name: "Auto Router" },
            { id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o mini" },
          ],
        }),
      }),
    );
    const { fetchAvailableModels: freshFetch } = await import("../src/ai/aiDiagram");
    const models = await freshFetch();
    expect(models.some((m) => m.id.startsWith("openrouter/"))).toBe(false);
    expect(models.some((m) => m.id === "openai/gpt-4o-mini")).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("generateDiagram validation", () => {
  it("rejects an empty API key before making a request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      generateDiagram({ apiKey: "", model: "openai/gpt-4o-mini", prompt: "A web app" }),
    ).rejects.toThrow(DiagramGenerationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an empty prompt before making a request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      generateDiagram({ apiKey: "sk-or-test", model: "openai/gpt-4o-mini", prompt: "" }),
    ).rejects.toThrow(DiagramGenerationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects modify mode with no current board", async () => {
    await expect(
      generateDiagram({
        apiKey: "sk-or-test",
        model: "openai/gpt-4o-mini",
        prompt: "add a cache",
        mode: "modify",
      }),
    ).rejects.toThrow(DiagramGenerationError);
  });
});

describe("fetchAvailableModels", () => {
  it("falls back to a static list when OpenRouter is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const models = await fetchAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id === DEFAULT_DIAGRAM_MODEL)).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("getDefaultModel / setDefaultModel", () => {
  // No real localStorage in this (Node, non-jsdom) test environment -- both functions catch
  // that and fall back gracefully, same as the browser-only sessionStorage helpers above. The
  // actual persistence (picking a model IS setting the new default) is a browser behavior,
  // exercised live rather than here.
  it("falls back to each platform's default model and never throws without a storage backend", () => {
    expect(getDefaultModel("openrouter")).toBe(DEFAULT_DIAGRAM_MODEL);
    expect(getDefaultModel("openai")).toBe(OPENAI_DIAGRAM_MODEL);
    expect(() => setDefaultModel("openrouter", "anthropic/claude-haiku-4.5")).not.toThrow();
    expect(() => setDefaultModel("openai", OPENAI_DIAGRAM_MODEL)).not.toThrow();
  });
});

describe("platform helpers", () => {
  it("names each platform and the model it starts on", () => {
    expect(platformDisplayName("openrouter")).toBe("OpenRouter");
    expect(platformDisplayName("openai")).toBe("OpenAI");
    expect(defaultModelForPlatform("openrouter")).toBe(DEFAULT_DIAGRAM_MODEL);
    expect(defaultModelForPlatform("openai")).toBe(OPENAI_DIAGRAM_MODEL);
  });
});

describe("getDefaultPlatform / setDefaultPlatform", () => {
  // Same storage caveat as the model helpers: no localStorage here, so this only proves the
  // fallback is OpenRouter and that persisting never throws.
  it("falls back to DEFAULT_PLATFORM and never throws without a storage backend", () => {
    expect(DEFAULT_PLATFORM).toBe("openrouter");
    expect(getDefaultPlatform()).toBe(DEFAULT_PLATFORM);
    expect(() => setDefaultPlatform("openai")).not.toThrow();
  });
});

// A minimal graph both response shapes are made to carry, so the assertions below can be about
// the request contract rather than about parsing.
const VALID_GRAPH = {
  name: "Two boxes",
  layers: [],
  nodes: [
    { id: "a", label: "A", kind: "rect" },
    { id: "b", label: "B", kind: "rect" },
  ],
  edges: [{ from: "a", to: "b" }],
};

function stubOkResponse(payload: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload });
}

function requestBody(fetchSpy: ReturnType<typeof stubOkResponse>): Record<string, any> {
  return JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
}

describe("generateDiagram request contract", () => {
  it("defaults to OpenRouter's chat-completions endpoint", async () => {
    const fetchSpy = stubOkResponse({ choices: [{ message: { content: JSON.stringify(VALID_GRAPH) } }] });
    vi.stubGlobal("fetch", fetchSpy);
    const graph = await generateDiagram({ apiKey: "sk-or-test", model: "z-ai/glm-5.3-flash", prompt: "two boxes" });
    expect(graph.nodes).toHaveLength(2);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = requestBody(fetchSpy);
    expect(body.model).toBe("z-ai/glm-5.3-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toHaveLength(1);
    expect(body.text).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("uses OpenAI's Responses API with the strict schema on the openai platform", async () => {
    const fetchSpy = stubOkResponse({ output_text: JSON.stringify(VALID_GRAPH) });
    vi.stubGlobal("fetch", fetchSpy);
    const graph = await generateDiagram({
      apiKey: "sk-test",
      platform: "openai",
      model: OPENAI_DIAGRAM_MODEL,
      prompt: "two boxes",
    });
    expect(graph.nodes).toHaveLength(2);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    const body = requestBody(fetchSpy);
    expect(body.model).toBe(OPENAI_DIAGRAM_MODEL);
    expect(body.text.format.type).toBe("json_schema");
    expect(body.text.format.strict).toBe(true);
    expect(body.messages).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("reads OpenAI's output parts when output_text is absent", async () => {
    const fetchSpy = stubOkResponse({ output: [{ content: [{ text: JSON.stringify(VALID_GRAPH) }] }] });
    vi.stubGlobal("fetch", fetchSpy);
    const graph = await generateDiagram({
      apiKey: "sk-test",
      platform: "openai",
      model: OPENAI_DIAGRAM_MODEL,
      prompt: "two boxes",
    });
    expect(graph.nodes).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it("names the selected platform in the missing-key error", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      generateDiagram({ apiKey: "  ", platform: "openai", model: OPENAI_DIAGRAM_MODEL, prompt: "two boxes" }),
    ).rejects.toThrow("Enter an OpenAI API key.");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
