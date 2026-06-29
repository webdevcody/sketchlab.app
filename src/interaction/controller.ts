import type { Graphics } from "pixi.js";
import {
  boundaryPoint,
  type Pt,
  quadPoints,
  resolveEdgeGeometry,
} from "../render/geometry";
import { drawFlowPulseDots, flowPulsePhase } from "../render/edgeView";
import {
  NAMEPLATE_BACKGROUND_CSS,
  NAMEPLATE_FONT_WEIGHT,
  NAMEPLATE_PAD_Y,
  NAMEPLATE_TEXT_CSS,
  NAMEPLATE_TRACKING,
} from "../render/labelStyle";
import { getActiveProjector, projectBoard, scaleAtBoard } from "../render/projection";
import { isShapeInViewport } from "../render/culling";
import { scene } from "../render/scene";
import { elevationOf, floorElevation, floorOf, H_ARROW, H_PED } from "../render/shading";
import { defaultLabelFont } from "../render/shapeView";
import * as actions from "../state/actions";
import { DEFAULT_SIZE } from "../state/actions";
import { copySelection, cutSelection, pasteClipboard } from "../state/clipboard";
import { redo, undo } from "../state/history";
import { DEFAULT_TEXT_FONT_SIZE } from "../state/style";
import {
  $activeLayer,
  $camera,
  $selection,
  $style,
  $tool,
  clearSelection,
  doc,
  setSelection,
} from "../state/store";
import type { ID, Shape } from "../state/types";
import { measureTextBox, TEXT_FONT_SIZE, TEXT_PAD } from "../render/measure";
import { panBy, panByScreen, rotateBy, spaceLayersBy, tiltBy, zoomAt } from "./camera";
import { ContextMenu } from "./contextMenu";
import { IconPalette } from "./iconPalette";
import { getWheelZoom } from "./inputPrefs";
import { TextEditor } from "./textEditor";
import { screenToWorld, screenToWorldAt, worldToScreen } from "./viewport";

