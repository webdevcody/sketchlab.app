import { centerOrigin, fitToContent, getZoom, zoomBy } from "../interaction/camera";
import { Controller } from "../interaction/controller";
import { NO_FILL } from "../render/geometry";
import { saveNow, startAutosave, stopAutosave } from "../persistence/autosave";
import { saveBoard } from "../persistence/db";
import { shareUrl } from "../persistence/share";
import { scene } from "../render/scene";
import * as actions from "../state/actions";
import { $canRedo, $canUndo, disposeHistory, initHistory, redo, undo } from "../state/history";
import { $camera, $selection, $style, $tool, doc } from "../state/store";
import type { Board, Camera, ToolName } from "../state/types";
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
const ICON_SPARKLE = svg(
  '<path d="M12 3l1.7 4.8L18.5 9.5 13.7 11.2 12 16l-1.7-4.8L5.5 9.5l4.8-1.7z" fill="currentColor" stroke="none"/><path d="M18 15l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" fill="currentColor" stroke="none"/>',
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

  // --- background grid follows the camera ---
  const applyGrid = (cam: Camera) => {
    const size = 24 * cam.zoom;
    host.style.backgroundSize = `${size}px ${size}px`;
    host.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
  };
  unsubs.push($camera.subscribe(applyGrid));

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

  const backBtn = h(
    "button",
    {
      class: "btn",
      onclick: () => {
        if (!shared) saveNow().finally(() => navigate("#/"));
        else navigate("#/");
      },
    },
    "← Boards",
  );

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

  const topbar = h(
    "header",
    { class: "topbar" },
    backBtn,
    h("div", { class: "topbar__group" }, undoBtn, redoBtn),
    nameInput,
    h("div", { class: "topbar__spacer" }),
    saveCopyBtn,
    shareBtn,
  );

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
  const zoomLabel = h("span", { class: "zoombar__label" }, "100%");
  unsubs.push($camera.subscribe(() => (zoomLabel.textContent = `${Math.round(getZoom() * 100)}%`)));
  const zoombar = h(
    "div",
    { class: "zoombar" },
    h("button", { class: "btn btn--icon", title: "Zoom out", onclick: () => zoomBy(1 / 1.2) }, "−"),
    zoomLabel,
    h("button", { class: "btn btn--icon", title: "Zoom in", onclick: () => zoomBy(1.2) }, "+"),
    h("button", { class: "btn", title: "Fit to content", onclick: () => fitToContent() }, "Fit"),
  );

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
  const strokePicker = createSwatchPicker({
    title: "Outline / line color",
    initial: $style.get().stroke,
    onPick: (color) => {
      $style.set({ ...$style.get(), stroke: color });
      const sel = $selection.get();
      if (sel.shapes.size) actions.setShapesStyle(sel.shapes, { stroke: color });
      for (const id of sel.edges) actions.updateEdge(id, { stroke: color });
    },
  });

  const deleteBtn = h(
    "button",
    { class: "btn btn--danger", title: "Delete selection (⌫)", onclick: () => actions.deleteSelection() },
    "Delete",
  );

  const stylePanel = h(
    "div",
    { class: "style-panel" },
    h("div", { class: "field" }, h("span", null, "Fill"), fillPicker.el),
    h("div", { class: "field" }, h("span", null, "Outline"), strokePicker.el),
    deleteBtn,
  );

  const syncStyle = () => {
    const sel = $selection.get();
    const firstShape = [...sel.shapes].map((id) => doc.board.shapes[id]).find(Boolean);
    const firstEdge = [...sel.edges].map((id) => doc.board.edges[id]).find(Boolean);
    if (firstShape) {
      if (HEX.test(firstShape.fill) || firstShape.fill === NO_FILL)
        fillPicker.setValue(firstShape.fill);
      if (HEX.test(firstShape.stroke)) strokePicker.setValue(firstShape.stroke);
    } else {
      const st = $style.get();
      fillPicker.setValue(st.fill);
      strokePicker.setValue(st.stroke);
    }
    if (firstEdge && HEX.test(firstEdge.stroke)) strokePicker.setValue(firstEdge.stroke);
    const hasSel = sel.shapes.size > 0 || sel.edges.size > 0;
    deleteBtn.toggleAttribute("disabled", !hasSel);
    stylePanel.classList.toggle("style-panel--editing", hasSel);
  };
  unsubs.push($selection.subscribe(syncStyle));

  editor.append(topbar, banner, toolbar, zoombar, stylePanel);

  const hint = h(
    "div",
    { class: "hint" },
    "Double-click to add text · / for icons · drop an image · scroll to pan · ⌘/Ctrl+scroll to zoom",
  );
  editor.appendChild(hint);

  if (!shared) startAutosave();

  return {
    destroy() {
      unsubs.forEach((u) => u());
      window.removeEventListener("resize", onResize);
      controller.destroy();
      disposeHistory();
      stopAutosave();
      scene.destroy();
      clear(appRoot);
    },
  };
}
