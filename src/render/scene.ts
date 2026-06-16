import { Application, Container, Graphics } from "pixi.js";
import { $camera, doc } from "../state/store";
import type { ID } from "../state/types";
import {
  type Pt,
  distToSegment,
  pointInShape,
  quadPoints,
  rectIntersectsShape,
  resolveEdgeGeometry,
} from "./geometry";
import { createEdgeView, type EdgeView, updateEdgeView } from "./edgeView";
import { createNodeView, type NodeView, updateNodeView } from "./shapeView";

class Scene {
  app!: Application;
  private world!: Container;
  /** single z-stack holding both edge and node views, ordered by `doc.board.order` */
  private itemLayer!: Container;
  private overlay!: Graphics;

  private nodeViews = new Map<ID, NodeView>();
  private edgeViews = new Map<ID, EdgeView>();
  private nodeEdges = new Map<ID, Set<ID>>();

  private overlayRenderer: ((g: Graphics) => void) | null = null;
  private renderScheduled = false;
  private ready = false;

  async init(host: HTMLElement): Promise<void> {
    const app = new Application();
    await app.init({
      width: host.clientWidth || window.innerWidth,
      height: host.clientHeight || window.innerHeight,
      antialias: true,
      backgroundAlpha: 0,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      preference: "webgl",
      preserveDrawingBuffer: true,
    });
    this.app = app;
    host.appendChild(app.canvas);
    app.stage.eventMode = "none";
    app.ticker.stop();

    this.world = new Container();
    this.itemLayer = new Container();
    this.world.addChild(this.itemLayer);
    this.overlay = new Graphics();
    app.stage.addChild(this.world, this.overlay);

    this.ready = true;
    this.applyCamera();
  }

  screenSize(): { w: number; h: number } {
    return { w: this.app.renderer.width, h: this.app.renderer.height };
  }

  resize(w: number, h: number): void {
    if (!this.ready) return;
    this.app.renderer.resize(w, h);
    this.requestRender();
  }

  applyCamera(): void {
    if (!this.ready) return;
    const c = $camera.get();
    this.world.position.set(c.x, c.y);
    this.world.scale.set(c.zoom);
    this.requestRender();
  }

  setOverlay(fn: ((g: Graphics) => void) | null): void {
    this.overlayRenderer = fn;
    this.requestRender();
  }

