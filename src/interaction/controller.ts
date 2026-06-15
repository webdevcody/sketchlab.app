import type { Graphics } from "pixi.js";
import {
  boundaryPoint,
  type Pt,
  quadPoints,
  readableText,
  resolveEdgeGeometry,
} from "../render/geometry";
import { scene } from "../render/scene";
import * as actions from "../state/actions";
import { DEFAULT_SIZE } from "../state/actions";
import { copySelection, cutSelection, pasteClipboard } from "../state/clipboard";
import { redo, undo } from "../state/history";
import {
  $camera,
  $selection,
  $tool,
  clearSelection,
  doc,
  setSelection,
} from "../state/store";
import type { ID, Shape } from "../state/types";
import { measureTextBox, TEXT_FONT_SIZE, TEXT_PAD } from "../render/measure";
import { panBy, zoomAt } from "./camera";
import { IconPalette } from "./iconPalette";
import { TextEditor } from "./textEditor";
import { screenToWorld, worldToScreen } from "./viewport";

const ACCENT = 0x38bdf8;
const SELECT = 0xfacc15; // yellow — selection outline/handles, distinct from shape strokes
const HANDLE = 9;
const EDGE_HANDLE_R = 6;
const MOVE_THRESHOLD = 3;
const MIN_SIZE = 16;
const MIN_FONT = 8;
const MAX_FONT = 400;

// handle indices: 0 tl, 1 top, 2 tr, 3 right, 4 br, 5 bottom, 6 bl, 7 left
const RESIZE_CURSORS = [
  "nwse-resize",
  "ns-resize",
  "nesw-resize",
  "ew-resize",
  "nwse-resize",
  "ns-resize",
  "nesw-resize",
  "ew-resize",
];

type Gesture =
  | { kind: "none" }
  | { kind: "pan"; lastX: number; lastY: number }
  | { kind: "create"; tool: "rect" | "circle"; sx: number; sy: number; cx: number; cy: number }
  | { kind: "marquee"; sx: number; sy: number; cx: number; cy: number; base: Set<ID> }
  | { kind: "move"; lastWX: number; lastWY: number; moved: boolean }
  | { kind: "connect"; from: ID; px: number; py: number; directed: boolean }
  | { kind: "edgeCtrl"; id: ID }
  | { kind: "resize"; id: ID; handle: number; aspect: number };

function numToCss(n: number): string {
  return "#" + n.toString(16).padStart(6, "0");
}

