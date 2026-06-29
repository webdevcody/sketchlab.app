export type RenderPhase =
  | "syncBoard"
  | "reproject"
  | "visibility"
  | "sort"
  | "overlay"
  | "pixi";

export type RenderPhaseDurations = Record<RenderPhase, number>;

export interface RenderFrameStats {
  totalMs: number;
  phases: RenderPhaseDurations;
  nodeCount: number;
  edgeCount: number;
  reprojectedNodes: number;
  reprojectedEdges: number;
  sortedItems: number;
  visibleNodes?: number;
  culledNodes?: number;
  batchVertices?: number;
  batchMeshes?: number;
  batchUploadBytes?: number;
  labelCount?: number;
  hitTestMs?: number;
}

export interface RenderPerfSummary {
  frames: number;
  avgMs: number;
  maxMs: number;
  estimatedFps: number;
  avgPhases: RenderPhaseDurations;
  last: RenderFrameStats | null;
}

const PHASES: RenderPhase[] = ["syncBoard", "reproject", "visibility", "sort", "overlay", "pixi"];

function emptyPhases(): RenderPhaseDurations {
  return {
    syncBoard: 0,
    reproject: 0,
    visibility: 0,
    sort: 0,
    overlay: 0,
    pixi: 0,
  };
}

export function estimatedFps(avgFrameMs: number): number {
  return avgFrameMs > 0 ? Math.min(60, 1000 / avgFrameMs) : 60;
}

export class RenderPerfRecorder {
  private frames: RenderFrameStats[] = [];

  constructor(private readonly maxFrames = 240) {}

  add(frame: RenderFrameStats): void {
    this.frames.push(frame);
    if (this.frames.length > this.maxFrames) this.frames.shift();
  }

  reset(): void {
    this.frames = [];
  }

  summary(): RenderPerfSummary {
    if (!this.frames.length) {
      return {
        frames: 0,
        avgMs: 0,
        maxMs: 0,
        estimatedFps: 60,
        avgPhases: emptyPhases(),
        last: null,
      };
    }

    const totals = emptyPhases();
    let totalMs = 0;
    let maxMs = 0;
    for (const frame of this.frames) {
      totalMs += frame.totalMs;
      maxMs = Math.max(maxMs, frame.totalMs);
      for (const phase of PHASES) totals[phase] += frame.phases[phase];
    }

    const avgMs = totalMs / this.frames.length;
    const avgPhases = emptyPhases();
    for (const phase of PHASES) avgPhases[phase] = totals[phase] / this.frames.length;

    return {
      frames: this.frames.length,
      avgMs,
      maxMs,
      estimatedFps: estimatedFps(avgMs),
      avgPhases,
      last: this.frames[this.frames.length - 1] ?? null,
    };
  }
}

export function timePhase<T>(
  phases: RenderPhaseDurations,
  phase: RenderPhase,
  fn: () => T,
  now: () => number = () => performance.now(),
): T {
  const start = now();
  try {
    return fn();
  } finally {
    phases[phase] += now() - start;
  }
}

export function createFramePhases(): RenderPhaseDurations {
  return emptyPhases();
}
