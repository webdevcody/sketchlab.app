import { centerOrigin, fitToContent, getZoom, isFocusOffBoard, zoomBy } from "../interaction/camera";
import { generateDiagramWithOpenAI } from "../ai/openaiDiagram";
import { Controller } from "../interaction/controller";
import { NO_FILL } from "../render/geometry";
import { saveNow, startAutosave, stopAutosave } from "../persistence/autosave";
import { listBoards, saveBoard } from "../persistence/db";
import { shareUrl } from "../persistence/share";
import { scene } from "../render/scene";
import * as actions from "../state/actions";
import { $canRedo, $canUndo, disposeHistory, initHistory, redo, undo } from "../state/history";
import { $activeLayer, $camera, $selection, $style, $tool, doc } from "../state/store";
import { TEXT_SIZE_PRESETS } from "../state/style";
import type { Board, ToolName } from "../state/types";
import { generatedGraphToBoard } from "../state/generatedGraph";
import { createStarterBoard } from "../state/starterBoard";
import { emptyBoard } from "../state/store";
import { BoardDrawer } from "./boardDrawer";
import { confirmDialog } from "./confirmDialog";
import { ControlsHelp } from "./controlsHelp";
import { LayersPanel } from "./layersPanel";
import { AIGeneratePanel } from "./aiGeneratePanel";
import { clear, h, toast } from "./dom";
import { navigate } from "./nav";
import { createSwatchPicker } from "./swatchPicker";

const HEX = /^#[0-9a-fA-F]{6}$/;

function svg(inner: string): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

const ICON_SELECT = svg('<path d="M5 3l13.5 7-5.8 1.5L9.5 20z" fill="currentColor" stroke="none"/>');
const ICON_TEXT = svg('<path d="M6 6h12"/><path d="M12 6v12"/>');
const ICON_RECT = svg('<rect x="4" y="6.5" width="16" height="11" rx="2"/>');
const ICON_CIRCLE = svg('<circle cx="12" cy="12" r="7.5"/>');
const ICON_LINE = svg('<path d="M6.5 17.5 17.5 6.5"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/>');
const ICON_ARROW = svg('<path d="M5 19 16.5 7.5"/><path d="M16.5 7.5 13.7 14.2"/><path d="M16.5 7.5 9.8 10.3"/>');
const ICON_HAND = svg(
  '<path d="M12 4.5v15"/><path d="M4.5 12h15"/><path d="M12 4.5 9.5 7M12 4.5 14.5 7"/><path d="M12 19.5 9.5 17M12 19.5 14.5 17"/><path d="M4.5 12 7 9.5M4.5 12 7 14.5"/><path d="M19.5 12 17 9.5M19.5 12 17 14.5"/>',
);
const GITHUB_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.78 0 12.292c0 5.211 3.438 9.63 8.205 11.188.6.111.82-.254.82-.567 0-.28-.01-1.022-.015-2.005-3.338.711-4.042-1.582-4.042-1.582-.546-1.361-1.335-1.725-1.335-1.725-1.087-.731.084-.716.084-.716 1.205.082 1.838 1.215 1.838 1.215 1.07 1.803 2.809 1.282 3.495.981.108-.763.417-1.282.76-1.577-2.665-.295-5.466-1.309-5.466-5.827 0-1.287.465-2.339 1.235-3.164-.135-.298-.54-1.497.105-3.121 0 0 1.005-.316 3.3 1.209.96-.262 1.98-.392 3-.398 1.02.006 2.04.136 3 .398 2.28-1.525 3.285-1.209 3.285-1.209.645 1.624.24 2.823.12 3.121.765.825 1.23 1.877 1.23 3.164 0 4.53-2.805 5.527-5.475 5.817.42.354.81 1.077.81 2.182 0 1.576-.015 2.846-.015 3.229 0 .309.21.678.825.561C20.565 21.917 24 17.495 24 12.292 24 5.78 18.627.5 12 .5z"/></svg>';

