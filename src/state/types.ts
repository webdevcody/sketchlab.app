export type ID = string;

export type ShapeKind = "rect" | "circle" | "icon" | "image" | "text" | "code";

export type Silhouette = "circle" | "square";

export interface Shape {
  id: ID;
  kind: ShapeKind;
  /** world-space top-left */
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  /** label for most kinds; for kind === "code" this is the source snippet */
  text: string;
  /** only for kind === "icon": registry key of the icon to draw */
  icon?: string;
  /** only for kind === "image": the image data URL (embedded so it persists & shares) */
  src?: string;
  /** label/text font size in world units; scales with the object on resize (defaults per kind) */
  fontSize?: number;
  /**
   * Pedestal footprint, chosen by the user after the shape was placed. Absent
   * until they pick one, in which case the footprint falls back to the kind
   * default — so boards and share links predating this field are unaffected.
   */
  silhouette?: Silhouette;
  /**
   * Named floor this shape sits on (0-based index into `Board.layers`). Each
   * distinct value draws as its own glowing board plane. Elevation base is
   * `layer * FLOOR_STEP`. Defaults to 0 (ground). Use "Move to …" / the layers
   * panel to change floors — Bring/Send Front/Back nudge `lift` instead.
   */
  layer?: number;
  /**
   * Small within-floor height nudge (world-up units) for paint/hit order among
   * overlapping tokens on the same floor. Bring Forward / Send Backward step
   * this by a few units so a covered shape becomes clickable without jumping
   * to another named floor. Defaults to 0.
   */
  lift?: number;
}

/** A named, rendered floor in the 3D stack. Index in Board.layers === Shape.layer. */
export interface LayerDef {
  id: ID;
  name: string;
  /** optional accent used for this floor's frame + pill (defaults to cyan) */
  color?: string;
  /** when true, the floor (its frame, tokens, edges & badge) is not drawn or hit-tested */
  hidden?: boolean;
}

export interface Edge {
  id: ID;
  /** source shape id; undefined when this end floats free at (x1,y1) */
  from?: ID;
  /** target shape id; undefined when this end floats free at (x2,y2) */
  to?: ID;
  /** world-space position of a free `from` end (used when `from` is undefined) */
  x1?: number;
  y1?: number;
  /** world-space position of a free `to` end (used when `to` is undefined) */
  x2?: number;
  y2?: number;
  /** stroke / arrow color; omitted on older boards → navy default at render time */
  fill?: string;
  label: string;
  /** edge label font size in world units; follows the same S/M/L presets as shapes */
  fontSize?: number;
  /** when true, draw an arrowhead at the `to` end (directed edge) */
  directed?: boolean;
  /**
   * Optional world-space control point. When set, the line bends through it
   * (quadratic) and endpoints snap toward the control point. When undefined the
   * line is straight and snaps to the centers' boundary intersection.
   */
  cx?: number;
  cy?: number;
  /**
   * Floor this edge floats on while it has a free (unanchored) end — mirrors
   * `Shape.layer` and is the 0-based index into `Board.layers`. A free end lifts
   * to this floor's elevation instead of dropping to the ground, so an arrow
   * drawn on the active floor stays on it. Anchored ends ignore this and ride
   * their shape's floor. Defaults to 0 (ground).
   */
  layer?: number;
}

export interface Board {
  id: ID;
  name: string;
  shapes: Record<ID, Shape>;
  edges: Record<ID, Edge>;
  /** unified paint order (bottom -> top) of shape AND edge ids */
  order: ID[];
  /** Ordered named floors (bottom→top). Optional for back-compat; index === Shape.layer. */
  layers?: LayerDef[];
  createdAt: number;
  updatedAt: number;
}

export interface BoardMeta {
  id: ID;
  name: string;
  updatedAt: number;
  shapeCount: number;
  thumbnail?: string;
}

export type ToolName =
  | "select"
  | "text"
  | "code"
  | "rect"
  | "circle"
  | "line"
  | "arrow"
  | "hand";

export interface Camera {
  /** ground point (board coords) under the screen center — PAN moves this */
  focusX: number;
  focusY: number;
  /** focal multiplier; clamped MIN_ZOOM..MAX_ZOOM (same hand-feel as old zoom) */
  zoom: number;
  /** optical-axis angle below horizontal, radians. π/2 = top-down; default π/3 */
  pitch: number;
  /** eye-to-focus distance in world units; default 1200 */
  distance: number;
  /**
   * Screen-space offset (px) of the principal point from the viewport center.
   * Zoom leaves this unchanged so magnification is independent of cursor location.
   * Default 0.
   */
  panX: number;
  panY: number;
  /**
   * Turntable yaw: rotation (radians) of the board around the vertical axis
   * through the focus/center origin. Spins the board within its own ground
   * plane — it stays flat and level (pitch is unchanged). Default 0.
   */
  yaw: number;
}

export interface SelectionState {
  shapes: Set<ID>;
  edges: Set<ID>;
}
