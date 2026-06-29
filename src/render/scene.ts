import { Application, Container, Graphics, PerspectiveMesh, Texture } from "pixi.js";
import { $camera, doc } from "../state/store";
import type { Edge, ID, Shape } from "../state/types";
import { DEFAULT_FLOOR_COLOR, drawBoard, type GridBounds } from "./boardLayers";
import {
  createEdgeView,
  type EdgeView,
  flowPulsePhase,
  reprojectEdgeView,
  updateEdgeView,
} from "./edgeView";
import {
  type Pt,
  distToSegment,
  quadPoints,
  resolveEdgeGeometry,
} from "./geometry";
import {
  depthAtBoard,
  getActiveProjector,
  projectBoard,
  type Projector,
  projScreen,
  scaleAtBoard,
  setActiveProjector,
  toProjCamera,
  unprojectBoardAt,
} from "./projection";
import { createFloorLabelTexture, floorLabelKey } from "./floorLabel";
import { boardViewportBounds, isShapeInViewport } from "./culling";
import {
  elevationOf,
  floorElevation,
  floorOf,
  H_ARROW,
  H_PED,
  layerFade,
  layerOf,
} from "./shading";
import {
  createNodeView,
  type NodeView,
  reprojectNodeView,
  updateNodeView,
} from "./shapeView";
import { createFramePhases, RenderPerfRecorder, timePhase, type RenderFrameStats, type RenderPerfSummary } from "./perfStats";
import { isBatchablePedestal, PedestalBatch, type BatchNode } from "./pedestalBatch";
import { syncLayerOrder } from "./renderOrder";
import { ShapeSpatialIndex } from "./shapeSpatialIndex";

class Scene {
  app!: Application;
  private world!: Container;
  /** screen-space layer holding the projected tabletop frame + grid floor */
  private boardLayer!: Container;
  private boardGfx!: Graphics;
  /** layer holding the per-floor name placards (decaled flat onto each floor) */
  private badgeLayer!: Container;
  /** per-floor name placards, laid flat on each floor's top-left corner in perspective */
  private floorBadges: Array<{ mesh: PerspectiveMesh; texture: Texture | null; key: string; w: number; h: number }> = [];
  /** the highlighted floor index; drives the frame glow + token dimming */
  private activeLayer = 0;
  /** single z-stack holding both edge and node views, depth-sorted each frame */
  private itemLayer!: Container;
  /** screen-space nameplates, painted above arrows for readability */
  private labelLayer!: Container;
  private overlay!: Graphics;

  private nodeViews = new Map<ID, NodeView>();
  private edgeViews = new Map<ID, EdgeView>();
  private nodeEdges = new Map<ID, Set<ID>>();
  private directedEdges = new Set<ID>();
  private shapeIndex = new ShapeSpatialIndex();
  private pedestalBatch!: PedestalBatch;

  /** bumped on every camera change; views reproject lazily when their epoch lags */
  private cameraEpoch = 0;
  private pedestalBatchEpoch = -1;
  private pedestalBatchDirty = true;
  private visibilityDirty = true;
  private sortDirty = true;

  /** bounds the board floor/frame was last painted with, so a shape edit that
   * grows/shrinks the board redraws it immediately (not just on the next pan) */
  private lastBoardBounds: GridBounds | null = null;
  private boardBoundsCache: GridBounds | null = null;
  private boardBoundsDirty = true;
  private boardLayerDirty = true;

  private overlayRenderer: ((g: Graphics) => void) | null = null;
  private overlayPulseActive = false;
  private renderScheduled = false;
  private ready = false;
  private perf = new RenderPerfRecorder();
  private perfListeners = new Set<(stats: RenderFrameStats) => void>();
  private hitTestMsSinceLastFrame = 0;

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

    this.boardLayer = new Container();
    this.boardGfx = new Graphics();
    this.badgeLayer = new Container();
    this.boardLayer.addChild(this.boardGfx, this.badgeLayer);

    this.world = new Container(); // kept as an identity-transformed parent for items
    this.itemLayer = new Container();
    this.pedestalBatch = new PedestalBatch();
    this.itemLayer.addChild(this.pedestalBatch.container);
    this.labelLayer = new Container();
    this.world.addChild(this.itemLayer, this.labelLayer);

    this.overlay = new Graphics();
    // paint order: tabletop/grid → projected items → screen-space overlay
    app.stage.addChild(this.boardLayer, this.world, this.overlay);

