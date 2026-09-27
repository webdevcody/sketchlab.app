import {
  DEFAULT_DIAGRAM_MODEL,
  DEFAULT_PROVIDER,
  type DiagramGenerationMode,
  type DiagramModelOption,
  FALLBACK_MODELS,
  fetchAvailableModels,
  getDefaultModel,
  getSessionApiKey,
  isFreeModel,
  KNOWN_PROVIDERS,
  modelProvider,
  providerDisplayName,
  setDefaultModel,
  setSessionApiKey,
} from "../ai/aiDiagram";
import { h } from "./dom";

const CUSTOM_MODEL_VALUE = "__custom__";

export interface AIGenerateRequest {
  apiKey: string;
  model: string;
  prompt: string;
  mode: DiagramGenerationMode;
  signal: AbortSignal;
}

export class AIGeneratePanel {
  private el: HTMLDivElement | null = null;
  private form!: HTMLFormElement;
  private keyInput!: HTMLInputElement;
  private providerSelect!: HTMLSelectElement;
  private modelSelect!: HTMLSelectElement;
  private popularRow!: HTMLDivElement;
  private promptInput!: HTMLTextAreaElement;
  private generateBtn!: HTMLButtonElement;
  private closeBtn!: HTMLButtonElement;
  private modeButtons!: Record<DiagramGenerationMode, HTMLButtonElement>;
  private errorEl!: HTMLDivElement;
  private abort: AbortController | null = null;
  private restoreFocusEl: HTMLElement | null = null;
  private invalidField: HTMLInputElement | HTMLTextAreaElement | null = null;
  private mode: DiagramGenerationMode = "generate";
  private canModify = false;
  private model = DEFAULT_DIAGRAM_MODEL;
  private models: DiagramModelOption[] = [{ id: DEFAULT_DIAGRAM_MODEL, label: DEFAULT_DIAGRAM_MODEL }];

  constructor(
    private root: HTMLElement,
    private onGenerate: (request: AIGenerateRequest) => Promise<boolean>,
  ) {}

  get active(): boolean {
    return !!this.el;
  }