const ACCENT = 0x38bdf8;
const SELECT = 0xfacc15; // yellow — selection outline/handles, distinct from shape strokes
const HANDLE = 9;
const EDGE_HANDLE_R = 6;
const MOVE_THRESHOLD = 3;
// radians of pitch per wheel-delta unit for Alt/Option+scroll camera tilt
// (~9° per typical 100-unit notch); setCamera clamps the result to its pitch range
const TILT_SPEED = 0.0015;
// radians of canvas spin per wheel-delta unit for Option+horizontal swipe
// (~17° per typical 100-unit swipe); rotateBy wraps the angle to (-π, π]
const ROTATE_SPEED = 0.003;
// radians per pixel of Alt/Option + drag camera orbit. Horizontal drag spins the
// turntable (yaw, wraps); vertical drag tilts the pitch (setCamera clamps it).
const ORBIT_YAW_SPEED = 0.006;
const ORBIT_TILT_SPEED = 0.005;
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
  | { kind: "orbit"; lastX: number; lastY: number }
  | {
      kind: "create";
      tool: "rect" | "circle";
      sx: number;
      sy: number;
      cx: number;
      cy: number;
      square: boolean;
    }
  | { kind: "marquee"; sx: number; sy: number; cx: number; cy: number; base: Set<ID> }
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
  private altDown = false;
  private textEditor: TextEditor;
  private palette: IconPalette;
  private menu: ContextMenu;
  private editOriginal = "";
  private subs: Array<() => void> = [];
  /** Last canvas-local pointer position, so a keyboard paste can target the cursor. */
  private lastPointer: Pt | null = null;

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
    scene.setOverlayPulseActive(false);
    scene.setOverlay(null);
  }

  // ---- helpers ----
  private local(e: PointerEvent | MouseEvent | WheelEvent): Pt {
    const r = this.root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** px-per-world-unit at a ground point (perspective makes this depth-dependent). */
  private localScale(world: Pt): number {
    const sc = scaleAtBoard(getActiveProjector(), world.x, world.y);
    return sc > 1e-6 ? sc : 1e-6;
  }

  private updateCursor(): void {
    const tool = $tool.get();
    let c = "default";
    // Alt = orbit the camera; signal it with a move cursor so the gesture is
    // discoverable. Takes precedence over the tool's own affordance.
    if (this.altDown) c = "move";
    else if (this.spaceDown || tool === "hand") c = "grab";
    else if (tool === "text") c = "text";
    else if (tool === "rect" || tool === "circle" || tool === "line" || tool === "arrow")
      c = "crosshair";
    this.root.style.cursor = c;
  }

  /**
   * Elevation the selection outline + resize handles ride at — the SAME plane the
   * outline box/ring is drawn at in drawOverlay, so handles glue to the visible
   * shape: the lifted slab top (base + H_PED) for rect/image/circle/icon, the
   * ground plane (base) for text. Keep this in sync with drawOverlay.
   */
  private outlineElevation(s: Shape): number {
    return elevationOf(s) + (s.kind === "text" ? 0 : H_PED);
  }

  /** 8 resize handles (screen space) in index order: tl,t,tr,r,br,b,bl,l.
   * Every handle is projected from its TRUE world position at the outline's
   * elevation, so corners land on the perspective-warped corners and edge
   * midpoints sit on the warped edges (not axis-aligned screen averages). */
  private handlePoints(s: Shape): Pt[] {
    const proj = getActiveProjector();
    const h = this.outlineElevation(s);
    const at = (wx: number, wy: number): Pt => {
      const p = projectBoard(proj, wx, wy, h);
      return { x: p.sx, y: p.sy };
    };
    const midX = s.x + s.w / 2;
    const midY = s.y + s.h / 2;
    return [
      at(s.x, s.y), // 0 tl
      at(midX, s.y), // 1 top
      at(s.x + s.w, s.y), // 2 tr
      at(s.x + s.w, midY), // 3 right
      at(s.x + s.w, s.y + s.h), // 4 br
      at(midX, s.y + s.h), // 5 bottom
      at(s.x, s.y + s.h), // 6 bl
      at(s.x, midY), // 7 left
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
    // pick the frontmost shape under the cursor on ANY floor — the active floor
    // is just a visual highlight, not a selection filter
    const hit = scene.hitTestShape(p, false);
    if (!hit) {
      this.menu.close();
      return;
    }
    if (!$selection.get().shapes.has(hit)) setSelection([hit], []);
    const ids = [...$selection.get().shapes];
    const items = [
      { label: "Bring to Front", hint: "=", onSelect: () => actions.bringToFront(ids) },
      { label: "Bring Forward", hint: "]", onSelect: () => actions.bringForward(ids) },
      { label: "Send Backward", hint: "[", onSelect: () => actions.sendBackward(ids) },
      { label: "Send to Back", hint: "-", onSelect: () => actions.sendToBack(ids) },
    ];
    // when the board has named floors, offer to move the selection onto each one
    const layers = doc.board.layers ?? [];
    if (layers.length > 1) {
      const here = doc.board.shapes[hit]?.layer ?? 0;
      layers.forEach((layer, i) => {
        items.push({
          label: `Move to ${layer.name}`,
          hint: i === here ? "•" : "",
          onSelect: () => actions.assignSelectionToLayer(ids, i),
        });
      });
    }
    this.menu.open(e.clientX, e.clientY, items);
  };

  // ---- pointer ----
  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.button !== 1) return;
    this.textEditor.commit();
    this.root.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.lastPointer = p;
    const world = screenToWorld(p.x, p.y);
    const tool = $tool.get();

    // Alt/Option + left-drag orbits the camera (horizontal = yaw, vertical =
    // tilt). A camera gesture: it ignores the active tool and needs no ground
    // point, so it works even when the cursor is above the horizon.
    if (e.button === 0 && e.altKey) {
      this.gesture = { kind: "orbit", lastX: p.x, lastY: p.y };
      this.root.style.cursor = "grabbing";
      return;
    }

    if (e.button === 1 || this.spaceDown || tool === "hand") {
      this.gesture = { kind: "pan", lastX: p.x, lastY: p.y };
      this.root.style.cursor = "grabbing";
      return;
    }

    if (!world) return; // clicked above the horizon — no ground point to act on

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
        fromId: scene.hitTestShape(p),
        sx: p.x,
        sy: p.y,
        px: p.x,
        py: p.y,
        directed: tool === "arrow",
      };
      scene.setOverlayPulseActive(tool === "arrow");
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
      const ms = worldToScreen(geo.mid.x, geo.mid.y);
      if (Math.hypot(p.x - ms.x, p.y - ms.y) <= EDGE_HANDLE_R + 4) {
        this.gesture = { kind: "edgeCtrl", id: eid };
        return;
      }
    }

    // single z-order-aware pick so an arrow drawn over a shape stays clickable.
    // Selection spans every floor (the active floor is only a highlight): the
    // frontmost token under the cursor wins regardless of the floor it sits on.
    const hit = scene.hitTestTop(p, 8, false);
    if (hit?.kind === "shape") {
      const hitShape = hit.id;
      if (e.shiftKey) {
        const shapes = new Set(sel.shapes);
        if (shapes.has(hitShape)) shapes.delete(hitShape);
        else shapes.add(hitShape);
        setSelection(shapes, sel.edges);
        this.gesture = { kind: "none" };
      } else {
        if (!sel.shapes.has(hitShape)) setSelection([hitShape], []);
        // focus the clicked token's floor so the highlight/dimming follow the
        // selection and newly drawn shapes land on the same floor
        const s = doc.board.shapes[hitShape];
        if (s) $activeLayer.set(floorOf(s));
        this.gesture = { kind: "move", lastWX: world.x, lastWY: world.y, moved: false };
      }
      return;
    }

    if (hit?.kind === "edge") {
      const hitEdge = hit.id;
      if (e.shiftKey) {
        const edges = new Set(sel.edges);
        if (edges.has(hitEdge)) edges.delete(hitEdge);
        else edges.add(hitEdge);
        setSelection(sel.shapes, edges);
        this.gesture = { kind: "none" };
      } else {
        if (!sel.edges.has(hitEdge)) setSelection([], [hitEdge]);
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
    };
    scene.requestRender();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const g = this.gesture;
    const p = this.local(e);
    this.lastPointer = p;
    if (g.kind === "none") {
      this.updateHoverCursor(p);
      return;
    }
    const world = screenToWorld(p.x, p.y);

    switch (g.kind) {
      case "pan":
        panBy(g.lastX, g.lastY, p.x, p.y);
        g.lastX = p.x;
        g.lastY = p.y;
        break;
      case "orbit":
        // horizontal drag spins the turntable, vertical drag tilts the pitch.
        // Drag down (dy > 0) lowers pitch toward the horizon — matching the
        // Alt+scroll tilt direction; setCamera clamps the pitch range.
        rotateBy((p.x - g.lastX) * ORBIT_YAW_SPEED);
        tiltBy(-(p.y - g.lastY) * ORBIT_TILT_SPEED);
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
        if (!world) break; // pointer dragged above the horizon — skip this frame
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
      case "edgeCtrl": {
        // bend follows the cursor on the edge's own floor, matching how the
        // curve is drawn (free ends ride the edge's layer, not the ground).
        const w = screenToWorldAt(p.x, p.y, this.edgeFreeElev(g.id));
        if (!w) break;
        actions.updateEdge(g.id, { cx: w.x, cy: w.y });
        break;
      }
      case "edgeEnd": {
        // re-aim a free endpoint on the edge's floor so it tracks the cursor
        // instead of dropping to the base ground plane.
        const w = screenToWorldAt(p.x, p.y, this.edgeFreeElev(g.id));
        if (!w) break;
        actions.updateEdge(
          g.id,
          g.end === "from" ? { x1: w.x, y1: w.y } : { x2: w.x, y2: w.y },
        );
        break;
      }
      case "resize": {
        const rs = doc.board.shapes[g.id];
        if (!rs) break;
        // unproject the cursor onto the SAME lifted plane the handles ride, so the
        // dragged edge tracks the handle under the pointer (not its ground shadow).
        const rw = screenToWorldAt(p.x, p.y, this.outlineElevation(rs));
        if (!rw) break;
        if (rs.kind === "text") this.applyTextResize(g.id, g.handle, rw);
        // circles are always 1:1, so lock their aspect regardless of the shift key
        else this.applyResize(g.id, g.handle, g.aspect, rw, e.shiftKey || rs.kind === "circle");
        break;
      }
    }
  };

  /** Show resize cursors when hovering a handle of the single selected shape. */
  private updateHoverCursor(p: Pt): void {
    if ($tool.get() !== "select" || this.spaceDown || this.altDown) return;
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
      if (g.directed) scene.setOverlayPulseActive(false);
      this.commitDrawEdge(g, e);
    } else if (g.kind === "marquee") {
      const moved = Math.hypot(g.cx - g.sx, g.cy - g.sy) > MOVE_THRESHOLD;
      if (moved) {
        const ids = scene.shapesInScreenRect(g.sx, g.sy, g.cx, g.cy, false);
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
    if (!start || !cur) return; // dragged onto the horizon — nothing to place
    const dragPx = Math.hypot(g.cx - g.sx, g.cy - g.sy);
    let shape: Shape;
    if (dragPx < 4) {
      shape = actions.createShape(
        g.tool,
        start.x - DEFAULT_SIZE / 2,
        start.y - DEFAULT_SIZE / 2,
      );
    } else {
      // circles are always 1:1 so the disc, bounding box, and selection ring agree
      const square = g.square || g.tool === "circle";
      const b = dragBox(start.x, start.y, cur.x, cur.y, square);
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
  /** World-up height a free end of edge `id` is drawn at (its floor + arrow hover). */
  private edgeFreeElev(id: ID): number {
    return floorElevation(doc.board.edges[id]?.layer ?? 0) + H_ARROW;
  }

  private commitDrawEdge(g: Extract<Gesture, { kind: "drawEdge" }>, e: PointerEvent): void {
    const end = this.local(e);
    const dragPx = Math.hypot(end.x - g.sx, end.y - g.sy);

    const fromId = g.fromId;
    const overTarget = scene.hitTestShape(end);
    const toId = overTarget && overTarget !== fromId ? overTarget : null;

    // Free ends resolve on the ACTIVE floor's plane (at the same lifted height
    // they'll be drawn at), so an arrow drawn while a layer is selected lands on
    // that layer instead of dropping its endpoints to the base ground plane.
    const layer = $activeLayer.get();
    const elev = floorElevation(layer) + H_ARROW;
    const startW = fromId ? null : screenToWorldAt(g.sx, g.sy, elev);
    const endW = toId ? null : screenToWorldAt(end.x, end.y, elev);
    // a needed free endpoint fell above the horizon -> nothing to commit
    if ((!fromId && !startW) || (!toId && !endW)) return;

    let edge: ReturnType<typeof actions.createFreeEdge> | null = null;
    if (fromId && toId) {
      // both ends on shapes -> standard connector (auto-fans with siblings)
      edge = actions.createEdge(fromId, toId, g.directed);
    } else if (dragPx >= MOVE_THRESHOLD) {
      // at least one free end -> floating / half-anchored line on the active floor
      edge = actions.createFreeEdge({
        from: fromId ?? undefined,
        to: toId ?? undefined,
        x1: fromId ? undefined : startW!.x,
        y1: fromId ? undefined : startW!.y,
        x2: toId ? undefined : endW!.x,
        y2: toId ? undefined : endW!.y,
        directed: g.directed,
        layer,
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
      const base = s.fontSize ?? defaultLabelFont(s.kind);
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
    if (e.altKey && (e.ctrlKey || e.metaKey)) {
      // Option + pinch-zoom spaces the stacked floors apart/together. A pinch
      // arrives as a ctrl-wheel, so this must be tested before the zoom branch.
      // Mirror zoom's curve: pinch-out (deltaY < 0) fans the stack wider.
      spaceLayersBy(Math.exp(-e.deltaY * 0.01));
    } else if (e.ctrlKey || e.metaKey) {
      // ⌘/Ctrl + scroll or trackpad pinch → zoom toward the cursor.
      zoomAt(Math.exp(-e.deltaY * 0.01), p.x, p.y);
    } else if (e.altKey) {
      // Alt/Option+scroll: route by the dominant swipe axis so a trackpad gesture
      // (which carries both deltas) does one thing cleanly. Horizontal → spin the
      // canvas around its center origin; vertical → tilt the camera. Tilt: scroll
      // down (deltaY > 0) lowers the pitch toward the horizon so stacked floors
      // spread apart; scroll up flattens toward a top-down view.
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        rotateBy(e.deltaX * ROTATE_SPEED);
      } else {
        tiltBy(-e.deltaY * TILT_SPEED);
      }
    } else if (getWheelZoom()) {
      // opt-in (Controls → "Scroll wheel zooms"): a plain wheel notch zooms toward
      // the cursor instead of panning — the behavior a mouse user expects.
      zoomAt(Math.exp(-e.deltaY * 0.01), p.x, p.y);
    } else {
      panByScreen(-e.deltaX, -e.deltaY);
    }
  };

  private onDblClick = (e: MouseEvent): void => {
    const p = this.local(e);
    const world = screenToWorld(p.x, p.y);
    if (!world) return;
    // editing is a selection-like action — target any floor's frontmost shape
    const hit = scene.hitTestTop(p, 8, false);
    if (hit?.kind === "shape") {
      this.beginShapeText(hit.id);
      return;
    }
    if (hit?.kind === "edge") {
      this.beginEdgeLabel(hit.id);
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
      // center the paste under the cursor; fall back to a cascade when the
      // pointer is unknown or above the horizon (no ground point to land on)
      const at = this.lastPointer
        ? screenToWorld(this.lastPointer.x, this.lastPointer.y)
        : null;
      pasteClipboard(at ?? undefined);
      return;
    }
    if (meta && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      setSelection(Object.keys(doc.board.shapes), Object.keys(doc.board.edges));
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
    // hold Alt/Option to enter camera-orbit mode (drag to rotate + tilt); reflect
    // it in the cursor so the gesture is discoverable
    if (e.key === "Alt" && !this.altDown) {
      this.altDown = true;
      this.updateCursor();
      return;
    }
    if (e.key === "Escape") {
      clearSelection();
      if (this.gesture.kind === "drawEdge" && this.gesture.directed) scene.setOverlayPulseActive(false);
      this.gesture = { kind: "none" };
      scene.requestRender();
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && !meta) {
      e.preventDefault();
      actions.deleteSelection();
      return;
    }
    // layering: lift/sink the selected shapes through 3D layers.
    // "=" (or "+") to the very front, "-" (or "_") to the very back;
    // "]" one layer forward, "[" one layer back.
    if (!meta && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      actions.bringToFront($selection.get().shapes);
      return;
    }
    if (!meta && (e.key === "-" || e.key === "_")) {
      e.preventDefault();
      actions.sendToBack($selection.get().shapes);
      return;
    }
    if (!meta && e.key === "]") {
      e.preventDefault();
      actions.bringForward($selection.get().shapes);
      return;
    }
    if (!meta && e.key === "[") {
      e.preventDefault();
      actions.sendBackward($selection.get().shapes);
      return;
    }
    // cycle the active/highlighted floor through the stack (↑ up, ↓ down)
    if (!meta && (e.key === "ArrowUp" || e.key === "PageUp")) {
      e.preventDefault();
      actions.cycleActiveLayer(1);
      return;
    }
    if (!meta && (e.key === "ArrowDown" || e.key === "PageDown")) {
      e.preventDefault();
      actions.cycleActiveLayer(-1);
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
    } else if (e.key === "Alt") {
      this.altDown = false;
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
    // editor overlay (a hardcoded box wouldn't line up with the auto-grown editor)
    const fontSize = $style.get().fontSize;
    const box = measureTextBox("", fontSize);
    const shape = actions.createShape("text", wx, wy, box.w, box.h, {
      fill: "#e2e8f0",
      fontSize,
    });
    setSelection([shape.id], []);
    $tool.set("select");
    this.beginShapeText(shape.id, "", true);
  }

  private beginNameplateText(id: ID, s: Shape, value: string, seed: string): void {
    const proj = getActiveProjector();
    const fontSize = s.fontSize ?? defaultLabelFont(s.kind);
    const cx = s.x + s.w / 2;
    const footY = s.y + s.h + 14;
    const base = elevationOf(s);
    const foot = projectBoard(proj, cx, footY, base);
    if (!foot.ok) return;

    const sc = Math.max(0.1, scaleAtBoard(proj, cx, footY, base));
    const w = Math.max(80, s.w * 1.5) * sc;

    // Non-text shape labels render as nameplates below the token; edit in that
    // same projected position so the typed text matches where it will commit.
    scene.setNodeLabelHidden(id, true);
    const restore = () => scene.setNodeLabelHidden(id, false);
    this.textEditor.open({
      x: foot.sx,
      y: foot.sy,
      w,
      h: fontSize * 1.3 * sc,
      value,
      color: "#e8edf3",
      background: "transparent",
      fontSize: fontSize * sc,
      fontWeight: "700",
      letterSpacing: 1.5 * sc,
      lineHeight: fontSize * 1.3 * sc,
      align: "center",
      autoGrow: true,
      noWrap: true,
      centerX: true,
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
  }

  private beginShapeText(id: ID, seed = "", isNewText = false): void {
    const s = doc.board.shapes[id];
    if (!s) return;
    setSelection([id], []);
    this.editOriginal = s.text;
    const value = seed ? s.text + seed : s.text;

    if (s.kind === "text") {
      const tlp = projectBoard(getActiveProjector(), s.x, s.y, elevationOf(s));
      const tl = { x: tlp.sx, y: tlp.sy };
      // perspective makes pixel scale depth-dependent; size the HTML editor by it
      const zoom = this.localScale({ x: s.x + s.w / 2, y: s.y + s.h / 2 });
      const fontSize = s.fontSize ?? TEXT_FONT_SIZE;
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

    this.beginNameplateText(id, s, value, seed);
    if (seed) actions.setShapeText(id, value);
  }

  private beginEdgeLabel(id: ID, seed = ""): void {
    const edge = doc.board.edges[id];
    if (!edge) return;
    setSelection([], [id]);
    this.editOriginal = edge.label;
    const value = seed ? edge.label + seed : edge.label;
    const mid = resolveEdgeGeometry(doc.board.edges, doc.board.shapes, edge).mid;
    const ms = projectBoard(getActiveProjector(), mid.x, mid.y, H_ARROW);
    if (!ms.ok) return;
    const sc = Math.max(0.4, ms.scale);
    const fontSize = (edge.fontSize ?? DEFAULT_TEXT_FONT_SIZE) * sc;
    const lineHeight = fontSize * 1.3;
    const h = lineHeight + NAMEPLATE_PAD_Y * 2 * sc;
    const w = Math.max(120, 160 * sc);
    this.textEditor.open({
      x: ms.sx,
      y: ms.sy - h / 2,
      w,
      h,
      value,
      color: NAMEPLATE_TEXT_CSS,
      background: NAMEPLATE_BACKGROUND_CSS,
      fontSize,
      fontWeight: NAMEPLATE_FONT_WEIGHT,
      letterSpacing: NAMEPLATE_TRACKING * sc,
      lineHeight,
      centerX: true,
      noWrap: true,
      selectAll: !seed,
      onInput: (v) => actions.setEdgeLabel(id, v),
      onCommit: (v) => actions.setEdgeLabel(id, v),
      onCancel: () => actions.setEdgeLabel(id, this.editOriginal),
    });
    if (seed) actions.setEdgeLabel(id, value);
  }

  private insertIcon(key: string): void {
    // a single rect/circle selected → lock the icon into the center of that token
    const single = this.singleSelectedShape();
    if (single && (single.kind === "rect" || single.kind === "circle")) {
      actions.updateShape(single.id, { icon: key });
      $tool.set("select");
      return;
    }
    // otherwise drop a standalone icon token at the screen center
    const { w, h } = scene.screenSize();
    const cam = $camera.get();
    const c = screenToWorld(w / 2, h / 2) ?? { x: cam.focusX, y: cam.focusY };
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
    if (!world) return;

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

  /** Project a ground ellipse ring to screen points, or [] if any vertex is behind. */
  private projGroundRing(cx: number, cy: number, rx: number, ry: number, h: number, n = 28): Pt[] {
    const proj = getActiveProjector();
    const out: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const p = projectBoard(proj, cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, h);
      if (!p.ok) return [];
      out.push({ x: p.sx, y: p.sy });
    }
    return out;
  }

  /** Project the 4 ground corners of a shape's box at height `h`, or [] if any is behind. */
  private projGroundBox(s: Shape, h: number): Pt[] {
    const proj = getActiveProjector();
    const corners: Array<[number, number]> = [
      [s.x, s.y],
      [s.x + s.w, s.y],
      [s.x + s.w, s.y + s.h],
      [s.x, s.y + s.h],
    ];
    const out: Pt[] = [];
    for (const [x, y] of corners) {
      const p = projectBoard(proj, x, y, h);
      if (!p.ok) return [];
      out.push({ x: p.sx, y: p.sy });
    }
    return out;
  }

  private tracePoly(g: Graphics, pts: Pt[]): void {
    if (!pts.length) return;
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.closePath();
  }

  // ---- overlay (screen space) ----
  private drawOverlay(g: Graphics): void {
    const sel = $selection.get();
    const proj = getActiveProjector();
    const viewport = scene.screenSize();

    for (const id of sel.shapes) {
      const s = doc.board.shapes[id];
      if (!s) continue;
      if (!isShapeInViewport(s, proj, viewport)) continue;
      // circle/icon get a ring around the raised disc; rect/image a box around the
      // raised slab; text a box on the ground. Everything rides the shape's layer
      // elevation so the outline stays glued to a lifted token.
      const elev = this.outlineElevation(s); // handles ride this exact plane too
      let pts: Pt[];
      if (s.kind === "circle" || s.kind === "icon") {
        // the disc is a circle of radius min(w,h)/2, so ring that exact circle
        // (padded) rather than the w×h bounding ellipse — keeps the outline
        // hugging the disc instead of ballooning into an oval.
        const r = (Math.min(s.w, s.h) / 2) * 1.14;
        pts = this.projGroundRing(s.x + s.w / 2, s.y + s.h / 2, r, r, elev);
      } else {
        pts = this.projGroundBox(s, elev); // rect, image — slab top; text — ground
      }
      if (!pts.length) continue;
      this.tracePoly(g, pts);
      g.stroke({ width: 2, color: SELECT });
    }

    const single = this.singleSelectedShape();
    if (single && isShapeInViewport(single, proj, viewport)) {
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
      const ms = worldToScreen(geo.mid.x, geo.mid.y);
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
      const a = screenToWorld(gest.sx, gest.sy);
      const c = screenToWorld(gest.cx, gest.cy);
      if (a && c) {
        // mirror commitCreate: circles preview as a 1:1 box so the draft matches
        const square = gest.square || gest.tool === "circle";
        const b = dragBox(a.x, a.y, c.x, c.y, square); // ground-space draft box
        const pts =
          gest.tool === "circle"
            ? this.projGroundRing(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0)
            : this.projGroundBox({ x: b.x, y: b.y, w: b.w, h: b.h } as Shape, 0);
        if (pts.length) {
          this.tracePoly(g, pts);
          g.fill({ color: ACCENT, alpha: 0.1 });
          this.tracePoly(g, pts);
          g.stroke({ width: 1.5, color: ACCENT });
        }
      }
    } else if (gest.kind === "drawEdge") {
      // start anchors to a shape boundary if we pressed on one, else the raw point
      const fromShape = gest.fromId ? doc.board.shapes[gest.fromId] : null;
      let bs: Pt;
      if (fromShape) {
        const w = screenToWorld(gest.px, gest.py);
        const target = w ?? { x: fromShape.x + fromShape.w / 2, y: fromShape.y + fromShape.h / 2 };
        const bp = boundaryPoint(fromShape, target);
        // lift the start to the shape's floor (+ arrow hover) so the preview
        // begins at the raised token — NOT its ground shadow. Mirrors the height
        // reprojectEdgeView draws the committed edge's anchored end at.
        const lifted = projectBoard(
          getActiveProjector(),
          bp.x,
          bp.y,
          elevationOf(fromShape) + H_ARROW,
        );
        bs = { x: lifted.sx, y: lifted.sy };
      } else {
        bs = { x: gest.sx, y: gest.sy };
      }
      g.moveTo(bs.x, bs.y);
      g.lineTo(gest.px, gest.py);
      g.stroke({ width: 2, color: ACCENT, alpha: 0.9 });
      if (gest.directed) {
        drawFlowPulseDots(
          g,
          [
            { sx: bs.x, sy: bs.y },
            { sx: gest.px, sy: gest.py },
          ],
          flowPulsePhase(),
        );
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

  /** A small square handle (screen space) drawn at a free edge endpoint. */
  private drawEndHandle(g: Graphics, worldPt: Pt): void {
    const s = worldToScreen(worldPt.x, worldPt.y);
    g.rect(s.x - HANDLE / 2, s.y - HANDLE / 2, HANDLE, HANDLE);
    g.fill(0x0b1220);
    g.stroke({ width: 1.5, color: SELECT });
  }
}
