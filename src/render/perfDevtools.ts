import { scene } from "./scene";
import type { RenderFrameStats, RenderPerfSummary } from "./perfStats";

interface SketchLabPerfApi {
  summary(): RenderPerfSummary;
  reset(): void;
  sample(frameCount?: number): Promise<RenderPerfSummary>;
  onFrame(fn: (stats: RenderFrameStats) => void): () => void;
}

declare global {
  interface Window {
    __sketchLabPerf?: SketchLabPerfApi;
  }
}

export function installRenderPerfDevtools(): void {
  if (typeof window === "undefined") return;
  window.__sketchLabPerf = {
    summary: () => scene.getPerformanceSummary(),
    reset: () => scene.resetPerformanceStats(),
    sample: (frameCount = 60) =>
      new Promise((resolve) => {
        scene.resetPerformanceStats();
        let seen = 0;
        const off = scene.onPerformanceFrame(() => {
          seen++;
          if (seen < frameCount) {
            scene.requestRender();
            return;
          }
          off();
          resolve(scene.getPerformanceSummary());
        });
        scene.requestRender();
      }),
    onFrame: (fn) => scene.onPerformanceFrame(fn),
  };
}
