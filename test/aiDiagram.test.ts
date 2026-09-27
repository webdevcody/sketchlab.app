import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DIAGRAM_MODEL,
  DiagramGenerationError,
  fetchAvailableModels,
  generateDiagram,
  getDefaultModel,
  isFreeModel,
  modelProvider,
  providerDisplayName,
  setDefaultModel,
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
  it("falls back to DEFAULT_DIAGRAM_MODEL and never throws without a storage backend", () => {
    expect(getDefaultModel()).toBe(DEFAULT_DIAGRAM_MODEL);
    expect(() => setDefaultModel("anthropic/claude-haiku-4.5")).not.toThrow();
  });
});