  requestRender(): void {
    if (!this.ready || this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.overlay.clear();
      if (this.overlayRenderer) this.overlayRenderer(this.overlay);
      this.app.render();
    });
  }

  // ---- node lifecycle ----
  addNode(id: ID): void {
    const s = doc.board.shapes[id];
    if (!s) return;
    const view = createNodeView(s, () => this.requestRender());
    this.nodeViews.set(id, view);
    this.itemLayer.addChild(view.container);
    this.requestRender();
  }

  updateNode(id: ID): void {
    const view = this.nodeViews.get(id);
    const s = doc.board.shapes[id];
    if (!view || !s) return;
    updateNodeView(view, s, () => this.requestRender());
    const edges = this.nodeEdges.get(id);
    if (edges) for (const eid of edges) this.refreshEdge(eid);
    this.requestRender();
  }

  /** Hide/show just a node's label text (keeps the icon/shape) while its label is edited in an overlay. */
  setNodeLabelHidden(id: ID, hidden: boolean): void {
    const view = this.nodeViews.get(id);
    if (!view || view.labelHidden === hidden) return;
    view.labelHidden = hidden;
    if (view.text) view.text.visible = !hidden;
    this.requestRender();
  }

  removeNode(id: ID): void {
    const view = this.nodeViews.get(id);
    if (view) {
      this.itemLayer.removeChild(view.container);
      view.container.destroy({ children: true });
      this.nodeViews.delete(id);
    }
    this.nodeEdges.delete(id);
    this.requestRender();
  }

  /** Re-sort the item layer's paint order (back→front) to match `doc.board.order`. */
  reorder(): void {
    let idx = 0;
    for (const id of doc.board.order) {
      const view = this.nodeViews.get(id) ?? this.edgeViews.get(id);
      // `idx` only advances for placed views, so it stays a valid child index
      if (view) this.itemLayer.setChildIndex(view.container, idx++);
    }
    this.requestRender();
  }

  // ---- edge lifecycle ----
  addEdge(id: ID): void {
    const e = doc.board.edges[id];
    if (!e) return;
    const view = createEdgeView(e.from, e.to);
    this.edgeViews.set(id, view);
    this.itemLayer.addChild(view.container);
    this.registerAdj(id, e.from, e.to);
    // a new parallel edge changes how its siblings fan, so refresh them too
    for (const sid of this.pairEdges(e.from, e.to)) this.refreshEdge(sid);
    this.requestRender();
  }

  updateEdge(id: ID): void {
    const e = doc.board.edges[id];
    if (!e) return;
    // re-register in case endpoints changed (they don't today, but cheap)
    this.refreshEdge(id);
    this.requestRender();
  }

  removeEdge(id: ID): void {
    const view = this.edgeViews.get(id);
    const from = view?.from;
    const to = view?.to;
    if (view) {
      this.itemLayer.removeChild(view.container);
      view.container.destroy({ children: true });
      this.edgeViews.delete(id);
    }
    for (const set of this.nodeEdges.values()) set.delete(id);
    // the remaining siblings re-fan now that this one is gone
    if (from && to) for (const sid of this.pairEdges(from, to)) this.refreshEdge(sid);
    this.requestRender();
  }

  /** Edge ids connecting both `a` and `b` (parallel edges of one pair). */
  private pairEdges(a: ID | undefined, b: ID | undefined): ID[] {
    if (a === undefined || b === undefined) return [];
    const sa = this.nodeEdges.get(a);
    const sb = this.nodeEdges.get(b);
    if (!sa || !sb) return [];
    const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
    const out: ID[] = [];
    for (const id of small) if (big.has(id)) out.push(id);
    return out;
  }

  private registerAdj(edgeId: ID, from: ID | undefined, to: ID | undefined): void {
    for (const nid of [from, to]) {
      if (nid === undefined) continue;
      let set = this.nodeEdges.get(nid);
      if (!set) {
        set = new Set();
        this.nodeEdges.set(nid, set);
      }
      set.add(edgeId);
    }
  }

  private refreshEdge(id: ID): void {
    const view = this.edgeViews.get(id);
    const e = doc.board.edges[id];
    if (!view || !e) return;
    updateEdgeView(view, e, resolveEdgeGeometry(doc.board.edges, doc.board.shapes, e));
  }

  // ---- bulk ----
  rebuild(): void {
    this.clear();
    // walk the unified z-stack so edges and nodes interleave by paint order
    for (const id of doc.board.order) {
      if (doc.board.shapes[id]) this.addNode(id);
      else if (doc.board.edges[id]) this.addEdge(id);
    }
    // safety net: draw anything `order` forgot to mention (stacked on top)
    for (const id of Object.keys(doc.board.shapes))
      if (!this.nodeViews.has(id)) this.addNode(id);
    for (const id of Object.keys(doc.board.edges))
      if (!this.edgeViews.has(id)) this.addEdge(id);
    this.requestRender();
  }

  private clear(): void {
    for (const v of this.nodeViews.values()) v.container.destroy({ children: true });
    for (const v of this.edgeViews.values()) v.container.destroy({ children: true });
    this.nodeViews.clear();
    this.edgeViews.clear();
    this.nodeEdges.clear();
    this.itemLayer.removeChildren();
  }

  // ---- hit testing (world space) ----
  hitTestShape(p: Pt): ID | null {
    const order = doc.board.order;
    for (let i = order.length - 1; i >= 0; i--) {
      const s = doc.board.shapes[order[i]];
      if (s && pointInShape(s, p)) return s.id;
    }
    return null;
  }

  hitTestEdge(p: Pt, tol: number): ID | null {
    let best: ID | null = null;
    let bestD = tol;
    for (const e of Object.values(doc.board.edges)) {
      const geo = resolveEdgeGeometry(doc.board.edges, doc.board.shapes, e);
      const pts = geo.ctrl ? quadPoints(geo.p1, geo.ctrl, geo.p2, 14) : [geo.p1, geo.p2];
      for (let i = 0; i < pts.length - 1; i++) {
        const d = distToSegment(p, pts[i], pts[i + 1]);
        if (d < bestD) {
          bestD = d;
          best = e.id;
        }
      }
    }
    return best;
  }

  shapesInRect(x0: number, y0: number, x1: number, y1: number): ID[] {
    const rx0 = Math.min(x0, x1);
    const ry0 = Math.min(y0, y1);
    const rx1 = Math.max(x0, x1);
    const ry1 = Math.max(y0, y1);
    const out: ID[] = [];
    for (const id of doc.board.order) {
      const s = doc.board.shapes[id];
      if (s && rectIntersectsShape(rx0, ry0, rx1, ry1, s)) out.push(id);
    }
    return out;
  }

  exportThumbnail(): string | undefined {
    if (!this.ready) return undefined;
    try {
      this.app.render();
      const src = this.app.canvas as HTMLCanvasElement;
      if (!src.width || !src.height) return undefined;
      const tw = 320;
      const th = Math.max(1, Math.round((tw * src.height) / src.width));
      const c = document.createElement("canvas");
      c.width = tw;
      c.height = th;
      const ctx = c.getContext("2d");
      if (!ctx) return undefined;
      ctx.fillStyle = "#0b1220";
      ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(src, 0, 0, tw, th);
      return c.toDataURL("image/jpeg", 0.5);
    } catch {
      return undefined;
    }
  }

  destroy(): void {
    if (!this.ready) return;
    this.ready = false;
    this.clear();
    this.app.destroy(true, { children: true });
  }
}

export const scene = new Scene();