    this.ready = true;
    this.applyCamera();
  }

  screenSize(): { w: number; h: number } {
    return { w: this.app.renderer.width, h: this.app.renderer.height };
  }

  getPerformanceSummary(): RenderPerfSummary {
    return this.perf.summary();
  }

  resetPerformanceStats(): void {
    this.perf.reset();
  }

  onPerformanceFrame(fn: (stats: RenderFrameStats) => void): () => void {
    this.perfListeners.add(fn);
    return () => this.perfListeners.delete(fn);
  }

  resize(w: number, h: number): void {
    if (!this.ready) return;
    this.app.renderer.resize(w, h);
    // the horizon depends on viewport height, so re-aim the projector + grid
    this.applyCamera();
  }

  applyCamera(): void {
    if (!this.ready) return;
    const cam = $camera.get();
    const { w, h } = this.screenSize();
    setActiveProjector(toProjCamera(cam), projScreen(cam, w, h));
    this.world.position.set(0, 0);
    this.world.scale.set(1);
    this.cameraEpoch++;
    this.sortDirty = true;
    this.pedestalBatchDirty = true;
    this.boardLayerDirty = true;
    this.requestRender();
  }

  /**
   * The FINITE board rectangle (a fixed object in world space, independent of the
   * camera/zoom), sized to the content plus a generous margin. Because it doesn't
   * scale with zoom, zooming just shrinks/grows the whole board uniformly instead
   * of extending the floor toward the horizon.
   */
  private computeBoardBounds(): GridBounds {
    const shapes = Object.values(doc.board.shapes);
    if (!shapes.length) return { minX: -900, minY: -680, maxX: 900, maxY: 680 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of shapes) {
      minX = Math.min(minX, s.x);
      minY = Math.min(minY, s.y);
      maxX = Math.max(maxX, s.x + s.w);
      maxY = Math.max(maxY, s.y + s.h);
    }
    const mx = Math.max(520, (maxX - minX) * 0.45);
    const my = Math.max(420, (maxY - minY) * 0.45);
    return { minX: minX - mx, minY: minY - my, maxX: maxX + mx, maxY: maxY + my };
  }

  private boardBounds(): GridBounds {
    if (!this.boardBoundsDirty && this.boardBoundsCache) return this.boardBoundsCache;
    const bounds = this.computeBoardBounds();
    this.boardBoundsCache = bounds;
    this.boardBoundsDirty = false;
    return bounds;
  }

  private markBoardBoundsDirty(): void {
    this.boardBoundsDirty = true;
  }

  /** The current finite board rectangle in world space (exposed for pan-clamping). */
  getBoardBounds(): GridBounds {
    return this.boardBounds();
  }

  /** Highest floor index any shape currently occupies (0 when none are elevated). */
  private maxShapeLayer(): number {
    let m = 0;
    for (const s of Object.values(doc.board.shapes)) m = Math.max(m, s.layer ?? 0);
    return m;
  }

  /** Number of floors to render: the named list, occupied shapes, or 1 (minimum). */
  private floorCount(): number {
    return Math.max(doc.board.layers?.length ?? 0, this.maxShapeLayer() + 1, 1);
  }

  /** World-up elevation of each rendered floor, bottom→top. */
  private floorElevations(): number[] {
    return Array.from({ length: this.floorCount() }, (_, i) => floorElevation(i));
  }

  /** Per-floor hidden flag (bottom→top); a hidden floor is dropped from the scene. */
  private hiddenFloors(): boolean[] {
    return Array.from({ length: this.floorCount() }, (_, i) => !!doc.board.layers?.[i]?.hidden);
  }

  /** Per-floor accent color (bottom→top); undefined falls back to cyan in drawFloor. */
  private floorColors(): Array<string | undefined> {
    return Array.from({ length: this.floorCount() }, (_, i) => doc.board.layers?.[i]?.color);
  }

  /** Whether floor `i` is hidden via its LayerDef. */
  private isFloorHidden(i: number): boolean {
    return !!doc.board.layers?.[i]?.hidden;
  }

  /** An edge is hidden when any floor it touches is hidden (a free end rides the ground). */
  private isEdgeHidden(e: Edge): boolean {
    const fr = e.from ? doc.board.shapes[e.from] : undefined;
    const to = e.to ? doc.board.shapes[e.to] : undefined;
    if (fr && this.isFloorHidden(floorOf(fr))) return true;
    if (to && this.isFloorHidden(floorOf(to))) return true;
    if ((e.from === undefined || e.to === undefined) && this.isFloorHidden(0)) return true;
    return false;
  }

  private redrawBoardLayer(b = this.boardBounds()): void {
    drawBoard(this.boardGfx, getActiveProjector(), b, this.floorElevations(), this.activeLayer, this.hiddenFloors(), this.floorColors());
    this.syncFloorBadges(b);
    this.lastBoardBounds = b;
    this.boardLayerDirty = false;
  }

  /** Repaint the board frames/plates + floor badges, then schedule a render. Used
   *  after a per-floor change (color, name) that alters the board chrome. */
  redrawBoard(): void {
    this.boardLayerDirty = true;
    this.visibilityDirty = true;
    this.pedestalBatchDirty = true;
    this.requestRender();
  }

  /** Re-evaluate floor visibility after a hide/show toggle: repaint frames & badges, then redraw items. */
  refreshLayerVisibility(): void {
    this.visibilityDirty = true;
    this.redrawBoard();
  }

  /**
   * Repaint the board floor/frame if the content-derived bounds changed since the
   * last paint. Called each render frame so moving/resizing a shape toward the
   * edge expands (or contracts) the board on the spot, without waiting for a pan.
   * Camera moves already force a full redraw via applyCamera(); this only fires
   * the extra redraw when the projector is unchanged but the bounds shifted.
   */
  private syncBoardBounds(): void {
    if (!this.boardBoundsDirty && !this.boardLayerDirty) return;
    const force = this.boardLayerDirty;
    const b = this.boardBounds();
    const last = this.lastBoardBounds;
    if (
      !force &&
      last &&
      last.minX === b.minX &&
      last.minY === b.minY &&
      last.maxX === b.maxX &&
      last.maxY === b.maxY
    ) {
      return;
    }
    this.redrawBoardLayer(b);
  }

  /** Highlight floor `i`: re-glow its frame and re-dim the off-floor tokens. */
  setActiveLayer(i: number): void {
    const next = Math.max(0, Math.min(i, this.floorCount() - 1));
    if (this.activeLayer === next) return;
    this.activeLayer = next;
    this.visibilityDirty = true;
    this.pedestalBatchDirty = true;
    this.boardLayerDirty = true;
    this.requestRender();
  }

  /**
   * Fade tokens/edges by how many floors they sit from the active layer: the
   * active floor stays full, and each floor of separation grows more transparent
   * (geometric falloff, clamped so far layers don't vanish). No-op for
   * single-floor boards (everything stays full brightness).
   */
  private applyActiveDim(): void {
    const multi = this.floorCount() > 1;
    for (const [id, v] of this.nodeViews) {
      const s = doc.board.shapes[id];
      if (!s) continue;
      const shown = !this.isFloorHidden(floorOf(s)) && !v.culled;
      v.container.visible = shown && !isBatchablePedestal(s);
      v.labelContainer.visible = shown;
      if (!shown) continue;
      const dist = multi ? Math.abs(floorOf(s) - this.activeLayer) : 0;
      v.container.alpha = layerFade(dist);
      // labels hold a higher floor so distant nameplates stay legible
      v.labelContainer.alpha = layerFade(dist, 0.3);
    }
    for (const [id, v] of this.edgeViews) {
      const e = doc.board.edges[id];
      if (!e) continue;
      const shown = !this.isEdgeHidden(e);
      v.container.visible = shown;
      if (!shown) continue;
      const dist = multi ? this.edgeLayerDistance(e) : 0;
      v.container.alpha = layerFade(dist);
    }
  }

  /**
   * Floors of separation between an edge and the active layer — the nearest of
   * its touched floors, so an edge that grazes the active floor stays bright and
   * only edges entirely on far floors fade out. A free end rides the edge's own
   * floor; anchored ends ride their shape's floor.
   */
  private edgeLayerDistance(e: Edge): number {
    const fr = e.from ? doc.board.shapes[e.from] : undefined;
    const to = e.to ? doc.board.shapes[e.to] : undefined;
    let best = Infinity;
    if (fr) best = Math.min(best, Math.abs(floorOf(fr) - this.activeLayer));
    if (to) best = Math.min(best, Math.abs(floorOf(to) - this.activeLayer));
    if (e.from === undefined || e.to === undefined)
      best = Math.min(best, Math.abs(floorOf(e) - this.activeLayer));
    return Number.isFinite(best) ? best : 0;
  }

  private makeBadge(): { mesh: PerspectiveMesh; texture: Texture | null; key: string; w: number; h: number } {
    // Starts empty (key ""); the first syncFloorBadges pass rasterizes its real
    // placard texture. verticesX/Y match the nameplate mesh so the warp is smooth.
    const mesh = new PerspectiveMesh({ texture: Texture.WHITE, verticesX: 8, verticesY: 8 });
    mesh.visible = false;
    this.badgeLayer.addChild(mesh);
    return { mesh, texture: null, key: "", w: 0, h: 0 };
  }

  /**
   * One name placard per floor, laid FLAT onto the floor's top-left corner so it
   * reads as if printed on the layer — sheared/foreshortened by the same camera as
   * the grid, not floating in screen space. The active floor's placard is brighter
   * and takes the floor accent; far floors recede via the distance fade.
   */
  private syncFloorBadges(b: GridBounds): void {
    const proj = getActiveProjector();
    const n = this.floorCount();
    const count = n > 1 ? n : 0; // single-floor boards stay clean
    while (this.floorBadges.length < count) this.floorBadges.push(this.makeBadge());
    while (this.floorBadges.length > count) {
      const bd = this.floorBadges.pop();
      bd?.texture?.destroy(true);
      bd?.mesh.destroy();
    }
    // small screen-space inset so the placard sits just inside the far-left corner
    const INSET_PX = 10;
    for (let i = 0; i < count; i++) {
      const bd = this.floorBadges[i];
      if (this.isFloorHidden(i)) {
        bd.mesh.visible = false; // hidden floors show no placard
        continue;
      }
      const name = doc.board.layers?.[i]?.name ?? (i === 0 ? "Ground" : `Layer ${i}`);
      const active = i === this.activeLayer;
      const accent = doc.board.layers?.[i]?.color ?? DEFAULT_FLOOR_COLOR;
      const key = floorLabelKey(name, active, accent);
      if (key !== bd.key) {
        const lbl = createFloorLabelTexture(name, active, accent);
        bd.texture?.destroy(true);
        bd.texture = lbl.texture;
        bd.mesh.texture = lbl.texture;
        bd.w = lbl.w;
        bd.h = lbl.h;
        bd.key = key;
      }
      const elev = floorElevation(i);
      // size the placard in world units so it renders ~native px at the corner,
      // then map that rectangle onto the floor plane: its near edge projects a hair
      // wider than its far edge, so the label foreshortens like a real floor decal.
      const sc = scaleAtBoard(proj, b.minX, b.minY, elev);
      if (sc <= 0) {
        bd.mesh.visible = false;
        continue;
      }
      const inset = INSET_PX / sc;
      const wW = bd.w / sc;
      const hW = bd.h / sc;
      const x0 = b.minX + inset;
      const y0 = b.minY + inset; // board minY is the FAR edge → label top points away
      // four floor-plane corners in texture order: TL, TR, BR, BL
      const tl = projectBoard(proj, x0, y0, elev);
      const tr = projectBoard(proj, x0 + wW, y0, elev);
      const br = projectBoard(proj, x0 + wW, y0 + hW, elev);
      const bl = projectBoard(proj, x0, y0 + hW, elev);
      if (!tl.ok || !tr.ok || !br.ok || !bl.ok) {
        bd.mesh.visible = false;
        continue;
      }
      bd.mesh.visible = true;
      bd.mesh.setCorners(tl.sx, tl.sy, tr.sx, tr.sy, br.sx, br.sy, bl.sx, bl.sy);
      // recede the placard with floor distance, but keep a high floor so far
      // labels stay readable for navigation
      bd.mesh.alpha = layerFade(Math.abs(i - this.activeLayer), 0.45);
    }
  }

  setOverlay(fn: ((g: Graphics) => void) | null): void {
    this.overlayRenderer = fn;
    this.requestRender();
  }

  setOverlayPulseActive(active: boolean): void {
    if (this.overlayPulseActive === active) return;
    this.overlayPulseActive = active;
    this.requestRender();
  }

  requestRender(): void {
    if (!this.ready || this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame((now) => {
      this.renderScheduled = false;
      if (!this.ready) return; // editor was torn down before this frame ran
      const stats = this.renderFrame(now);
      this.perf.add(stats);
      for (const fn of this.perfListeners) fn(stats);
      const animatePulses = this.hasVisibleFlowPulses();
      if (animatePulses) this.requestRender();
    });
  }

  private renderFrame(now: number): RenderFrameStats {
    const phases = createFramePhases();
    const start = performance.now();
    const animatePulses = this.hasVisibleFlowPulses();
    const pulsePhase = animatePulses ? flowPulsePhase(now) : 0;
    timePhase(phases, "syncBoard", () => this.syncBoardBounds());
    const reprojected = timePhase(phases, "reproject", () =>
      this.reprojectStale(pulsePhase, animatePulses),
    );
    timePhase(phases, "visibility", () => {
      if (!this.visibilityDirty) return;
      this.applyActiveDim(); // fade off-floor tokens toward the active layer
      this.visibilityDirty = false;
    });
    const sortedItems = timePhase(phases, "sort", () => {
      if (!this.sortDirty) return 0;
      const count = this.depthSort();
      this.sortDirty = false;
      return count;
    });
    timePhase(phases, "overlay", () => {
      this.overlay.clear();
      if (this.overlayRenderer) this.overlayRenderer(this.overlay);
    });
    timePhase(phases, "pixi", () => this.app.render());
    const batchStats = this.pedestalBatch.getStats();
    const visibleNodes = this.countVisibleNodes();
    const hitTestMs = this.hitTestMsSinceLastFrame;
    this.hitTestMsSinceLastFrame = 0;
    return {
      totalMs: performance.now() - start,
      phases,
      nodeCount: this.nodeViews.size,
      edgeCount: this.edgeViews.size,
      reprojectedNodes: reprojected.nodes,
      reprojectedEdges: reprojected.edges,
      sortedItems,
      visibleNodes,
      culledNodes: Math.max(0, this.nodeViews.size - visibleNodes),
      batchVertices: batchStats.batchVertices,
      batchMeshes: batchStats.batchMeshes,
      batchUploadBytes: batchStats.batchUploadBytes,
      labelCount: this.countVisibleLabels(),
      hitTestMs,
    };
  }

  private countVisibleNodes(): number {
    let count = 0;
    for (const view of this.nodeViews.values()) {
      if (!view.culled) count++;
    }
    return count;
  }

  private countVisibleLabels(): number {
    let count = 0;
    for (const [id, view] of this.nodeViews) {
      const s = doc.board.shapes[id];
      if (!s || !s.text || view.culled || view.labelHidden || !view.textMesh?.visible) continue;
      count++;
    }
    return count;
  }

  /** Reproject any node/edge view whose epoch lags the camera (coalesced per frame). */
  private reprojectStale(pulsePhase: number, animatePulses: boolean): { nodes: number; edges: number } {
    const proj = getActiveProjector();
    const viewport = this.screenSize();
    let nodes = this.syncPedestalBatch(proj);
    let edges = 0;
    for (const [id, view] of this.nodeViews) {
      const s = doc.board.shapes[id];
      if (s && isBatchablePedestal(s)) {
        view.epoch = this.cameraEpoch;
        continue;
      }
      if (view.epoch === this.cameraEpoch) continue;
      if (s) {
        const inViewport = !this.isFloorHidden(floorOf(s)) && isShapeInViewport(s, proj, viewport);
        view.culled = !inViewport;
        view.container.visible = inViewport;
        view.labelContainer.visible = inViewport;
        if (inViewport) reprojectNodeView(view, s, proj);
      }
      view.epoch = this.cameraEpoch;
      nodes++;
    }
    for (const [id, view] of this.edgeViews) {
      const e = doc.board.edges[id];
      const animateEdge = animatePulses && !!e?.directed;
      if (view.epoch === this.cameraEpoch && !animateEdge) continue;
      if (e) {
        const fr = e.from ? doc.board.shapes[e.from] : undefined;
        const to = e.to ? doc.board.shapes[e.to] : undefined;
        reprojectEdgeView(view, e, resolveEdgeGeometry(doc.board.edges, doc.board.shapes, e), proj, pulsePhase, fr, to);
      }
      view.epoch = this.cameraEpoch;
      edges++;
    }
    return { nodes, edges };
  }

  private hasVisibleFlowPulses(): boolean {
    if (this.overlayPulseActive) return true;
    return this.directedEdges.size > 0;
  }

  private syncPedestalBatch(proj: Projector): number {
    if (!this.pedestalBatchDirty && this.pedestalBatchEpoch === this.cameraEpoch) return 0;
    const multi = this.floorCount() > 1;
    const viewport = this.screenSize();
    const indexedBounds = boardViewportBounds(proj, viewport);
    const indexedShapes = indexedBounds ? this.shapeIndex.queryRect(indexedBounds) : Object.values(doc.board.shapes);
    const candidateIds = new Set(indexedShapes.map((shape) => shape.id));
    const nodes: BatchNode[] = [];
    for (const [id, view] of this.nodeViews) {
      const s = doc.board.shapes[id];
      const batched = !!s && isBatchablePedestal(s);
      if (!s || !batched || this.isFloorHidden(floorOf(s))) {
        view.culled = false;
        view.container.visible = !batched;
        continue;
      }
      if (!candidateIds.has(id)) {
        view.culled = true;
        view.container.visible = false;
        view.labelContainer.visible = false;
        continue;
      }
      const inViewport = isShapeInViewport(s, proj, viewport);
      view.culled = !inViewport;
      view.container.visible = false;
      if (!inViewport) {
        view.labelContainer.visible = false;
        continue;
      }
      const dist = multi ? Math.abs(floorOf(s) - this.activeLayer) : 0;
      nodes.push({
        shape: s,
        alpha: layerFade(dist),
        depth: depthAtBoard(proj, s.x + s.w / 2, s.y + s.h / 2, elevationOf(s) + H_PED),
      });
    }
    this.pedestalBatch.update(nodes, proj);
    this.pedestalBatchDirty = false;
    this.pedestalBatchEpoch = this.cameraEpoch;
    return nodes.length;
  }

  /**
   * Painter's order for the perspective scene. Primary key is the stacking
   * `layer` (Send to Back / Bring to Front move a token up/down through layers),
   * so layering is reliable and independent of where a token sits on the board.
   * Within a layer, farther items paint first (true depth); edges sit behind
   * nodes on an exact tie.
   */
  private depthSort(): number {
    const proj = getActiveProjector();
    type Entry = { container: Container; layer: number; depth: number; isEdge: boolean };
    const entries: Entry[] = [];
    if (this.pedestalBatch.visible) {
      entries.push({
        container: this.pedestalBatch.container,
        layer: this.activeLayer,
        depth: Number.POSITIVE_INFINITY,
        isEdge: false,
      });
    }
    for (const [id, view] of this.nodeViews) {
      const s = doc.board.shapes[id];
      if (!s) continue;
      if (view.culled) continue;
      if (isBatchablePedestal(s)) continue;
      entries.push({
        container: view.container,
        layer: layerOf(s),
        depth: depthAtBoard(proj, s.x + s.w / 2, s.y + s.h / 2, elevationOf(s) + H_PED),
        isEdge: false,
      });
    }
    for (const [id, view] of this.edgeViews) {
      const e = doc.board.edges[id];
      if (!e) continue;
      const geo = resolveEdgeGeometry(doc.board.edges, doc.board.shapes, e);
      const depth = Math.min(
        depthAtBoard(proj, geo.p1.x, geo.p1.y, 0),
        depthAtBoard(proj, geo.p2.x, geo.p2.y, 0),
      );
      entries.push({ container: view.container, layer: this.edgeLayer(e), depth, isEdge: true });
    }
    entries.sort((a, b) => {
      if (a.layer !== b.layer) return a.layer - b.layer; // lower layer → behind
      const dd = b.depth - a.depth; // within a layer: farthest first
      if (Math.abs(dd) > 1e-6) return dd;
      return (a.isEdge ? 0 : 1) - (b.isEdge ? 0 : 1); // edges behind nodes on a tie
    });
    syncLayerOrder(this.itemLayer, entries.map((e) => e.container));
    const labels = [];
    for (const [id, view] of this.nodeViews) {
      const s = doc.board.shapes[id];
      if (!s) continue;
      if (view.culled) continue;
      if (!s.text || view.labelHidden || !view.textMesh) continue;
      labels.push({
        container: view.labelContainer,
        layer: layerOf(s),
        depth: depthAtBoard(proj, s.x + s.w / 2, s.y + s.h / 2, elevationOf(s) + H_PED),
      });
    }
    labels.sort((a, b) => {
      if (a.layer !== b.layer) return a.layer - b.layer;
      return b.depth - a.depth;
    });
    syncLayerOrder(this.labelLayer, labels.map((e) => e.container));
    return entries.length + labels.length;
  }

  /** Effective stacking layer of an edge: the lowest of its connected endpoints
   * (a free end counts as the edge's own floor), so an edge tucks behind a token
   * that's been brought forward and rides up only when both ends rise. */
  private edgeLayer(e: Edge): number {
    let lo = Infinity;
    const from = e.from ? doc.board.shapes[e.from] : undefined;
    const to = e.to ? doc.board.shapes[e.to] : undefined;
    if (from) lo = Math.min(lo, layerOf(from));
    if (to) lo = Math.min(lo, layerOf(to));
    // a free end floats on the edge's own floor (defaults to ground)
    if (e.from === undefined || e.to === undefined) lo = Math.min(lo, layerOf(e));
    return Number.isFinite(lo) ? lo : 0;
  }

  // ---- node lifecycle ----
  addNode(id: ID): void {
    const s = doc.board.shapes[id];
    if (!s) return;
    this.markBoardBoundsDirty();
    this.visibilityDirty = true;
    this.sortDirty = true;
    this.pedestalBatchDirty = true;
    const view = createNodeView(s, () => this.requestRender());
    view.epoch = this.cameraEpoch;
    this.nodeViews.set(id, view);
    this.shapeIndex.upsert(s);
    this.itemLayer.addChild(view.container);
    this.labelLayer.addChild(view.labelContainer);
    this.requestRender();
  }

  updateNode(id: ID): void {
    const view = this.nodeViews.get(id);
    const s = doc.board.shapes[id];
    if (!view || !s) return;
    this.markBoardBoundsDirty();
    this.visibilityDirty = true;
    this.sortDirty = true;
    this.pedestalBatchDirty = true;
    updateNodeView(view, s, () => this.requestRender());
    this.shapeIndex.upsert(s);
    view.epoch = this.cameraEpoch;
    const edges = this.nodeEdges.get(id);
    if (edges) for (const eid of edges) this.refreshEdge(eid);
    this.requestRender();
  }

  /** Hide/show just a node's label text while its label is edited in an overlay. */
  setNodeLabelHidden(id: ID, hidden: boolean): void {
    const view = this.nodeViews.get(id);
    if (!view || view.labelHidden === hidden) return;
    view.labelHidden = hidden;
    if (view.textMesh) view.textMesh.visible = !hidden;
    this.requestRender();
  }

  removeNode(id: ID): void {
    const view = this.nodeViews.get(id);
    this.markBoardBoundsDirty();
    this.visibilityDirty = true;
    this.sortDirty = true;
    this.pedestalBatchDirty = true;
    if (view) {
      this.itemLayer.removeChild(view.container);
      this.labelLayer.removeChild(view.labelContainer);
      this.destroyNodeView(view);
      this.nodeViews.delete(id);
    }
    this.shapeIndex.remove(id);
    this.nodeEdges.delete(id);
    this.requestRender();
  }

  /** Re-sort paint order. Under perspective this is depth-driven, not z-stack. */
  reorder(): void {
    this.sortDirty = true;
    this.requestRender();
  }

  // ---- edge lifecycle ----
  addEdge(id: ID): void {
    const e = doc.board.edges[id];
    if (!e) return;
    this.visibilityDirty = true;
    this.sortDirty = true;
    if (e.directed) this.directedEdges.add(id);
    const view = createEdgeView(e.from, e.to);
    this.edgeViews.set(id, view);
    this.itemLayer.addChild(view.container);
    this.registerAdj(id, e.from, e.to);
    this.refreshEdge(id);
    for (const sid of this.pairEdges(e.from, e.to)) if (sid !== id) this.refreshEdge(sid);
    this.requestRender();
  }

  updateEdge(id: ID): void {
    const e = doc.board.edges[id];
    if (!e) return;
    this.visibilityDirty = true;
    this.sortDirty = true;
    if (e.directed) this.directedEdges.add(id);
    else this.directedEdges.delete(id);
    this.refreshEdge(id);
    this.requestRender();
  }

  removeEdge(id: ID): void {
    const view = this.edgeViews.get(id);
    this.visibilityDirty = true;
    this.sortDirty = true;
    this.directedEdges.delete(id);
    const from = view?.from;
    const to = view?.to;
    if (view) {
      this.itemLayer.removeChild(view.container);
      view.container.destroy({ children: true });
      this.edgeViews.delete(id);
    }
    for (const set of this.nodeEdges.values()) set.delete(id);
    if (from && to) for (const sid of this.pairEdges(from, to)) this.refreshEdge(sid);
    this.requestRender();
  }

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
    const fr = e.from ? doc.board.shapes[e.from] : undefined;
    const to = e.to ? doc.board.shapes[e.to] : undefined;
    updateEdgeView(view, e, resolveEdgeGeometry(doc.board.edges, doc.board.shapes, e), 0, fr, to);
    view.epoch = this.cameraEpoch;
  }

  // ---- bulk ----
  rebuild(): void {
    this.clear();
    this.markBoardBoundsDirty();
    this.visibilityDirty = true;
    this.sortDirty = true;
    this.pedestalBatchDirty = true;
    for (const id of doc.board.order) {
      if (doc.board.shapes[id]) this.addNode(id);
      else if (doc.board.edges[id]) this.addEdge(id);
    }
    for (const id of Object.keys(doc.board.shapes))
      if (!this.nodeViews.has(id)) this.addNode(id);
    for (const id of Object.keys(doc.board.edges))
      if (!this.edgeViews.has(id)) this.addEdge(id);
    this.requestRender();
  }

  private clear(): void {
    for (const v of this.nodeViews.values()) this.destroyNodeView(v);
    for (const v of this.edgeViews.values()) v.container.destroy({ children: true });
    this.nodeViews.clear();
    this.edgeViews.clear();
    this.nodeEdges.clear();
    this.directedEdges.clear();
    this.shapeIndex.clear();
    this.pedestalBatch.clear();
    this.pedestalBatchEpoch = -1;
    this.pedestalBatchDirty = true;
    this.lastBoardBounds = null;
    this.boardBoundsCache = null;
    this.boardBoundsDirty = true;
    this.boardLayerDirty = true;
    this.visibilityDirty = true;
    this.sortDirty = true;
    this.itemLayer.removeChildren();
    this.itemLayer.addChild(this.pedestalBatch.container);
    this.labelLayer.removeChildren();
  }

  private destroyNodeView(view: NodeView): void {
    view.container.destroy({ children: true });
    view.labelContainer.destroy({ children: true });
    view.textTexture?.destroy(true);
  }

  // ---- hit testing (SCREEN space, elevation-aware) ----
  // Tokens are drawn lifted off the board by their floor's elevation, so a ground
  // footprint no longer sits under the visible token. We instead test the screen
  // point against each token's projected TOP face (at its floor elevation), and
  // edges against their projected path. The frontmost candidate wins — same key
  // the painter uses: higher layer first, then nearer depth, then node-over-edge.
  private isMoreFront(
    a: { layer: number; depth: number; isEdge: boolean },
    b: { layer: number; depth: number; isEdge: boolean },
  ): boolean {
    if (a.layer !== b.layer) return a.layer > b.layer;
    if (Math.abs(a.depth - b.depth) > 1e-6) return a.depth < b.depth; // nearer wins
    return !a.isEdge && b.isEdge; // node beats edge on a tie
  }

  /** Screen polygon of a shape's clickable top face, projected at its floor elevation. */
  private shapeTopPoly(s: Shape, proj: Projector): Pt[] {
    const top = s.kind === "text" ? elevationOf(s) : elevationOf(s) + H_PED;
    const out: Pt[] = [];
    if (s.kind === "circle" || s.kind === "icon") {
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      const r = Math.min(s.w, s.h) / 2;
      const N = 20;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        const p = projectBoard(proj, cx + Math.cos(a) * r, cy + Math.sin(a) * r, top);
        if (!p.ok) return [];
        out.push({ x: p.sx, y: p.sy });
      }
      return out;
    }
    const corners: Array<[number, number]> = [
      [s.x, s.y],
      [s.x + s.w, s.y],
      [s.x + s.w, s.y + s.h],
      [s.x, s.y + s.h],
    ];
    for (const [x, y] of corners) {
      const p = projectBoard(proj, x, y, top);
      if (!p.ok) return [];
      out.push({ x: p.sx, y: p.sy });
    }
    return out;
  }

  /** Does screen point `sp` fall inside the shape's projected (elevated) top face? */
  private shapeHit(s: Shape, sp: Pt, proj: Projector): boolean {
    const poly = this.shapeTopPoly(s, proj);
    if (poly.length < 3) return false;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x;
      const yi = poly[i].y;
      const xj = poly[j].x;
      const yj = poly[j].y;
      if (yi > sp.y !== yj > sp.y && sp.x < ((xj - xi) * (sp.y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  private shapeCandidatesAtScreenPoint(sp: Pt, proj: Projector, tolPx: number): Shape[] {
    const heights = [0, H_PED];
    const seen = new Set<ID>();
    const candidates: Shape[] = [];
    for (const h of heights) {
      const p = unprojectBoardAt(proj, sp.x, sp.y, h);
      if (!p) continue;
      const scale = Math.max(0.05, scaleAtBoard(proj, p.wx, p.wy, h));
      const radius = Math.max(256, tolPx / scale + 256);
      for (const shape of this.shapeIndex.queryPoint(p.wx, p.wy, radius)) {
        if (seen.has(shape.id)) continue;
        seen.add(shape.id);
        candidates.push(shape);
      }
    }
    return candidates.length ? candidates : this.shapeIndex.all();
  }

  private shapeCandidatesInScreenRect(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    proj: Projector,
  ): Shape[] {
    const rx0 = Math.min(x0, x1);
    const ry0 = Math.min(y0, y1);
    const rx1 = Math.max(x0, x1);
    const ry1 = Math.max(y0, y1);
    const heights = [0, H_PED];
    const points: Array<{ wx: number; wy: number }> = [];
    for (const h of heights) {
      for (const [sx, sy] of [
        [rx0, ry0],
        [rx1, ry0],
        [rx1, ry1],
        [rx0, ry1],
      ] as Array<[number, number]>) {
        const p = unprojectBoardAt(proj, sx, sy, h);
        if (p) points.push(p);
      }
    }
    if (points.length < 4) return this.shapeIndex.all();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.wx);
      minY = Math.min(minY, p.wy);
      maxX = Math.max(maxX, p.wx);
      maxY = Math.max(maxY, p.wy);
    }
    return this.shapeIndex.queryRect({ minX, minY, maxX, maxY });
  }

  hitTestShape(sp: Pt, activeOnly = false): ID | null {
    const start = performance.now();
    try {
      const proj = getActiveProjector();
      let bestId: ID | null = null;
      let best: { layer: number; depth: number; isEdge: boolean } | null = null;
      for (const s of this.shapeCandidatesAtScreenPoint(sp, proj, 8)) {
        if (this.isFloorHidden(floorOf(s))) continue;
        if (activeOnly && floorOf(s) !== this.activeLayer) continue;
        if (!this.shapeHit(s, sp, proj)) continue;
        const cand = { layer: layerOf(s), depth: depthAtBoard(proj, s.x + s.w / 2, s.y + s.h / 2, elevationOf(s) + H_PED), isEdge: false };
        if (!best || this.isMoreFront(cand, best)) {
          best = cand;
          bestId = s.id;
        }
      }
      return bestId;
    } finally {
      this.hitTestMsSinceLastFrame += performance.now() - start;
    }
  }

  /** Min screen-px distance from `sp` to an edge's projected path (at its draw height). */
  private edgeScreenDist(e: Edge, sp: Pt, proj: Projector): number {
    const geo = resolveEdgeGeometry(doc.board.edges, doc.board.shapes, e);
    const from = e.from ? doc.board.shapes[e.from] : undefined;
    const to = e.to ? doc.board.shapes[e.to] : undefined;
    // Match reprojectEdgeView exactly: each end rides its node's floor, a free
    // end rides the edge's own floor, and the path interpolates between them.
    const free = floorElevation(e.layer ?? 0);
    const hFrom = (from ? elevationOf(from) : free) + H_ARROW;
    const hTo = (to ? elevationOf(to) : free) + H_ARROW;
    const wpts = geo.ctrl ? quadPoints(geo.p1, geo.ctrl, geo.p2, 14) : [geo.p1, geo.p2];
    const last = wpts.length - 1;
    const spts: Pt[] = [];
    for (let i = 0; i < wpts.length; i++) {
      const t = last > 0 ? i / last : 0;
      const p = projectBoard(proj, wpts[i].x, wpts[i].y, hFrom + (hTo - hFrom) * t);
      if (p.ok) spts.push({ x: p.sx, y: p.sy });
    }
    let best = Infinity;
    for (let i = 0; i < spts.length - 1; i++) {
      const d = distToSegment(sp, spts[i], spts[i + 1]);
      if (d < best) best = d;
    }
    return best;
  }

  /** Frontmost selectable target under SCREEN point `sp`, honoring the layer/depth paint order. */
  hitTestTop(sp: Pt, tolPx: number, activeOnly = false): { kind: "shape" | "edge"; id: ID } | null {
    const start = performance.now();
    try {
      const proj = getActiveProjector();
      let result: { kind: "shape" | "edge"; id: ID } | null = null;
      let best: { layer: number; depth: number; isEdge: boolean } | null = null;
      for (const s of this.shapeCandidatesAtScreenPoint(sp, proj, tolPx)) {
        if (this.isFloorHidden(floorOf(s))) continue;
        if (activeOnly && floorOf(s) !== this.activeLayer) continue;
        if (!this.shapeHit(s, sp, proj)) continue;
        const cand = { layer: layerOf(s), depth: depthAtBoard(proj, s.x + s.w / 2, s.y + s.h / 2, elevationOf(s) + H_PED), isEdge: false };
        if (!best || this.isMoreFront(cand, best)) {
          best = cand;
          result = { kind: "shape", id: s.id };
        }
      }
      for (const e of Object.values(doc.board.edges)) {
        if (this.isEdgeHidden(e)) continue;
        if (this.edgeScreenDist(e, sp, proj) > tolPx) continue;
        const geo = resolveEdgeGeometry(doc.board.edges, doc.board.shapes, e);
        const depth = Math.min(
          depthAtBoard(proj, geo.p1.x, geo.p1.y, 0),
          depthAtBoard(proj, geo.p2.x, geo.p2.y, 0),
        );
        const cand = { layer: this.edgeLayer(e), depth, isEdge: true };
        if (!best || this.isMoreFront(cand, best)) {
          best = cand;
          result = { kind: "edge", id: e.id };
        }
      }
      return result;
    } finally {
      this.hitTestMsSinceLastFrame += performance.now() - start;
    }
  }

  /** Shapes whose projected token center falls inside a SCREEN-space marquee rect. */
  shapesInScreenRect(x0: number, y0: number, x1: number, y1: number, activeOnly = false): ID[] {
    const start = performance.now();
    try {
      const rx0 = Math.min(x0, x1);
      const ry0 = Math.min(y0, y1);
      const rx1 = Math.max(x0, x1);
      const ry1 = Math.max(y0, y1);
      const proj = getActiveProjector();
      const out: ID[] = [];
      for (const s of this.shapeCandidatesInScreenRect(x0, y0, x1, y1, proj)) {
        if (this.isFloorHidden(floorOf(s))) continue;
        if (activeOnly && floorOf(s) !== this.activeLayer) continue;
        const c = projectBoard(proj, s.x + s.w / 2, s.y + s.h / 2, elevationOf(s) + H_PED);
        if (c.ok && c.sx >= rx0 && c.sx <= rx1 && c.sy >= ry0 && c.sy <= ry1) out.push(s.id);
      }
      return out;
    } finally {
      this.hitTestMsSinceLastFrame += performance.now() - start;
    }
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
      ctx.fillStyle = "#06090f";
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
    // placard meshes live under boardLayer and are destroyed with the app; free
    // their canvas textures and drop refs so a fresh init() can't reuse dead nodes.
    for (const bd of this.floorBadges) bd.texture?.destroy(true);
    this.floorBadges = [];
    this.activeLayer = 0;
    this.itemLayer.removeChild(this.pedestalBatch.container);
    this.pedestalBatch.destroy();
    this.app.destroy(true, { children: true });
  }
}

export const scene = new Scene();