  open(opener?: HTMLElement, opts: { canModify?: boolean } = {}): void {
    if (this.el) return;
    this.restoreFocusEl = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    this.canModify = !!opts.canModify;
    this.mode = this.canModify ? "modify" : "generate";
    this.model = getDefaultModel();

    const savedKey = getSessionApiKey();
    this.closeBtn = h("button", {
      class: "ai-panel__close",
      type: "button",
      title: "Close",
      "aria-label": "Close AI generator",
      onclick: () => this.close(),
    }, "x");

    this.keyInput = h("input", {
      class: "ai-panel__input",
      type: "password",
      value: savedKey,
      placeholder: "sk-or-...",
      autocomplete: "off",
      spellcheck: false,
      "aria-describedby": "ai-panel-error",
    });

    this.providerSelect = h("select", {
      class: "ai-panel__input",
      "aria-describedby": "ai-panel-error",
      onchange: () => this.selectProvider(this.providerSelect.value),
    });

    this.modelSelect = h("select", {
      class: "ai-panel__input",
      "aria-describedby": "ai-panel-error",
      onchange: () => this.onModelSelectChange(),
    });

    this.popularRow = h("div", { class: "ai-panel__chips", role: "group", "aria-label": "Popular models" });

    this.populateProviderAndModel(this.models, this.model);
    this.loadModels();

    this.promptInput = h(
      "textarea",
      {
        class: "ai-panel__textarea",
        rows: 5,
        spellcheck: true,
        "aria-describedby": "ai-panel-error",
      },
    );

    this.generateBtn = h(
      "button",
      { class: "btn btn--accent", type: "submit" },
      this.submitLabel(),
    );

    this.modeButtons = {
      generate: h(
        "button",
        { class: "ai-panel__mode", type: "button", onclick: () => this.setMode("generate") },
        "Generate new",
      ),
      modify: h(
        "button",
        {
          class: "ai-panel__mode",
          type: "button",
          disabled: !this.canModify,
          title: this.canModify ? "Modify the current board" : "Create a diagram first to modify it",
          onclick: () => this.setMode("modify"),
        },
        "Modify current",
      ),
    };

    this.errorEl = h("div", { id: "ai-panel-error", class: "ai-panel__error", role: "alert" });
    this.form = h(
      "form",
      { class: "ai-panel__form", onsubmit: (e: Event) => this.submit(e) },
      h("div", { class: "ai-panel__modes", role: "group", "aria-label": "AI diagram mode" }, this.modeButtons.generate, this.modeButtons.modify),
      h(
        "label",
        { class: "ai-panel__field" },
        h("span", null, "OpenRouter API key"),
        this.keyInput,
      ),
      h(
        "label",
        { class: "ai-panel__field" },
        h("span", null, "Platform"),
        h("select", { class: "ai-panel__input", disabled: true, title: "This app only talks to OpenRouter" }, h("option", null, "OpenRouter")),
      ),
      h(
        "label",
        { class: "ai-panel__field" },
        h("span", null, "Model provider"),
        this.providerSelect,
      ),
      h(
        "label",
        { class: "ai-panel__field" },
        h("span", null, "Model"),
        this.modelSelect,
        this.popularRow,
      ),
      h(
        "label",
        { class: "ai-panel__field" },
        h("span", null, "Prompt"),
        this.promptInput,
      ),
      this.errorEl,
      h(
        "div",
        { class: "ai-panel__footer" },
        h("span", { class: "ai-panel__hint" }, "Cmd/Ctrl+Enter generate | Esc close"),
        this.generateBtn,
      ),
    );

    const panel = h(
      "section",
      { class: "ai-panel", role: "dialog", "aria-modal": "true", "aria-label": "Generate diagram with AI" },
      h(
        "header",
        { class: "ai-panel__header" },
        h("div", null, h("h2", null, "Generate Diagram"), h("p", null, "Your key is sent directly from this browser to OpenRouter and kept for this session only.")),
        this.closeBtn,
      ),
      this.form,
    );

    const backdrop = h("div", { class: "ai-panel-backdrop" }, panel);
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) this.close();
    });
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    panel.addEventListener("click", (e) => e.stopPropagation());
    panel.addEventListener("keydown", this.onPanelKeyDown);

    this.root.appendChild(backdrop);
    this.el = backdrop;
    this.syncMode();
    requestAnimationFrame(() => (savedKey ? this.promptInput : this.keyInput).focus());
  }

  // Providers are just OpenRouter model-id prefixes ("openai/gpt-4o-mini" -> "openai"), grouped
  // client-side so picking a model is provider-first. The picker only lists KNOWN_PROVIDERS
  // (OpenRouter has 60+, most obscure) plus the preferred model's own provider even when it
  // isn't on that list, so a Popular/custom pick from elsewhere still shows correctly.
  private populateProviderAndModel(models: DiagramModelOption[], preferredModel: string): void {
    this.models = models;
    const preferredProviderRaw = modelProvider(preferredModel);
    const available = new Set(models.map((m) => modelProvider(m.id)));
    const providers = KNOWN_PROVIDERS.filter((p) => available.has(p));
    if (available.has(preferredProviderRaw) && !providers.includes(preferredProviderRaw)) {
      providers.push(preferredProviderRaw);
    }
    providers.sort((a, b) => {
      if (a === DEFAULT_PROVIDER) return -1;
      if (b === DEFAULT_PROVIDER) return 1;
      return a.localeCompare(b);
    });
    this.providerSelect.replaceChildren(
      ...providers.map((p) => h("option", { value: p }, providerDisplayName(p))),
    );
    const provider = providers.includes(preferredProviderRaw)
      ? preferredProviderRaw
      : providers.includes(DEFAULT_PROVIDER) ? DEFAULT_PROVIDER : providers[0];
    this.providerSelect.value = provider ?? "";
    this.selectProvider(provider ?? "", preferredModel);
    this.buildPopularRow();
  }

  private selectProvider(provider: string, preferredModel?: string): void {
    const models = this.models.filter((m) => modelProvider(m.id) === provider);
    this.modelSelect.replaceChildren(
      ...models.map((m) => h("option", { value: m.id }, m.label + (isFreeModel(m.id) ? " · Free" : ""))),
      h("option", { value: CUSTOM_MODEL_VALUE }, "+ Add custom model id..."),
    );
    const wanted = preferredModel && models.some((m) => m.id === preferredModel) ? preferredModel : models[0]?.id;
    this.modelSelect.value = wanted ?? "";
    this.selectModel(wanted ?? this.model);
  }

  private onModelSelectChange(): void {
    if (this.modelSelect.value !== CUSTOM_MODEL_VALUE) {
      this.selectModel(this.modelSelect.value);
      return;
    }
    const id = window.prompt("OpenRouter model id (e.g. mistralai/mistral-large):")?.trim();
    if (!id) {
      this.modelSelect.value = this.model; // revert the sentinel selection
      return;
    }
    this.chooseModel(id, id);
  }

  // Used by both the custom-model prompt and the Popular chips: adds the model to the known
  // list if new (so a typed-in id or a cross-provider popular pick both just work), then
  // re-derives providers/options from that updated list so everything stays in sync.
  private chooseModel(id: string, label: string): void {
    if (!this.models.some((m) => m.id === id)) {
      this.models = [...this.models, { id, label }];
    }
    this.providerSelect.value = modelProvider(id);
    this.populateProviderAndModel(this.models, id);
  }

  private selectModel(model: string): void {
    this.model = model;
    setDefaultModel(model);
    if (this.generateBtn) this.generateBtn.textContent = this.submitLabel();
    if (this.popularRow) this.buildPopularRow();
  }

  // Stable flagship models (unlikely to be delisted) plus a couple of whatever is currently
  // free on OpenRouter, shown as one-click shortcuts regardless of the selected provider.
  private buildPopularRow(): void {
    const liveFree = this.models.filter((m) => isFreeModel(m.id)).slice(0, 2);
    const seen = new Set<string>();
    const picks = [...FALLBACK_MODELS, ...liveFree].filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    this.popularRow.replaceChildren(
      ...picks.map((m) => {
        const free = isFreeModel(m.id);
        return h(
          "button",
          {
            type: "button",
            class: "ai-panel__chip" + (free ? " ai-panel__chip--free" : "") + (m.id === this.model ? " is-active" : ""),
            title: m.id,
            onclick: () => this.chooseModel(m.id, m.label),
          },
          m.label,
          free ? h("span", { class: "ai-panel__chip-badge" }, "Free") : null,
        );
      }),
    );
  }

  private loadModels(): void {
    const requestedModel = this.model;
    fetchAvailableModels()
      .then((models: DiagramModelOption[]) => {
        if (!this.el) return;
        this.populateProviderAndModel(models, requestedModel);
      })
      .catch(() => {
        // Keep the single fallback option already populated.
      });
  }

  close(force = false): void {
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
      this.setLoading(false);
      this.showError("Generation was cancelled.");
      if (!force) return;
    }
    const restoreFocusEl = this.restoreFocusEl;
    this.restoreFocusEl = null;
    this.invalidField = null;
    if (!this.el) {
      restoreFocusEl?.focus();
      return;
    }
    this.el.remove();
    this.el = null;
    restoreFocusEl?.focus();
  }

  destroy(): void {
    this.close(true);
  }

  private onPanelKeyDown = (e: KeyboardEvent): void => {
    e.stopPropagation();
    if (e.key === "Tab") {
      this.trapFocus(e);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void this.submit();
    }
  };

  private async submit(e?: Event): Promise<void> {
    e?.preventDefault();
    if (this.abort) return;

    const apiKey = this.keyInput.value.trim();
    const prompt = this.promptInput.value.trim();
    if (!apiKey) {
      this.showFieldError(this.keyInput, "Enter an OpenRouter API key.");
      this.keyInput.focus();
      return;
    }
    if (!prompt) {
      this.showFieldError(
        this.promptInput,
        this.mode === "modify" ? "Describe how to modify the diagram." : "Describe the diagram you want to generate.",
      );
      this.promptInput.focus();
      return;
    }
    if (this.mode === "modify" && !this.canModify) {
      this.showError("Create a diagram before using Modify current.");
      return;
    }

    setSessionApiKey(apiKey);
    setDefaultModel(this.model);
    this.showError("");
    const controller = new AbortController();
    this.abort = controller;
    this.setLoading(true);
    try {
      const applied = await this.onGenerate({
        apiKey,
        model: this.model,
        prompt,
        mode: this.mode,
        signal: controller.signal,
      });
      if (applied) this.close(true);
    } catch (err) {
      if (controller.signal.aborted) return;
      this.showError(err instanceof Error ? err.message : "Could not generate a diagram.");
    } finally {
      if (this.abort === controller) {
        this.abort = null;
        this.setLoading(false);
      }
    }
  }

  private setLoading(loading: boolean): void {
    this.form.setAttribute("aria-busy", String(loading));
    this.keyInput.disabled = loading;
    this.providerSelect.disabled = loading;
    this.modelSelect.disabled = loading;
    for (const chip of this.popularRow.querySelectorAll("button")) (chip as HTMLButtonElement).disabled = loading;
    this.promptInput.disabled = loading;
    this.modeButtons.generate.disabled = loading;
    this.modeButtons.modify.disabled = loading || !this.canModify;
    this.generateBtn.disabled = loading;
    this.closeBtn.title = loading ? "Cancel generation" : "Close";
    this.closeBtn.setAttribute("aria-label", loading ? "Cancel generation" : "Close AI generator");
    this.generateBtn.textContent = loading ? "Working..." : this.submitLabel();
  }

  private showError(message: string): void {
    if (this.invalidField) {
      this.invalidField.removeAttribute("aria-invalid");
      this.invalidField = null;
    }
    this.errorEl.textContent = message;
    this.errorEl.classList.toggle("is-visible", !!message);
  }

  private showFieldError(field: HTMLInputElement | HTMLTextAreaElement, message: string): void {
    this.showError(message);
    this.invalidField = field;
    field.setAttribute("aria-invalid", "true");
  }

  private setMode(mode: DiagramGenerationMode): void {
    if (mode === "modify" && !this.canModify) return;
    this.mode = mode;
    this.syncMode();
  }

  private syncMode(): void {
    for (const mode of ["generate", "modify"] as const) {
      const active = this.mode === mode;
      this.modeButtons[mode].classList.toggle("is-active", active);
      this.modeButtons[mode].setAttribute("aria-pressed", String(active));
    }
    this.promptInput.placeholder = this.mode === "modify"
      ? "Describe the change. Example: Add Redis between the API and database, and label cache hits."
      : "Describe the diagram you want. Example: A browser hits a CDN, API gateway, auth service, worker queue, Postgres, and Redis cache.";
    this.generateBtn.textContent = this.submitLabel();
  }

  // The button reflects the currently selected model's human-readable label (e.g. "GPT-4o
  // mini"), not the raw OpenRouter id, and updates live as the mode/provider/model change.
  private submitLabel(): string {
    const modelLabel = this.models.find((m) => m.id === this.model)?.label ?? this.model;
    return `${this.mode === "modify" ? "Modify" : "Generate"} with ${modelLabel}`;
  }

  private trapFocus(e: KeyboardEvent): void {
    const chipButtons = Array.from(this.popularRow.querySelectorAll("button")) as HTMLButtonElement[];
    const focusables = [
      this.closeBtn,
      this.modeButtons.generate,
      this.modeButtons.modify,
      this.keyInput,
      this.providerSelect,
      this.modelSelect,
      ...chipButtons,
      this.promptInput,
      this.generateBtn,
    ].filter(
      (el) => !el.disabled,
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
