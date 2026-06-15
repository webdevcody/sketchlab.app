import {
  Container,
  Graphics,
  ImageSource,
  Sprite,
  Text,
  type TextStyleOptions,
  Texture,
} from "pixi.js";
import type { Shape } from "../state/types";
import { hexToNumber, readableText } from "./geometry";
import { drawIcon } from "./icons";
import { TEXT_FONT_SIZE, TEXT_PAD } from "./measure";

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export interface NodeView {
  container: Container;
  gfx: Graphics;
  text: Text | null;
  sprite: Sprite | null;
  styleKey: string;
  textKey: string;
  srcKey: string;
}

function styleKeyOf(s: Shape): string {
  return `${s.kind}|${s.w}|${s.h}|${s.fill}|${s.stroke}|${s.icon ?? ""}|${s.src ?? ""}`;
}
function textKeyOf(s: Shape): string {
  return `${s.kind}|${s.text}|${s.w}|${s.fill}|${s.fontSize ?? ""}`;
}

function textStyle(s: Shape): TextStyleOptions {
  if (s.kind === "text") {
    const fontSize = s.fontSize ?? TEXT_FONT_SIZE;
    return {
      fontFamily: FONT,
      fontSize,
      fontWeight: "600",
      fill: hexToNumber(s.fill),
      align: "left",
      lineHeight: fontSize * 1.3,
    };
  }
  return {
    fontFamily: FONT,
    fontSize: 16,
    fontWeight: "500",
    fill: readableText(s.fill),
    align: "center",
    wordWrap: true,
    wordWrapWidth: Math.max(24, s.w - 16),
    lineHeight: 20,
  };
}

export function createNodeView(s: Shape, onReady?: () => void): NodeView {
  const container = new Container();
  const gfx = new Graphics();
  container.addChild(gfx);
  const view: NodeView = {
    container,
    gfx,
    text: null,
    sprite: null,
    styleKey: "",
    textKey: "",
    srcKey: "",
  };
  updateNodeView(view, s, onReady);
  return view;
}

export function updateNodeView(view: NodeView, s: Shape, onReady?: () => void): void {
  view.container.position.set(s.x, s.y);
  const sk = styleKeyOf(s);
  if (sk !== view.styleKey) {
    view.styleKey = sk;
    drawShape(view.gfx, s);
    syncImage(view, s, onReady);
  }
  const tk = textKeyOf(s);
  if (tk !== view.textKey) {
    view.textKey = tk;
    syncText(view, s);
  }
}

function drawShape(g: Graphics, s: Shape): void {
  g.clear();
  const fill = hexToNumber(s.fill);
  const stroke = hexToNumber(s.stroke);
  if (s.kind === "rect") {
    g.roundRect(0, 0, s.w, s.h, Math.min(10, Math.min(s.w, s.h) * 0.12));
    g.fill(fill);
    g.stroke({ width: 2, color: stroke, alignment: 0.5 });
  } else if (s.kind === "circle") {
    g.ellipse(s.w / 2, s.h / 2, s.w / 2, s.h / 2);
    g.fill(fill);
    g.stroke({ width: 2, color: stroke, alignment: 0.5 });
  } else if (s.kind === "image") {
    // the Sprite supplies the pixels; gfx just draws the outline on top
    g.roundRect(0, 0, s.w, s.h, 4);
    g.stroke({ width: 2, color: stroke, alignment: 1 });
  } else if (s.kind === "text") {
    // text objects have no box; the Text child is the whole object
  } else {
    const size = Math.min(s.w, s.h) * 0.78;
    const ox = (s.w - size) / 2;
    const oy = (s.h - size) / 2;
    drawIcon(g, s.icon ?? "", ox, oy, size, stroke);
  }
}

function syncImage(view: NodeView, s: Shape, onReady?: () => void): void {
  if (s.kind !== "image") {
    if (view.sprite) {
      view.container.removeChild(view.sprite);
      view.sprite.destroy();
      view.sprite = null;
      view.srcKey = "";
    }
    return;
  }
  if (!view.sprite) {
    view.sprite = new Sprite();
    view.container.addChildAt(view.sprite, 0); // behind the outline
  }
  const sprite = view.sprite;
  if (view.srcKey !== (s.src ?? "")) {
    view.srcKey = s.src ?? "";
    if (s.src) {
      const w = s.w;
      const h = s.h;
      const img = new Image();
      img.onload = () => {
        sprite.texture = new Texture({ source: new ImageSource({ resource: img }) });
        sizeSprite(sprite, w, h);
        onReady?.();
      };
      img.src = s.src;
    }
  }
  sizeSprite(sprite, s.w, s.h);
}

/** Set a sprite's box size, but only once its texture has real dimensions. */
function sizeSprite(sprite: Sprite, w: number, h: number): void {
  if ((sprite.texture?.width ?? 0) > 0) {
    sprite.width = w;
    sprite.height = h;
  }
}

function syncText(view: NodeView, s: Shape): void {
  if (!s.text) {
    if (view.text) {
      view.container.removeChild(view.text);
      view.text.destroy();
      view.text = null;
    }
    return;
  }
  if (!view.text) {
    view.text = new Text({ text: s.text, style: textStyle(s), resolution: 2 });
    view.container.addChild(view.text);
  } else {
    view.text.text = s.text;
    view.text.style = textStyle(s);
  }
  if (s.kind === "text") {
    view.text.anchor.set(0);
    view.text.position.set(TEXT_PAD, TEXT_PAD);
  } else {
    view.text.anchor.set(0.5);
    view.text.position.set(s.w / 2, s.h / 2);
  }
}