const ICON_SPARKLE = svg(
  '<path d="M12 3l1.7 4.8L18.5 9.5 13.7 11.2 12 16l-1.7-4.8L5.5 9.5l4.8-1.7z" fill="currentColor" stroke="none"/><path d="M18 15l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" fill="currentColor" stroke="none"/>',
);
const ICON_MAGIC_WAND = svg(
  '<path d="M4 20 20 4"/><path d="m14 4 6 6"/><path d="M6 4l.7 1.8L8.5 6.5 6.7 7.2 6 9l-.7-1.8-1.8-.7 1.8-.7z" fill="currentColor" stroke="none"/><path d="M18 15l.6 1.5 1.4.5-1.4.5L18 20l-.6-1.5-1.4-.5 1.4-.5z" fill="currentColor" stroke="none"/>',
);
const ICON_MENU = svg(
  '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
);
const ICON_AUTO_LAYOUT = svg(
  '<rect x="4" y="5" width="5" height="4" rx="1"/><rect x="15" y="5" width="5" height="4" rx="1"/><rect x="9.5" y="15" width="5" height="4" rx="1"/><path d="M6.5 9v2.5h5.5V15"/><path d="M17.5 9v2.5H12V15"/>',
);
const ICON_LAYERS = svg(
  '<path d="M12 3 21 8l-9 5-9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 17l9 5 9-5"/>',
);
const ICON_HELP = svg(
  '<circle cx="12" cy="12" r="9"/><path d="M9.4 9a2.6 2.6 0 0 1 4.6 1.5c0 1.7-2.4 2-2.4 3.7"/><path d="M12 17h.01"/>',
);
const ICON_RECENTER = svg(
  '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>',
);

const TOOLS: Array<{ tool: ToolName; icon: string; key: string; title: string }> = [
  { tool: "select", icon: ICON_SELECT, key: "V", title: "Select / move (V)" },
  { tool: "text", icon: ICON_TEXT, key: "T", title: "Text (T) — or double-click the canvas" },
  { tool: "rect", icon: ICON_RECT, key: "R", title: "Rectangle (R)" },
  { tool: "circle", icon: ICON_CIRCLE, key: "O", title: "Circle (O)" },
  { tool: "line", icon: ICON_LINE, key: "L", title: "Connector line (L)" },
  { tool: "arrow", icon: ICON_ARROW, key: "A", title: "Arrow / directed edge (A)" },
  { tool: "hand", icon: ICON_HAND, key: "M", title: "Move / pan (M or space-drag)" },
];

export interface MountedView {
  destroy(): void;
}

