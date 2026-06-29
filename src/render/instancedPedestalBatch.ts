import { Container } from "pixi.js";
import type { Shape } from "../state/types";
import { hexToNumber } from "./geometry";
import type { Projector } from "./projection";
import { elevationOf, H_PED, shade, tint } from "./shading";

export interface InstancedPedestalNode {
  shape: Shape;
  alpha: number;
}

export interface InstancedPedestalStats {
  instances: number;
  drawCalls: number;
  instanceBytes: number;
  cameraOnlyFrame: boolean;
}

export interface InstancedCameraUniforms {
  focusX: number;
  focusY: number;
  distance: number;
  pitch: number;
  yaw: number;
  focal: number;
  screenW: number;
  screenH: number;
  screenCX: number;
  screenCY: number;
}

const FLOATS_PER_INSTANCE = 16;

export const INSTANCED_PEDESTAL_GL_VERTEX = `
attribute vec2 aVertex;
attribute vec4 aBounds;
attribute vec4 aColors0;
attribute vec4 aColors1;
attribute vec4 aMeta;

uniform mat3 uTransformMatrix;
uniform vec4 uCamera0; // focusX, focusY, distance, pitch
uniform vec4 uCamera1; // yaw, focal, screenCX, screenCY

varying vec4 vColor;

vec2 projectBoardPoint(vec2 board, float height) {
  float focusX = uCamera0.x;
  float focusY = uCamera0.y;
  float distance = uCamera0.z;
  float pitch = uCamera0.w;
  float yaw = uCamera1.x;
  float focal = uCamera1.y;
  float cx = uCamera1.z;
  float cy = uCamera1.w;
  float sinP = sin(pitch);
  float cosP = cos(pitch);
  float cosY = cos(yaw);
  float sinY = sin(yaw);
  float u = board.x - focusX;
  float v = -board.y - focusY;
  float ur = u * cosY - v * sinY;
  float vr = u * sinY + v * cosY;
  float ye = vr * sinP + height * cosP;
  float depth = max(0.0001, distance + vr * cosP - height * sinP);
  float scale = focal / depth;
  return vec2(cx + ur * scale, cy - ye * scale);
}

void main(void) {
  vec2 center = aBounds.xy;
  vec2 halfSize = aBounds.zw * 0.5;
  float top = aMeta.x;
  vec2 board = center + aVertex * halfSize;
  vec2 screen = projectBoardPoint(board, top);
  gl_Position = vec4((uTransformMatrix * vec3(screen, 1.0)).xy, 0.0, 1.0);
  vColor = mix(aColors0, aColors1, aMeta.y);
}
`;

export const INSTANCED_PEDESTAL_GL_FRAGMENT = `
precision mediump float;
varying vec4 vColor;

void main(void) {
  gl_FragColor = vColor;
}
`;

function colorFloats(color: number, alpha: number): [number, number, number, number] {
  return [
    ((color >> 16) & 0xff) / 255,
    ((color >> 8) & 0xff) / 255,
    (color & 0xff) / 255,
    alpha,
  ];
}

export function instancedCameraUniforms(proj: Projector): InstancedCameraUniforms {
  return {
    focusX: proj.cam.focusX,
    focusY: proj.cam.focusY,
    distance: proj.cam.distance,
    pitch: proj.cam.pitch,
    yaw: proj.cam.yaw,
    focal: proj.focal,
    screenW: proj.screen.w,
    screenH: proj.screen.h,
    screenCX: proj.screen.cx,
    screenCY: proj.screen.cy,
  };
}

export class InstancedPedestalBatch {
  readonly container = new Container();
  private instanceData = new Float32Array(0);
  private stats: InstancedPedestalStats = {
    instances: 0,
    drawCalls: 0,
    instanceBytes: 0,
    cameraOnlyFrame: false,
  };
  private lastShapeEpoch = -1;

  getStats(): InstancedPedestalStats {
    return this.stats;
  }

  update(nodes: InstancedPedestalNode[], proj: Projector, shapeEpoch: number): void {
    const cameraOnlyFrame = this.lastShapeEpoch === shapeEpoch && this.instanceData.length >= nodes.length * FLOATS_PER_INSTANCE;
    if (!cameraOnlyFrame) {
      this.ensureCapacity(nodes.length * FLOATS_PER_INSTANCE);
      let offset = 0;
      for (const node of nodes) {
        offset = this.writeInstance(offset, node);
      }
      this.lastShapeEpoch = shapeEpoch;
    }
    instancedCameraUniforms(proj);
    this.stats = {
      instances: nodes.length,
      drawCalls: nodes.length ? 1 : 0,
      instanceBytes: nodes.length * FLOATS_PER_INSTANCE * Float32Array.BYTES_PER_ELEMENT,
      cameraOnlyFrame,
    };
  }

  private ensureCapacity(length: number): void {
    if (this.instanceData.length >= length) return;
    this.instanceData = new Float32Array(length);
  }

  private writeInstance(offset: number, node: InstancedPedestalNode): number {
    const { shape, alpha } = node;
    const cx = shape.x + shape.w / 2;
    const cy = shape.y + shape.h / 2;
    const top = elevationOf(shape) + H_PED;
    const fill = hexToNumber(shape.fill);
    const side = shade(shape.fill, 0.32);
    const face = tint(shape.fill, 0.16);
    const fillColor = colorFloats(fill, alpha);
    const sideColor = colorFloats(side, alpha);
    const faceColor = colorFloats(face, alpha);
    this.instanceData.set(
      [
        cx,
        cy,
        shape.w,
        shape.h,
        fillColor[0],
        fillColor[1],
        fillColor[2],
        fillColor[3],
        sideColor[0],
        sideColor[1],
        sideColor[2],
        sideColor[3],
        top,
        shape.kind === "circle" ? 1 : 0,
        faceColor[0],
        faceColor[3],
      ],
      offset,
    );
    return offset + FLOATS_PER_INSTANCE;
  }
}
