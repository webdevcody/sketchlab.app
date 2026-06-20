import type { Graphics } from "pixi.js";
import {
  boundaryPoint,
  edgeBendHandle,
  type Pt,
  quadPoints,
  readableText,
  resolveEdgeGeometry,
} from "../render/geometry";
import { scene } from "../render/scene";
import { effectiveEdgeFontSize } from "../render/edgeView";
import { effectiveFontSize } from "../render/shapeView";
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
import { MAX_FONT, measureTextBox, MIN_FONT, TEXT_FONT_SIZE, TEXT_PAD } from "../render/measure";
import { panBy, zoomAt } from "./camera";
import { ContextMenu } from "./contextMenu";
import { IconPalette } from "./iconPalette";
import { TextEditor } from "./textEditor";
import { screenToWorld, worldToScreen } from "./viewport";

const ACCENT = 0x38bdf8;
const SELECT = 0xfacc15; // yellow — selection outline/handles, distinct from shape strokes
const HANDLE = 9;
const EDGE_HANDLE_R = 6;
const MOVE_THRESHOLD = 3;
const MIN_SIZE = 16;

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
  | {
      kind: "create";
      tool: "rect" | "circle";
      sx: number;
      sy: number;
      cx: number;
      cy: number;
      square: boolean;
    }
  | {
      kind: "marquee";
      sx: number;
      sy: number;
      cx: number;
      cy: number;
      base: Set<ID>;
      baseEdges: Set<ID>;
    }
  | { kind: "move"; lastWX: number; lastWY: number; moved: boolean }
  | {
      kind: "drawEdge";
      fromId: ID | null;
      sx: number;
      sy: number;
      px: number;
      py: number;
      directed: boolean;
    }
  | { kind: "edgeCtrl"; id: ID }
  | { kind: "edgeEnd"; id: ID; end: "from" | "to" }
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

/**
 * The draft box for a drag from (sx,sy) to (cx,cy). Free width/height by default;
 * `square` locks it to a 1:1 box (used while shift is held).
 */
function dragBox(sx: number, sy: number, cx: number, cy: number, square: boolean) {
  if (square) {
    const { x, y, side } = squareBox(sx, sy, cx, cy);
    return { x, y, w: side, h: side };
  }
  return {
    x: Math.min(sx, cx),
    y: Math.min(sy, cy),
    w: Math.abs(cx - sx),
    h: Math.abs(cy - sy),
  };
}

export class Controller {
  private gesture: Gesture = { kind: "none" };
  private spaceDown = false;
  private textEditor: TextEditor;
  private palette: IconPalette;
  private menu: ContextMenu;
  private editOriginal = "";
  private subs: Array<() => void> = [];
  /** Set by the UI so the `f` / `u` keys can open the fill / outline color popover it owns. */
  onColorHotkey: ((target: "fill" | "stroke") => void) | null = null;