export async function mountEditor(
  appRoot: HTMLElement,
  board: Board,
  opts: { shared?: boolean } = {},
): Promise<MountedView> {
  clear(appRoot);
  const host = h("div", { class: "editor__canvas" });
  const editor = h("div", { class: "editor" }, host);
  appRoot.appendChild(editor);

  await scene.init(host);
  actions.loadBoard(board);
  initHistory();
  if (Object.keys(board.shapes).length) fitToContent();
  else centerOrigin();

  const controller = new Controller(host);
  const unsubs: Array<() => void> = [];
  let shared = !!opts.shared;

  // the floor grid is now drawn in perspective by the Pixi scene (no flat CSS grid)

  const onResize = () => scene.resize(host.clientWidth, host.clientHeight);
  window.addEventListener("resize", onResize);

  // ---- top bar ----
  const nameInput = h("input", {
    class: "topbar__name",
    value: board.name,
    spellcheck: false,
    onchange: (e: Event) =>
      actions.renameBoard((e.target as HTMLInputElement).value.trim() || "Untitled"),
  });

  const switchBoard = (id: string) => {
    if (!shared) void saveNow().finally(() => navigate(`#/board/${id}`));
    else navigate(`#/board/${id}`);
  };

  const createBoard = async () => {
    if (!shared) await saveNow();
    const next = emptyBoard("Untitled board");
    await saveBoard(next);
    navigate(`#/board/${next.id}`);
  };

  let menuBtn!: HTMLButtonElement;

  const boardDrawer = new BoardDrawer(editor, {
    activeBoardId: board.id,
    onSelect: switchBoard,
    onCreate: () => void createBoard(),
    onDeleted: async (deletedId) => {
      if (deletedId !== doc.board.id) return;
      const boards = await listBoards();
      if (boards.length > 0) {
        switchBoard(boards[0].id);
        return;
      }
      const starter = createStarterBoard();
      await saveBoard(starter);
      navigate(`#/board/${starter.id}`);
    },
    onOpenChange: (open) => menuBtn.setAttribute("aria-expanded", String(open)),
  });

  menuBtn = h(
    "button",
    {
      class: "btn btn--icon topbar__menu",
      title: "Boards",
      "aria-label": "Boards",
      "aria-expanded": "false",
      html: ICON_MENU,
      onclick: () => boardDrawer.toggle(),
    },
  );

  let layersBtn!: HTMLButtonElement;
  const layersPanel = new LayersPanel(editor, {
    onCollapseChange: (collapsed) => layersBtn?.setAttribute("aria-expanded", String(!collapsed)),
  });
  unsubs.push(
    $activeLayer.subscribe((i) => {
      scene.setActiveLayer(i);
      actions.pruneSelectionToLayer(i); // off-floor nodes can't stay selected
    }),
  );

  layersBtn = h("button", {
    class: "btn btn--icon",
    title: "Show / hide the Layers panel",
    "aria-label": "Toggle layers panel",
    "aria-expanded": "true",
    html: ICON_LAYERS,
    onclick: () => layersPanel.toggle(),
  });

  const shareBtn = h(
    "button",
    {
      class: "btn btn--accent",
      onclick: () => {
        const url = shareUrl(doc.board);
        if (navigator.clipboard) {
          navigator.clipboard
            .writeText(url)
            .then(() => toast("Share link copied to clipboard"))
            .catch(() => prompt("Copy this share link:", url));
        } else {
          prompt("Copy this share link:", url);
        }
      },
    },
    "Share",
  );

  const hasBoardContent = () =>
    Object.keys(doc.board.shapes).length > 0 || Object.keys(doc.board.edges).length > 0;

  const aiPanel = new AIGeneratePanel(editor, async ({ apiKey, prompt, mode, signal }) => {
    if (mode === "generate" && hasBoardContent()) {
      const ok = await confirmDialog({
        title: "Replace board?",
        message: "Replace the current board with a generated diagram? This clears the existing shapes.",
        confirmLabel: "Replace",
      });
      if (!ok) return false;
    }
    const graph = await generateDiagramWithOpenAI({
      apiKey,
      prompt,
      mode,
      currentBoard: mode === "modify" ? doc.board : undefined,
      signal,
    });
    const generated = generatedGraphToBoard(graph, doc.board.name);
    actions.replaceBoardContent({
      name: generated.name,
      shapes: generated.shapes,
      edges: generated.edges,
      order: generated.order,
      layers: generated.layers,
    });
    nameInput.value = doc.board.name;
    fitToContent();
    toast(`${mode === "modify" ? "Modified" : "Generated"} ${Object.keys(generated.shapes).length} shapes`);
    return true;
  });

  const aiBtn = h(
    "button",
    {
      class: "btn btn--icon",
      title: "Generate or modify with AI",
      "aria-label": "Generate or modify with AI",
      html: ICON_MAGIC_WAND,
      onclick: () => aiPanel.open(aiBtn, { canModify: hasBoardContent() }),
    },
  );

  const autoLayoutBtn = h("button", {
    class: "btn btn--icon",
    title: "Auto layout",
    "aria-label": "Auto layout",
    html: ICON_AUTO_LAYOUT,
    onclick: () => {
      const changed = actions.autoLayoutBoard();
      fitToContent();
      toast(changed ? "Auto layout applied" : "Board is already laid out");
    },
  });

  const banner = h(
    "div",
    { class: "banner", style: { display: shared ? "" : "none" } },
    "You're viewing a shared board. Save a copy to edit and keep it.",
  );

  const saveCopyBtn = h(
    "button",
    {
      class: "btn btn--accent",
      style: { display: shared ? "" : "none" },
      onclick: async () => {
        await saveBoard(doc.board, scene.exportThumbnail());
        shared = false;
        banner.style.display = "none";
        saveCopyBtn.style.display = "none";
        startAutosave();
        navigate(`#/board/${doc.board.id}`);
      },
    },
    "Save a copy",
  );

  const undoBtn = h("button", {
    class: "btn btn--icon",
    title: "Undo (⌘/Ctrl+Z)",
    html: svg('<path d="M9 8 4.5 12 9 16"/><path d="M4.5 12H14a5.5 5.5 0 0 1 0 11h-2"/>'),
    onclick: () => undo(),
  });
  const redoBtn = h("button", {
    class: "btn btn--icon",
    title: "Redo (⌘/Ctrl+Shift+Z)",
    html: svg('<path d="M15 8 19.5 12 15 16"/><path d="M19.5 12H10a5.5 5.5 0 0 0 0 11h2"/>'),
    onclick: () => redo(),
  });
  unsubs.push($canUndo.subscribe((v) => undoBtn.toggleAttribute("disabled", !v)));
  unsubs.push($canRedo.subscribe((v) => redoBtn.toggleAttribute("disabled", !v)));

  const githubLink = h("a", {
    class: "btn btn--icon",
    href: "https://github.com/webdevcody/sketchlab.app",
    target: "_blank",
    rel: "noopener noreferrer",
    title: "Sketch Lab on GitHub",
    "aria-label": "Sketch Lab on GitHub",
    html: GITHUB_ICON,
  });

  const topbarSlide = h(
    "div",
    { class: "topbar__slide" },
    h("div", { class: "topbar__group" }, undoBtn, redoBtn),
    nameInput,
    h("div", { class: "topbar__spacer" }),
    saveCopyBtn,
    aiBtn,
    autoLayoutBtn,
    layersBtn,
    githubLink,
    shareBtn,
  );

  const topbar = h("header", { class: "topbar" }, menuBtn, topbarSlide);

  // ---- tool rail ----
  const toolbar = h("div", { class: "toolbar" });
  for (const t of TOOLS) {
    const btn = h("button", {
      class: "tool",
      title: t.title,
      html: `${t.icon}<span class="tool__kbd">${t.key}</span>`,
      onclick: () => $tool.set(t.tool),
    });
    unsubs.push($tool.subscribe((cur) => btn.classList.toggle("is-active", cur === t.tool)));
    toolbar.appendChild(btn);
  }
  toolbar.appendChild(h("div", { class: "toolbar__sep" }));
  toolbar.appendChild(
    h("button", {
      class: "tool",
      title: "Insert icon (/)",
      html: `${ICON_SPARKLE}<span class="tool__kbd">/</span>`,
      onclick: () => controller.openPalette(),
    }),
  );

  // ---- zoom bar ----
  const controlsHelp = new ControlsHelp(editor);
  const zoomLabel = h("span", { class: "zoombar__label" }, "100%");
  unsubs.push($camera.subscribe(() => (zoomLabel.textContent = `${Math.round(getZoom() * 100)}%`)));
  const zoombar = h(
    "div",
    { class: "zoombar" },
    h("button", { class: "btn btn--icon", title: "Zoom out", onclick: () => zoomBy(1 / 1.2) }, "−"),
    zoomLabel,
    h("button", { class: "btn btn--icon", title: "Zoom in", onclick: () => zoomBy(1.2) }, "+"),
    h("button", { class: "btn", title: "Fit to content", onclick: () => fitToContent() }, "Fit"),
    h("div", { class: "zoombar__sep" }),
    h(
      "button",
      {
        class: "btn btn--icon",
        title: "Controls & shortcuts (?)",
        "aria-label": "Controls and shortcuts",
        html: ICON_HELP,
        onclick: () => controlsHelp.toggle(),
      },
    ),
  );

  // ---- recenter prompt ----
  // Panning is unbounded, so the board can scroll out of view. This pill appears
  // only once the focus has roamed off the board and snaps the camera back.
  const recenterBtn = h(
    "button",
    {
      class: "recenter-btn",
      title: "Recenter on the board",
      "aria-label": "Recenter on the board",
      html: `${ICON_RECENTER}<span>Recenter</span>`,
      onclick: () => fitToContent(),
    },
  );
  const syncRecenter = () => recenterBtn.classList.toggle("is-visible", isFocusOffBoard());
  unsubs.push($camera.subscribe(syncRecenter));
  syncRecenter();

  // ---- style panel ----
  const fillPicker = createSwatchPicker({
    title: "Fill / background color",
    initial: $style.get().fill,
    transparent: true,
    onPick: (color) => {
      $style.set({ ...$style.get(), fill: color });
      const sel = $selection.get();
      if (sel.shapes.size) actions.setShapesStyle(sel.shapes, { fill: color });
    },
  });

  // text-size presets: apply a global font size to every existing label/text and
  // remember it as the default for new text and edge labels.
  const sizeButtons = TEXT_SIZE_PRESETS.map((preset) =>
    h(
      "button",
      {
        class: "size-btn",
        title: `Text size ${preset.label} (${preset.size}px)`,
        "aria-label": `Text size ${preset.label} (${preset.size}px)`,
        "aria-pressed": "false",
        onclick: () => {
          $style.set({ ...$style.get(), fontSize: preset.size });
          actions.setShapesFontSize(Object.keys(doc.board.shapes), preset.size);
          actions.setEdgesFontSize(Object.keys(doc.board.edges), preset.size);
          syncStyle();
        },
      },
      preset.label,
    ),
  );
  const sizePicker = h("div", { class: "size-picker" }, ...sizeButtons);

  const deleteBtn = h(
    "button",
    { class: "btn btn--danger", title: "Delete selection (⌫)", onclick: () => actions.deleteSelection() },
    "Delete",
  );

  const stylePanel = h(
    "div",
    { class: "style-panel" },
    h("div", { class: "field" }, h("span", null, "Fill"), fillPicker.el),
    h("div", { class: "field" }, h("span", null, "Size"), sizePicker),
    deleteBtn,
  );

  const syncStyle = () => {
    const sel = $selection.get();
    const firstShape = [...sel.shapes].map((id) => doc.board.shapes[id]).find(Boolean);
    if (firstShape) {
      if (HEX.test(firstShape.fill) || firstShape.fill === NO_FILL)
        fillPicker.setValue(firstShape.fill);
    } else {
      fillPicker.setValue($style.get().fill);
    }
    const activeSize = $style.get().fontSize;
    sizeButtons.forEach((btn, i) => {
      const active = TEXT_SIZE_PRESETS[i].size === activeSize;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    const hasSel = sel.shapes.size > 0 || sel.edges.size > 0;
    deleteBtn.toggleAttribute("disabled", !hasSel);
    stylePanel.classList.toggle("style-panel--editing", hasSel);
  };
  unsubs.push($selection.subscribe(syncStyle));

  editor.append(topbar, banner, toolbar, zoombar, recenterBtn, stylePanel);
  // cool cyan key-light bloom + corner vignette to seat the tabletop (topmost, no input)
  editor.appendChild(h("div", { class: "tabletop-vignette" }));

  if (!shared) startAutosave();

  return {
    destroy() {
      unsubs.forEach((u) => u());
      window.removeEventListener("resize", onResize);
      boardDrawer.destroy();
      layersPanel.destroy();
      aiPanel.destroy();
      controlsHelp.destroy();
      controller.destroy();
      disposeHistory();
      stopAutosave();
      scene.destroy();
      clear(appRoot);
    },
  };
}