/** True when focus is in a real input/textarea/contenteditable (let the browser handle keys). */
function isEditingDom(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** A square box anchored at (sx,sy), expanding toward (cx,cy). Keeps shapes 1:1. */
function squareBox(sx: number, sy: number, cx: number, cy: number) {
  const dx = cx - sx;
  const dy = cy - sy;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return {
    x: dx < 0 ? sx - side : sx,
    y: dy < 0 ? sy - side : sy,
    side,
  };
}

export class Controller {
  private gesture: Gesture = { kind: "none" };
  private spaceDown = false;
  private textEditor: TextEditor;
  private palette: IconPalette;
  private editOriginal = "";
  private subs: Array<() => void> = [];

  constructor(private root: HTMLElement) {
    this.textEditor = new TextEditor(root);
    this.palette = new IconPalette(root, (key) => this.insertIcon(key));

    root.addEventListener("pointerdown", this.onPointerDown);
    root.addEventListener("pointermove", this.onPointerMove);
    root.addEventListener("pointerup", this.onPointerUp);
    root.addEventListener("wheel", this.onWheel, { passive: false });
    root.addEventListener("dblclick", this.onDblClick);
    root.addEventListener("contextmenu", this.onContextMenu);
    root.addEventListener("drop", this.onDrop);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    // prevent the browser from navigating to a dropped image anywhere on the page
    window.addEventListener("dragover", this.onDragOver);
    window.addEventListener("drop", this.onWindowDrop);

    scene.setOverlay((g) => this.drawOverlay(g));
    this.subs.push($selection.subscribe(() => scene.requestRender()));
    this.subs.push($tool.subscribe(() => this.updateCursor()));
    this.updateCursor();
  }

  openPalette(): void {
    this.palette.open();
  }

  destroy(): void {
    this.root.removeEventListener("pointerdown", this.onPointerDown);
    this.root.removeEventListener("pointermove", this.onPointerMove);
    this.root.removeEventListener("pointerup", this.onPointerUp);
    this.root.removeEventListener("wheel", this.onWheel);
    this.root.removeEventListener("dblclick", this.onDblClick);
    this.root.removeEventListener("contextmenu", this.onContextMenu);
    this.root.removeEventListener("drop", this.onDrop);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("dragover", this.onDragOver);
    window.removeEventListener("drop", this.onWindowDrop);
    this.subs.forEach((u) => u());
    this.subs = [];
    scene.setOverlay(null);
  }

  // ---- helpers ----
  private local(e: PointerEvent | MouseEvent | WheelEvent): Pt {
    const r = this.root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private zoom(): number {
    return $camera.get().zoom;
  }

  private worldTol(px = 8): number {
    return px / this.zoom();
  }

  private updateCursor(): void {
    const tool = $tool.get();
    let c = "default";
    if (this.spaceDown || tool === "hand") c = "grab";
    else if (tool === "text") c = "text";
    else if (tool === "rect" || tool === "circle" || tool === "line" || tool === "arrow")
      c = "crosshair";
    this.root.style.cursor = c;
  }

  /** 8 resize handles (screen space) in index order: tl,t,tr,r,br,b,bl,l. */
  private handlePoints(s: Shape): Pt[] {
    const tl = worldToScreen(s.x, s.y);
    const tr = worldToScreen(s.x + s.w, s.y);
    const br = worldToScreen(s.x + s.w, s.y + s.h);
    const bl = worldToScreen(s.x, s.y + s.h);
    return [
      tl,
      { x: (tl.x + tr.x) / 2, y: tl.y },
      tr,
      { x: tr.x, y: (tr.y + br.y) / 2 },
      br,
      { x: (bl.x + br.x) / 2, y: bl.y },
      bl,
      { x: tl.x, y: (tl.y + bl.y) / 2 },
    ];
  }

  /** Index of the resize handle under a screen point, or -1. */
  private hitHandle(s: Shape, p: Pt): number {
    const pts = this.handlePoints(s);
    for (let i = 0; i < 8; i++) {
      if (Math.abs(p.x - pts[i].x) <= HANDLE && Math.abs(p.y - pts[i].y) <= HANDLE) return i;
    }
    return -1;
  }

  private aspectOf(s: Shape): number {
    return s.kind === "image" && s.h > 0 ? s.w / s.h : 1;
  }

  private singleSelectedShape(): Shape | null {
    const sel = $selection.get();
    if (sel.shapes.size !== 1) return null;
    const id = [...sel.shapes][0];
    return doc.board.shapes[id] ?? null;
  }

  private onContextMenu = (e: MouseEvent): void => e.preventDefault();

  // ---- pointer ----
  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.button !== 1) return;
    this.textEditor.commit();
    this.root.setPointerCapture(e.pointerId);
    const p = this.local(e);
    const world = screenToWorld(p.x, p.y);
    const tool = $tool.get();

    if (e.button === 1 || this.spaceDown || tool === "hand") {
      this.gesture = { kind: "pan", lastX: p.x, lastY: p.y };
      this.root.style.cursor = "grabbing";
      return;
    }

    if (tool === "text") {
      this.placeText(world.x, world.y);
      return;
    }

    if (tool === "rect" || tool === "circle") {
      this.gesture = { kind: "create", tool, sx: p.x, sy: p.y, cx: p.x, cy: p.y };
      scene.requestRender();
      return;
    }

    if (tool === "line" || tool === "arrow") {
      const hit = scene.hitTestShape(world);
      if (hit) {
        this.gesture = { kind: "connect", from: hit, px: p.x, py: p.y, directed: tool === "arrow" };
      }
      return;
    }

    // ---- select tool ----
    const single = this.singleSelectedShape();
    if (single) {
      const handle = this.hitHandle(single, p);
      if (handle >= 0) {
        this.gesture = { kind: "resize", id: single.id, handle, aspect: this.aspectOf(single) };
        return;
      }
    }

    const sel = $selection.get();
    for (const eid of sel.edges) {
      const e2 = doc.board.edges[eid];
      if (!e2) continue;
      const from = doc.board.shapes[e2.from];
      const to = doc.board.shapes[e2.to];
      if (!from || !to) continue;
      const mid = resolveEdgeGeometry(doc.board.edges, e2, from, to).mid;
      const ms = worldToScreen(mid.x, mid.y);
      if (Math.hypot(p.x - ms.x, p.y - ms.y) <= EDGE_HANDLE_R + 4) {
        this.gesture = { kind: "edgeCtrl", id: eid };
        return;
      }
    }

    const hitShape = scene.hitTestShape(world);
    if (hitShape) {
      if (e.shiftKey) {
        const shapes = new Set(sel.shapes);
        if (shapes.has(hitShape)) shapes.delete(hitShape);
        else shapes.add(hitShape);
        setSelection(shapes, sel.edges);
        this.gesture = { kind: "none" };
      } else {
        if (!sel.shapes.has(hitShape)) setSelection([hitShape], []);
        this.gesture = { kind: "move", lastWX: world.x, lastWY: world.y, moved: false };
      }
      return;
    }

    const hitEdge = scene.hitTestEdge(world, this.worldTol(8));
    if (hitEdge) {
      if (e.shiftKey) {
        const edges = new Set(sel.edges);
        if (edges.has(hitEdge)) edges.delete(hitEdge);
        else edges.add(hitEdge);
        setSelection(sel.shapes, edges);
      } else {
        setSelection([], [hitEdge]);
      }
      this.gesture = { kind: "none" };
      return;
    }

    if (!e.shiftKey) clearSelection();
    this.gesture = {
      kind: "marquee",
      sx: p.x,
      sy: p.y,
      cx: p.x,
      cy: p.y,
      base: new Set(e.shiftKey ? sel.shapes : []),
    };
    scene.requestRender();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const g = this.gesture;
    const p = this.local(e);
    if (g.kind === "none") {
      this.updateHoverCursor(p);
      return;
    }
    const world = screenToWorld(p.x, p.y);

    switch (g.kind) {
      case "pan":
        panBy(p.x - g.lastX, p.y - g.lastY);
        g.lastX = p.x;
        g.lastY = p.y;
        break;
      case "connect":
        g.px = p.x;
        g.py = p.y;
        scene.requestRender();
        break;
      case "create":
      case "marquee":
        g.cx = p.x;
        g.cy = p.y;
        scene.requestRender();
        break;
      case "move":
        actions.moveShapesBy($selection.get().shapes, world.x - g.lastWX, world.y - g.lastWY);
        g.lastWX = world.x;
        g.lastWY = world.y;
        g.moved = true;
        break;
      case "edgeCtrl":
        actions.updateEdge(g.id, { cx: world.x, cy: world.y });
        break;
      case "resize": {
        const rs = doc.board.shapes[g.id];
        if (rs?.kind === "text") this.applyTextResize(g.id, g.handle, world);
        else this.applyResize(g.id, g.handle, g.aspect, world);
        break;
      }
    }
  };

  /** Show resize cursors when hovering a handle of the single selected shape. */
  private updateHoverCursor(p: Pt): void {
    if ($tool.get() !== "select" || this.spaceDown) return;
    const single = this.singleSelectedShape();
    const handle = single ? this.hitHandle(single, p) : -1;
    this.root.style.cursor = handle >= 0 ? RESIZE_CURSORS[handle] : "default";
  }

  private onPointerUp = (e: PointerEvent): void => {
    const g = this.gesture;
    this.gesture = { kind: "none" };
    try {
      this.root.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    if (g.kind === "create") {
      this.commitCreate(g);
    } else if (g.kind === "connect") {
      const p = this.local(e);
      const world = screenToWorld(p.x, p.y);
      const target = scene.hitTestShape(world);
      if (target && target !== g.from) {
        const edge = actions.createEdge(g.from, target, g.directed);
        if (edge) {
          setSelection([], [edge.id]);
          $tool.set("select");
        }
      }
    } else if (g.kind === "marquee") {
      const moved = Math.hypot(g.cx - g.sx, g.cy - g.sy) > MOVE_THRESHOLD;
      if (moved) {
        const a = screenToWorld(g.sx, g.sy);
        const b = screenToWorld(g.cx, g.cy);
        const ids = scene.shapesInRect(a.x, a.y, b.x, b.y);
        const merged = new Set(g.base);
        for (const id of ids) merged.add(id);
        setSelection(merged, []);
      }
    }
    this.updateCursor();
    scene.requestRender();
  };

  private commitCreate(g: Extract<Gesture, { kind: "create" }>): void {
    const start = screenToWorld(g.sx, g.sy);
    const cur = screenToWorld(g.cx, g.cy);
    const dragPx = Math.hypot(g.cx - g.sx, g.cy - g.sy);
    let shape: Shape;
    if (dragPx < 4) {
      shape = actions.createShape(
        g.tool,
        start.x - DEFAULT_SIZE / 2,
        start.y - DEFAULT_SIZE / 2,
      );
    } else {
      const { x, y, side } = squareBox(start.x, start.y, cur.x, cur.y);
      const s = Math.max(8, side);
      shape = actions.createShape(g.tool, x, y, s, s);
    }
    setSelection([shape.id], []);
    $tool.set("select");
  }

  /**
   * Aspect-locked resize from any of the 8 handles. `aspect` = w/h to preserve
   * (1 for square shapes, natural ratio for images). Corners pin the opposite
   * corner; edges pin the opposite edge and stay centered on the other axis.
   */
  private applyResize(id: ID, handle: number, aspect: number, world: Pt): void {
    const s = doc.board.shapes[id];
    if (!s) return;
    const left = s.x;
    const top = s.y;
    const right = s.x + s.w;
    const bottom = s.y + s.h;
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;

    let nx: number;
    let ny: number;
    let nw: number;
    let nh: number;

    if (handle % 2 === 0) {
      // corner: opposite corner stays fixed
      const fx = handle === 0 || handle === 6 ? right : left;
      const fy = handle === 0 || handle === 2 ? bottom : top;
      nh = Math.max(Math.abs(world.y - fy), Math.abs(world.x - fx) / aspect, MIN_SIZE, MIN_SIZE / aspect);
      nw = nh * aspect;
      nx = world.x < fx ? fx - nw : fx;
      ny = world.y < fy ? fy - nh : fy;
    } else if (handle === 1 || handle === 5) {
      // top / bottom edge: vertical drives, horizontal centered
      const fy = handle === 1 ? bottom : top;
      nh = Math.max(Math.abs(world.y - fy), MIN_SIZE, MIN_SIZE / aspect);
      nw = nh * aspect;
      nx = cx - nw / 2;
      ny = world.y < fy ? fy - nh : fy;
    } else {
      // left / right edge: horizontal drives, vertical centered
      const fx = handle === 7 ? right : left;
      nw = Math.max(Math.abs(world.x - fx), MIN_SIZE, MIN_SIZE * aspect);
      nh = nw / aspect;
      ny = cy - nh / 2;
      nx = world.x < fx ? fx - nw : fx;
    }

    actions.updateShape(id, { x: nx, y: ny, w: nw, h: nh });
  }

  /**
   * Resize a text object by scaling its font size. Text boxes are content-sized,
   * so dragging a handle scales the font (the box re-measures to fit) while the
   * side opposite the dragged handle stays pinned.
   */
  private applyTextResize(id: ID, handle: number, world: Pt): void {
    const s = doc.board.shapes[id];
    if (!s) return;
    const left = s.x;
    const top = s.y;
    const right = s.x + s.w;
    const bottom = s.y + s.h;
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    const curFont = s.fontSize ?? TEXT_FONT_SIZE;

    // scale factor from the drag, relative to the current box (≈ proportional to font)
    let k: number;
    if (handle % 2 === 0) {
      const fx = handle === 0 || handle === 6 ? right : left;
      const fy = handle === 0 || handle === 2 ? bottom : top;
      k = Math.max(Math.abs(world.y - fy) / s.h, Math.abs(world.x - fx) / s.w);
    } else if (handle === 1 || handle === 5) {
      const fy = handle === 1 ? bottom : top;
      k = Math.abs(world.y - fy) / s.h;
    } else {
      const fx = handle === 7 ? right : left;
      k = Math.abs(world.x - fx) / s.w;
    }

    const nf = Math.min(MAX_FONT, Math.max(MIN_FONT, curFont * k));
    const box = measureTextBox(s.text, nf);

    // pin the side opposite the dragged handle
    let nx: number;
    if (handle === 0 || handle === 6 || handle === 7) nx = right - box.w;
    else if (handle === 2 || handle === 3 || handle === 4) nx = left;
    else nx = cx - box.w / 2;
    let ny: number;
    if (handle === 0 || handle === 1 || handle === 2) ny = bottom - box.h;
    else if (handle === 4 || handle === 5 || handle === 6) ny = top;
    else ny = cy - box.h / 2;

    actions.updateShape(id, { fontSize: nf, x: nx, y: ny, w: box.w, h: box.h });
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.01));
    } else {
      panBy(-e.deltaX, -e.deltaY);
    }
  };

  private onDblClick = (e: MouseEvent): void => {
    const p = this.local(e);
    const world = screenToWorld(p.x, p.y);
    const hitShape = scene.hitTestShape(world);
    if (hitShape) {
      this.beginShapeText(hitShape);
      return;
    }
    const hitEdge = scene.hitTestEdge(world, this.worldTol(8));
    if (hitEdge) {
      this.beginEdgeLabel(hitEdge);
      return;
    }
    // empty canvas -> create a text object and start typing
    this.placeText(world.x, world.y);
  };

  // ---- keyboard ----
  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.textEditor.active || this.palette.active || isEditingDom()) return;
    const meta = e.metaKey || e.ctrlKey;

    if (meta && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (meta && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      redo();
      return;
    }
    if (meta && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      copySelection();
      return;
    }
    if (meta && (e.key === "x" || e.key === "X")) {
      e.preventDefault();
      cutSelection();
      return;
    }
    if (meta && (e.key === "v" || e.key === "V")) {
      e.preventDefault();
      pasteClipboard();
      return;
    }
    if (meta && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      setSelection(doc.board.order, Object.keys(doc.board.edges));
      return;
    }

    if (e.key === " ") {
      this.spaceDown = true;
      this.updateCursor();
      return;
    }
    if (e.key === "Escape") {
      clearSelection();
      this.gesture = { kind: "none" };
      scene.requestRender();
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && !meta) {
      e.preventDefault();
      actions.deleteSelection();
      return;
    }
    if (e.key === "/" && !meta) {
      e.preventDefault();
      this.palette.open();
      return;
    }
    // Text/label editing is started only by double-clicking the shape or line.
    if (!meta && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "v") return void $tool.set("select");
      if (k === "t") return void $tool.set("text");
      if (k === "r") return void $tool.set("rect");
      if (k === "o") return void $tool.set("circle");
      if (k === "l") return void $tool.set("line");
      if (k === "a") return void $tool.set("arrow");
      if (k === "m") return void $tool.set("hand");
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === " ") {
      this.spaceDown = false;
      this.updateCursor();
    }
  };

  // ---- text editing ----

  /** Create a free-floating text object at a world point and edit it immediately. */
  private placeText(wx: number, wy: number): void {
    const shape = actions.createShape("text", wx, wy, 40, 30, {
      fill: "#e2e8f0",
      stroke: "#e2e8f0",
    });
    setSelection([shape.id], []);
    $tool.set("select");
    this.beginShapeText(shape.id, "", true);
  }

  private beginShapeText(id: ID, seed = "", isNewText = false): void {
    const s = doc.board.shapes[id];
    if (!s) return;
    setSelection([id], []);
    this.editOriginal = s.text;
    const value = seed ? s.text + seed : s.text;
    const tl = worldToScreen(s.x, s.y);
    const zoom = this.zoom();

    if (s.kind === "text") {
      // grow-with-content editor that overlays the floating text
      const finish = (v: string) => {
        actions.setShapeText(id, v);
        if (v.trim() === "") actions.deleteShape(id);
      };
      this.textEditor.open({
        x: tl.x,
        y: tl.y,
        w: s.w * zoom,
        h: s.h * zoom,
        value,
        color: s.fill,
        background: "rgba(11,18,32,0.85)",
        fontSize: (s.fontSize ?? TEXT_FONT_SIZE) * zoom,
        align: "left",
        autoGrow: true,
        padding: TEXT_PAD * zoom,
        onInput: (v) => actions.setShapeText(id, v),
        onCommit: finish,
        onCancel: () => {
          if (isNewText) actions.deleteShape(id);
          else actions.setShapeText(id, this.editOriginal);
        },
      });
      if (seed) actions.setShapeText(id, value);
      return;
    }

    const bg = s.kind === "icon" || s.kind === "image" ? "rgba(11,18,32,0.92)" : s.fill;
    this.textEditor.open({
      x: tl.x,
      y: tl.y,
      w: s.w * zoom,
      h: s.h * zoom,
      value,
      color: numToCss(readableText(s.fill)),
      background: bg,
      fontSize: 16 * zoom,
      onInput: (v) => actions.setShapeText(id, v),
      onCommit: (v) => actions.setShapeText(id, v),
      onCancel: () => actions.setShapeText(id, this.editOriginal),
    });
    if (seed) actions.setShapeText(id, value);
  }

  private beginEdgeLabel(id: ID, seed = ""): void {
    const edge = doc.board.edges[id];
    if (!edge) return;
    const from = doc.board.shapes[edge.from];
    const to = doc.board.shapes[edge.to];
    if (!from || !to) return;
    setSelection([], [id]);
    this.editOriginal = edge.label;
    const value = seed ? edge.label + seed : edge.label;
    const mid = resolveEdgeGeometry(doc.board.edges, edge, from, to).mid;
    const ms = worldToScreen(mid.x, mid.y);
    const w = 160;
    this.textEditor.open({
      x: ms.x - w / 2,
      y: ms.y - 14,
      w,
      h: 22,
      value,
      color: "#e2e8f0",
      background: "rgba(11,18,32,0.95)",
      fontSize: 14,
      onInput: (v) => actions.setEdgeLabel(id, v),
      onCommit: (v) => actions.setEdgeLabel(id, v),
      onCancel: () => actions.setEdgeLabel(id, this.editOriginal),
    });
    if (seed) actions.setEdgeLabel(id, value);
  }

  private insertIcon(key: string): void {
    const { w, h } = scene.screenSize();
    const c = screenToWorld(w / 2, h / 2);
    const shape = actions.createShape(
      "icon",
      c.x - DEFAULT_SIZE / 2,
      c.y - DEFAULT_SIZE / 2,
      DEFAULT_SIZE,
      DEFAULT_SIZE,
      { icon: key },
    );
    setSelection([shape.id], []);
    $tool.set("select");
  }

  // ---- image drop ----
  private onDragOver = (e: DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };

  private onWindowDrop = (e: DragEvent): void => {
    // safety net so dropping outside the canvas doesn't navigate away
    e.preventDefault();
  };

  private onDrop = (e: DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const dt = e.dataTransfer;
    if (!dt) return;
    const p = this.local(e);
    const world = screenToWorld(p.x, p.y);

    const files = [...dt.files].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      let offset = 0;
      for (const file of files) {
        this.addImageFile(file, world.x + offset, world.y + offset);
        offset += 18;
      }
      return;
    }
    const url = dt.getData("text/uri-list") || dt.getData("text/plain");
    if (url && /^https?:\/\//.test(url.trim())) {
      void this.addImageUrl(url.trim(), world.x, world.y);
    }
  };

  private addImageFile(file: File, wx: number, wy: number): void {
    const reader = new FileReader();
    reader.onload = () => this.placeImage(String(reader.result), wx, wy);
    reader.readAsDataURL(file);
  }

  private async addImageUrl(url: string, wx: number, wy: number): Promise<void> {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      if (!blob.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => this.placeImage(String(reader.result), wx, wy);
      reader.readAsDataURL(blob);
    } catch {
      /* cross-origin or unreachable — ignore */
    }
  }

  private placeImage(src: string, wx: number, wy: number): void {
    const img = new Image();
    img.onload = () => {
      const long = Math.max(img.naturalWidth, img.naturalHeight) || 1;
      const scale = 260 / long;
      const w = Math.max(8, Math.round(img.naturalWidth * scale));
      const h = Math.max(8, Math.round(img.naturalHeight * scale));
      const shape = actions.createShape("image", wx - w / 2, wy - h / 2, w, h, { src });
      setSelection([shape.id], []);
      $tool.set("select");
    };
    img.src = src;
  }

  // ---- overlay (screen space) ----
  private drawOverlay(g: Graphics): void {
    const sel = $selection.get();

    for (const id of sel.shapes) {
      const s = doc.board.shapes[id];
      if (!s) continue;
      const tl = worldToScreen(s.x, s.y);
      const br = worldToScreen(s.x + s.w, s.y + s.h);
      g.roundRect(tl.x - 3, tl.y - 3, br.x - tl.x + 6, br.y - tl.y + 6, 5);
      g.stroke({ width: 2, color: SELECT });
    }

    const single = this.singleSelectedShape();
    if (single) {
      for (const c of this.handlePoints(single)) {
        g.rect(c.x - HANDLE / 2, c.y - HANDLE / 2, HANDLE, HANDLE);
        g.fill(0x0b1220);
        g.stroke({ width: 1.5, color: SELECT });
      }
    }

    for (const eid of sel.edges) {
      const e = doc.board.edges[eid];
      if (!e) continue;
      const from = doc.board.shapes[e.from];
      const to = doc.board.shapes[e.to];
      if (!from || !to) continue;
      const geo = resolveEdgeGeometry(doc.board.edges, e, from, to);
      const pts = geo.ctrl ? quadPoints(geo.p1, geo.ctrl, geo.p2, 16) : [geo.p1, geo.p2];
      const s0 = worldToScreen(pts[0].x, pts[0].y);
      g.moveTo(s0.x, s0.y);
      for (let i = 1; i < pts.length; i++) {
        const sp = worldToScreen(pts[i].x, pts[i].y);
        g.lineTo(sp.x, sp.y);
      }
      g.stroke({ width: 4, color: SELECT, alpha: 0.55, cap: "round" });
      const ms = worldToScreen(geo.mid.x, geo.mid.y);
      g.circle(ms.x, ms.y, EDGE_HANDLE_R);
      g.fill(0x0b1220);
      g.stroke({ width: 1.5, color: SELECT });
    }

    const gest = this.gesture;
    if (gest.kind === "marquee") {
      const x = Math.min(gest.sx, gest.cx);
      const y = Math.min(gest.sy, gest.cy);
      g.rect(x, y, Math.abs(gest.cx - gest.sx), Math.abs(gest.cy - gest.sy));
      g.fill({ color: ACCENT, alpha: 0.08 });
      g.stroke({ width: 1, color: ACCENT, alpha: 0.8 });
    } else if (gest.kind === "create") {
      const { x, y, side } = squareBox(gest.sx, gest.sy, gest.cx, gest.cy);
      if (gest.tool === "circle") g.ellipse(x + side / 2, y + side / 2, side / 2, side / 2);
      else g.roundRect(x, y, side, side, 4);
      g.fill({ color: ACCENT, alpha: 0.1 });
      g.stroke({ width: 1.5, color: ACCENT });
    } else if (gest.kind === "connect") {
      const from = doc.board.shapes[gest.from];
      if (from) {
        const w = screenToWorld(gest.px, gest.py);
        const bp = boundaryPoint(from, w);
        const bs = worldToScreen(bp.x, bp.y);
        g.moveTo(bs.x, bs.y);
        g.lineTo(gest.px, gest.py);
        g.stroke({ width: 2, color: ACCENT, alpha: 0.9 });
        if (gest.directed) {
          const ang = Math.atan2(gest.py - bs.y, gest.px - bs.x);
          const sz = 11;
          const sp = Math.PI / 7;
          g.moveTo(gest.px - sz * Math.cos(ang - sp), gest.py - sz * Math.sin(ang - sp));
          g.lineTo(gest.px, gest.py);
          g.lineTo(gest.px - sz * Math.cos(ang + sp), gest.py - sz * Math.sin(ang + sp));
          g.stroke({ width: 2, color: ACCENT, alpha: 0.9, cap: "round", join: "round" });
        } else {
          g.circle(gest.px, gest.py, 4);
          g.fill(ACCENT);
        }
      }
    }
  }
}