  constructor(private root: HTMLElement) {
    this.textEditor = new TextEditor(root);
    this.palette = new IconPalette(root, (key) => this.insertIcon(key));
    this.menu = new ContextMenu(root);

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
    this.menu.close();
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

  /**
   * Right-click opens a z-order menu for the shape under the cursor. If that
   * shape isn't already selected, select just it first (matches the usual
   * "right-click targets what you clicked" behavior).
   */
  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    const p = this.local(e);
    const world = screenToWorld(p.x, p.y);
    const hit = scene.hitTestShape(world);
    if (!hit) {
      this.menu.close();
      return;
    }
    if (!$selection.get().shapes.has(hit)) {
      const m = actions.groupSiblings(hit);
      setSelection(m.shapes, m.edges);
    }
    const sel = $selection.get();
    const ids = [...sel.shapes];
    const count = sel.shapes.size + sel.edges.size;
    const hasGroup =
      [...sel.shapes].some((id) => doc.board.shapes[id]?.group !== undefined) ||
      [...sel.edges].some((id) => doc.board.edges[id]?.group !== undefined);
    this.menu.open(e.clientX, e.clientY, [
      { label: "Bring to Front", hint: "]", onSelect: () => actions.bringToFront(ids) },
      { label: "Send to Back", hint: "[", onSelect: () => actions.sendToBack(ids) },
      { label: "Group", hint: "⌘G", disabled: count < 2, onSelect: () => actions.groupSelection() },
      { label: "Ungroup", hint: "⌘U", disabled: !hasGroup, onSelect: () => actions.ungroupSelection() },
    ]);
  };

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
      this.gesture = { kind: "create", tool, sx: p.x, sy: p.y, cx: p.x, cy: p.y, square: e.shiftKey };
      scene.requestRender();
      return;
    }

    if (tool === "line" || tool === "arrow") {
      // start on a shape -> anchor that end; start on empty canvas -> free end.
      // either way we drag out a line that can end on a shape or float free.
      this.gesture = {
        kind: "drawEdge",
        fromId: scene.hitTestShape(world),
        sx: p.x,
        sy: p.y,
        px: p.x,
        py: p.y,
        directed: tool === "arrow",
      };
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
      const geo = resolveEdgeGeometry(doc.board.edges, doc.board.shapes, e2);
      // free endpoint handles let you re-aim a floating line's ends
      if (e2.from === undefined) {
        const s1 = worldToScreen(geo.p1.x, geo.p1.y);
        if (Math.hypot(p.x - s1.x, p.y - s1.y) <= EDGE_HANDLE_R + 4) {
          this.gesture = { kind: "edgeEnd", id: eid, end: "from" };
          return;
        }
      }
      if (e2.to === undefined) {
        const s2 = worldToScreen(geo.p2.x, geo.p2.y);
        if (Math.hypot(p.x - s2.x, p.y - s2.y) <= EDGE_HANDLE_R + 4) {
          this.gesture = { kind: "edgeEnd", id: eid, end: "to" };
          return;
        }
      }
      const bend = edgeBendHandle(e2, geo);
      const ms = worldToScreen(bend.x, bend.y);
      if (Math.hypot(p.x - ms.x, p.y - ms.y) <= EDGE_HANDLE_R + 4) {
        this.gesture = { kind: "edgeCtrl", id: eid };
        return;
      }
    }

    const hitShape = scene.hitTestShape(world);
    if (hitShape) {
      // a click on a grouped object selects the whole group, not just the object
      const m = actions.groupSiblings(hitShape);
      if (e.shiftKey) {
        const shapes = new Set(sel.shapes);
        const edges = new Set(sel.edges);
        const remove = shapes.has(hitShape);
        for (const id of m.shapes) remove ? shapes.delete(id) : shapes.add(id);
        for (const id of m.edges) remove ? edges.delete(id) : edges.add(id);
        setSelection(shapes, edges);
        this.gesture = { kind: "none" };
      } else {
        if (!sel.shapes.has(hitShape)) setSelection(m.shapes, m.edges);
        this.gesture = { kind: "move", lastWX: world.x, lastWY: world.y, moved: false };
      }
      return;
    }

    const hitEdge = scene.hitTestEdge(world, this.worldTol(8));
    if (hitEdge) {
      const m = actions.groupSiblings(hitEdge);
      if (e.shiftKey) {
        const shapes = new Set(sel.shapes);
        const edges = new Set(sel.edges);
        const remove = edges.has(hitEdge);
        for (const id of m.shapes) remove ? shapes.delete(id) : shapes.add(id);
        for (const id of m.edges) remove ? edges.delete(id) : edges.add(id);
        setSelection(shapes, edges);
        this.gesture = { kind: "none" };
      } else {
        if (!sel.edges.has(hitEdge)) setSelection(m.shapes, m.edges);
        // drag translates a floating line (a fully shape-anchored edge won't move)
        this.gesture = { kind: "move", lastWX: world.x, lastWY: world.y, moved: false };
      }
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
      baseEdges: new Set(e.shiftKey ? sel.edges : []),
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
      case "drawEdge":
        g.px = p.x;
        g.py = p.y;
        scene.requestRender();
        break;
      case "create":
        g.cx = p.x;
        g.cy = p.y;
        g.square = e.shiftKey;
        scene.requestRender();
        break;
      case "marquee":
        g.cx = p.x;
        g.cy = p.y;
        scene.requestRender();
        break;
      case "move": {
        const dx = world.x - g.lastWX;
        const dy = world.y - g.lastWY;
        const selNow = $selection.get();
        actions.moveShapesBy(selNow.shapes, dx, dy);
        actions.moveEdgesBy(selNow.edges, dx, dy);
        g.lastWX = world.x;
        g.lastWY = world.y;
        g.moved = true;
        break;
      }
      case "edgeCtrl":
        actions.updateEdge(g.id, { cx: world.x, cy: world.y });
        break;
      case "edgeEnd":
        actions.updateEdge(
          g.id,
          g.end === "from"
            ? { x1: world.x, y1: world.y }
            : { x2: world.x, y2: world.y },
        );
        break;
      case "resize": {
        const rs = doc.board.shapes[g.id];
        if (rs?.kind === "text") this.applyTextResize(g.id, g.handle, world);
        else this.applyResize(g.id, g.handle, g.aspect, world, e.shiftKey);
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
    } else if (g.kind === "drawEdge") {
      this.commitDrawEdge(g, e);
    } else if (g.kind === "marquee") {
      const moved = Math.hypot(g.cx - g.sx, g.cy - g.sy) > MOVE_THRESHOLD;
      if (moved) {
        const a = screenToWorld(g.sx, g.sy);
        const b = screenToWorld(g.cx, g.cy);
        const ids = scene.shapesInRect(a.x, a.y, b.x, b.y);
        const merged = new Set(g.base);
        for (const id of ids) merged.add(id);
        const edgeIds = scene.edgesInRect(a.x, a.y, b.x, b.y);
        const mergedEdges = new Set(g.baseEdges);
        for (const id of edgeIds) mergedEdges.add(id);
        // touching any group member selects the whole group
        const ex = actions.expandSelectionGroups(merged, mergedEdges);
        setSelection(ex.shapes, ex.edges);
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
      const b = dragBox(start.x, start.y, cur.x, cur.y, g.square);
      shape = actions.createShape(g.tool, b.x, b.y, Math.max(8, b.w), Math.max(8, b.h));
    }
    setSelection([shape.id], []);
    $tool.set("select");
  }

  /**
   * Finish a line/arrow drag. Each end is anchored to a shape if the pointer was
   * over one, otherwise it floats at the world point. Shape→shape makes a normal
   * connector; anything with a free end makes a floating line that lives anywhere.
   */
  private commitDrawEdge(g: Extract<Gesture, { kind: "drawEdge" }>, e: PointerEvent): void {
    const end = this.local(e);
    const startW = screenToWorld(g.sx, g.sy);
    const endW = screenToWorld(end.x, end.y);
    const dragPx = Math.hypot(end.x - g.sx, end.y - g.sy);

    const fromId = g.fromId;
    const overTarget = scene.hitTestShape(endW);
    const toId = overTarget && overTarget !== fromId ? overTarget : null;

    let edge: ReturnType<typeof actions.createFreeEdge> | null = null;
    if (fromId && toId) {
      // both ends on shapes -> standard connector (auto-fans with siblings)
      edge = actions.createEdge(fromId, toId, g.directed);
    } else if (dragPx >= MOVE_THRESHOLD) {
      // at least one free end -> floating / half-anchored line
      edge = actions.createFreeEdge({
        from: fromId ?? undefined,
        to: toId ?? undefined,
        x1: fromId ? undefined : startW.x,
        y1: fromId ? undefined : startW.y,
        x2: toId ? undefined : endW.x,
        y2: toId ? undefined : endW.y,
        directed: g.directed,
      });
    }
    if (edge) {
      setSelection([], [edge.id]);
      $tool.set("select");
    }
  }

  /**
   * Resize from any of the 8 handles. Free width/height by default; when
   * `lockAspect` is set (shift held) the box is constrained to `aspect` = w/h
   * (1 for rect/circle → square, natural ratio for images). Corners pin the
   * opposite corner; edges pin the opposite edge.
   */
  private applyResize(
    id: ID,
    handle: number,
    aspect: number,
    world: Pt,
    lockAspect: boolean,
  ): void {
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

    if (!lockAspect) {
      // free resize: each dragged edge moves independently of the rest
      if (handle % 2 === 0) {
        // corner: opposite corner stays fixed, both dimensions free
        const fx = handle === 0 || handle === 6 ? right : left;
        const fy = handle === 0 || handle === 2 ? bottom : top;
        nw = Math.max(Math.abs(world.x - fx), MIN_SIZE);
        nh = Math.max(Math.abs(world.y - fy), MIN_SIZE);
        nx = world.x < fx ? fx - nw : fx;
        ny = world.y < fy ? fy - nh : fy;
      } else if (handle === 1 || handle === 5) {
        // top / bottom edge: only height changes, width stays put
        const fy = handle === 1 ? bottom : top;
        nh = Math.max(Math.abs(world.y - fy), MIN_SIZE);
        nw = s.w;
        nx = s.x;
        ny = world.y < fy ? fy - nh : fy;
      } else {
        // left / right edge: only width changes, height stays put
        const fx = handle === 7 ? right : left;
        nw = Math.max(Math.abs(world.x - fx), MIN_SIZE);
        nh = s.h;
        ny = s.y;
        nx = world.x < fx ? fx - nw : fx;
      }
    } else if (handle % 2 === 0) {
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

    const patch: Partial<Shape> = { x: nx, y: ny, w: nw, h: nh };
    // scale the label with the object's height (an edge-only width drag keeps it)
    if (s.text && s.h > 0) {
      const base = effectiveFontSize(s);
      patch.fontSize = Math.min(MAX_FONT, Math.max(MIN_FONT, base * (nh / s.h)));
    }
    actions.updateShape(id, patch);
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
    const curFont = effectiveFontSize(s);

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
    if (this.textEditor.active || this.palette.active || this.menu.active || isEditingDom()) return;
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
      setSelection(Object.keys(doc.board.shapes), Object.keys(doc.board.edges));
      return;
    }
    // Cmd/Ctrl+G groups the selection, Cmd/Ctrl+U ungroups it.
    if (meta && !e.shiftKey && (e.key === "g" || e.key === "G")) {
      e.preventDefault();
      actions.groupSelection();
      return;
    }
    if (meta && (e.key === "u" || e.key === "U")) {
      e.preventDefault();
      actions.ungroupSelection();
      return;
    }

    // refresh the create preview when shift is toggled without moving the mouse
    if (e.key === "Shift" && this.gesture.kind === "create") {
      this.gesture.square = true;
      scene.requestRender();
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
    // Enter on a single selected shape/edge starts label editing, like double-click
    if (e.key === "Enter" && !meta) {
      const sel = $selection.get();
      if (sel.shapes.size === 1 && sel.edges.size === 0) {
        e.preventDefault();
        this.beginShapeText([...sel.shapes][0]);
        return;
      }
      if (sel.edges.size === 1 && sel.shapes.size === 0) {
        e.preventDefault();
        this.beginEdgeLabel([...sel.edges][0]);
        return;
      }
    }
    if ((e.key === "Backspace" || e.key === "Delete") && !meta) {
      e.preventDefault();
      actions.deleteSelection();
      return;
    }
    // font size: "=" / "+" larger, "-" / "_" smaller (selection or board default)
    if (!meta && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      actions.adjustFontSize(1);
      return;
    }
    if (!meta && (e.key === "-" || e.key === "_")) {
      e.preventDefault();
      actions.adjustFontSize(-1);
      return;
    }
    // z-order: "]" to front, "[" to back
    if (!meta && e.key === "]") {
      e.preventDefault();
      actions.bringToFront($selection.get().shapes);
      return;
    }
    if (!meta && e.key === "[") {
      e.preventDefault();
      actions.sendToBack($selection.get().shapes);
      return;
    }
    if (e.key === "/" && !meta) {
      e.preventDefault();
      this.palette.open();
      return;
    }
    // "f" opens the fill color popover, "u" the outline one; the per-color letter
    // keys that pick a swatch are handled by the popover itself while it's open.
    if (!meta && !e.altKey && this.onColorHotkey) {
      if (e.key === "f") return void this.onColorHotkey("fill");
      if (e.key === "u") return void this.onColorHotkey("stroke");
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
    } else if (e.key === "Shift" && this.gesture.kind === "create") {
      this.gesture.square = false;
      scene.requestRender();
    }
  };

  // ---- text editing ----

  /** Create a free-floating text object at a world point and edit it immediately. */
  private placeText(wx: number, wy: number): void {
    // size the shape to the real text metrics so the selection box matches the
    // editor overlay (a hardcoded box wouldn't line up with the auto-grown editor).
    // Measure at the board's current font scale so a fresh text box isn't medium-sized.
    const box = measureTextBox("", TEXT_FONT_SIZE * (doc.board.fontScale ?? 1));
    const shape = actions.createShape("text", wx, wy, box.w, box.h, {
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
      const fontSize = effectiveFontSize(s);
      // hide the rendered text so the chromeless editor isn't doubled by it
      scene.setNodeLabelHidden(id, true);
      // grow-with-content editor that overlays the floating text
      const finish = (v: string) => {
        scene.setNodeLabelHidden(id, false);
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
        background: "transparent",
        fontSize: fontSize * zoom,
        fontWeight: "600",
        lineHeight: fontSize * 1.3 * zoom,
        align: "left",
        autoGrow: true,
        chromeless: true,
        selectAll: !seed,
        padding: TEXT_PAD * zoom,
        onInput: (v) => actions.setShapeText(id, v),
        onCommit: finish,
        onCancel: () => {
          scene.setNodeLabelHidden(id, false);
          if (isNewText) actions.deleteShape(id);
          else actions.setShapeText(id, this.editOriginal);
        },
      });
      if (seed) actions.setShapeText(id, value);
      return;
    }

    if (s.kind === "icon" || s.kind === "image") {
      // edit the label in place beneath the object; hide the rendered label so it isn't doubled,
      // and mirror its exact style so editing looks identical to the committed caption
      scene.setNodeLabelHidden(id, true);
      const restore = () => scene.setNodeLabelHidden(id, false);
      const w = Math.max(80, s.w * 1.5) * zoom;
      const fontSize = effectiveFontSize(s);
      this.textEditor.open({
        x: tl.x + (s.w * zoom - w) / 2,
        y: tl.y + s.h * zoom + 6 * zoom,
        w,
        h: fontSize * 1.3 * zoom,
        value,
        color: "#e2e8f0",
        background: "transparent",
        fontSize: fontSize * zoom,
        fontWeight: "500",
        lineHeight: fontSize * 1.3 * zoom,
        align: "center",
        chromeless: true,
        selectAll: !seed,
        padding: 0,
        onInput: (v) => actions.setShapeText(id, v),
        onCommit: (v) => {
          restore();
          actions.setShapeText(id, v);
        },
        onCancel: () => {
          restore();
          actions.setShapeText(id, this.editOriginal);
        },
      });
      if (seed) actions.setShapeText(id, value);
      return;
    }

    // rect / circle: label is centered inside the shape. Hide the rendered label and let the
    // chromeless editor sit directly on the shape fill, mirroring the label's exact style.
    scene.setNodeLabelHidden(id, true);
    const restoreLabel = () => scene.setNodeLabelHidden(id, false);
    const labelFont = effectiveFontSize(s);
    this.textEditor.open({
      x: tl.x,
      y: tl.y,
      w: s.w * zoom,
      h: s.h * zoom,
      value,
      color: numToCss(readableText(s.fill)),
      background: "transparent",
      fontSize: labelFont * zoom,
      fontWeight: "500",
      lineHeight: labelFont * 1.25 * zoom,
      chromeless: true,
      selectAll: !seed,
      padding: 8 * zoom,
      onInput: (v) => actions.setShapeText(id, v),
      onCommit: (v) => {
        restoreLabel();
        actions.setShapeText(id, v);
      },
      onCancel: () => {
        restoreLabel();
        actions.setShapeText(id, this.editOriginal);
      },
    });
    if (seed) actions.setShapeText(id, value);
  }

  private beginEdgeLabel(id: ID, seed = ""): void {
    const edge = doc.board.edges[id];
    if (!edge) return;
    setSelection([], [id]);
    this.editOriginal = edge.label;
    const value = seed ? edge.label + seed : edge.label;
    const mid = resolveEdgeGeometry(doc.board.edges, doc.board.shapes, edge).mid;
    const ms = worldToScreen(mid.x, mid.y);
    const { zoom } = $camera.get();
    const labelFont = effectiveEdgeFontSize(edge);
    const w = 160;
    this.textEditor.open({
      x: ms.x - w / 2,
      y: ms.y - labelFont * 0.5 * zoom,
      w,
      h: labelFont * 1.3 * zoom,
      value,
      color: "#e2e8f0",
      background: "rgba(11,18,32,0.95)",
      fontSize: labelFont * zoom,
      selectAll: !seed,
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

    // dashed bounds around each selected group, so grouped objects read as one unit
    const groupBox = new Map<ID, { x0: number; y0: number; x1: number; y1: number }>();
    const growGroup = (gid: ID, x0: number, y0: number, x1: number, y1: number): void => {
      const b = groupBox.get(gid);
      if (!b) groupBox.set(gid, { x0, y0, x1, y1 });
      else {
        b.x0 = Math.min(b.x0, x0);
        b.y0 = Math.min(b.y0, y0);
        b.x1 = Math.max(b.x1, x1);
        b.y1 = Math.max(b.y1, y1);
      }
    };
    for (const id of sel.shapes) {
      const s = doc.board.shapes[id];
      if (s?.group) growGroup(s.group, s.x, s.y, s.x + s.w, s.y + s.h);
    }
    for (const id of sel.edges) {
      const e = doc.board.edges[id];
      if (!e?.group) continue;
      const geo = resolveEdgeGeometry(doc.board.edges, doc.board.shapes, e);
      const pts = geo.ctrl ? [geo.p1, geo.ctrl, geo.p2] : [geo.p1, geo.p2];
      for (const p of pts) growGroup(e.group, p.x, p.y, p.x, p.y);
    }
    for (const b of groupBox.values()) {
      const tl = worldToScreen(b.x0, b.y0);
      const br = worldToScreen(b.x1, b.y1);
      this.strokeDashedRect(g, tl.x - 8, tl.y - 8, br.x - tl.x + 16, br.y - tl.y + 16);
    }

    for (const id of sel.shapes) {
      const s = doc.board.shapes[id];
      if (!s) continue;
      const tl = worldToScreen(s.x, s.y);
      const br = worldToScreen(s.x + s.w, s.y + s.h);
      if (s.kind === "circle") {
        // trace the circle itself, not a box, so selecting it doesn't read as a square
        g.ellipse((tl.x + br.x) / 2, (tl.y + br.y) / 2, (br.x - tl.x) / 2 + 3, (br.y - tl.y) / 2 + 3);
      } else {
        g.roundRect(tl.x - 3, tl.y - 3, br.x - tl.x + 6, br.y - tl.y + 6, 5);
      }
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
      const geo = resolveEdgeGeometry(doc.board.edges, doc.board.shapes, e);
      const pts = geo.ctrl ? quadPoints(geo.p1, geo.ctrl, geo.p2, 16) : [geo.p1, geo.p2];
      const s0 = worldToScreen(pts[0].x, pts[0].y);
      g.moveTo(s0.x, s0.y);
      for (let i = 1; i < pts.length; i++) {
        const sp = worldToScreen(pts[i].x, pts[i].y);
        g.lineTo(sp.x, sp.y);
      }
      g.stroke({ width: 4, color: SELECT, alpha: 0.55, cap: "round" });
      const bend = edgeBendHandle(e, geo);
      const ms = worldToScreen(bend.x, bend.y);
      g.circle(ms.x, ms.y, EDGE_HANDLE_R);
      g.fill(0x0b1220);
      g.stroke({ width: 1.5, color: SELECT });
      // square handles on free ends, so a floating line can be re-aimed
      if (e.from === undefined) this.drawEndHandle(g, geo.p1);
      if (e.to === undefined) this.drawEndHandle(g, geo.p2);
    }

    const gest = this.gesture;
    if (gest.kind === "marquee") {
      const x = Math.min(gest.sx, gest.cx);
      const y = Math.min(gest.sy, gest.cy);
      g.rect(x, y, Math.abs(gest.cx - gest.sx), Math.abs(gest.cy - gest.sy));
      g.fill({ color: ACCENT, alpha: 0.08 });
      g.stroke({ width: 1, color: ACCENT, alpha: 0.8 });
    } else if (gest.kind === "create") {
      const b = dragBox(gest.sx, gest.sy, gest.cx, gest.cy, gest.square);
      if (gest.tool === "circle") g.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2);
      else g.roundRect(b.x, b.y, b.w, b.h, 4);
      g.fill({ color: ACCENT, alpha: 0.1 });
      g.stroke({ width: 1.5, color: ACCENT });
    } else if (gest.kind === "drawEdge") {
      // start anchors to a shape boundary if we pressed on one, else the raw point
      const fromShape = gest.fromId ? doc.board.shapes[gest.fromId] : null;
      let bs: Pt;
      if (fromShape) {
        const w = screenToWorld(gest.px, gest.py);
        const bp = boundaryPoint(fromShape, w);
        bs = worldToScreen(bp.x, bp.y);
      } else {
        bs = { x: gest.sx, y: gest.sy };
      }
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

  /** A dashed rectangle (screen space) — used to bracket a selected group. */
  private strokeDashedRect(g: Graphics, x: number, y: number, w: number, h: number): void {
    const dash = 6;
    const gap = 4;
    const line = (x1: number, y1: number, x2: number, y2: number): void => {
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const ux = (x2 - x1) / len;
      const uy = (y2 - y1) / len;
      for (let d = 0; d < len; d += dash + gap) {
        const end = Math.min(d + dash, len);
        g.moveTo(x1 + ux * d, y1 + uy * d);
        g.lineTo(x1 + ux * end, y1 + uy * end);
      }
    };
    line(x, y, x + w, y);
    line(x + w, y, x + w, y + h);
    line(x + w, y + h, x, y + h);
    line(x, y + h, x, y);
    g.stroke({ width: 1.5, color: ACCENT, alpha: 0.9 });
  }

  /** A small square handle (screen space) drawn at a free edge endpoint. */
  private drawEndHandle(g: Graphics, worldPt: Pt): void {
    const s = worldToScreen(worldPt.x, worldPt.y);
    g.rect(s.x - HANDLE / 2, s.y - HANDLE / 2, HANDLE, HANDLE);
    g.fill(0x0b1220);
    g.stroke({ width: 1.5, color: SELECT });
  }
}
