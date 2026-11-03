/**
 * Deterministic Canvas 2D renderer for a MotionSpec. renderFrame(ctx, spec,
 * t) paints exactly one frame for time t (seconds) at whatever resolution the
 * canvas has: positions are normalized, font sizes are fractions of the frame
 * height, and every animation is a pure function of t. No DOM access beyond
 * the 2D context, so it can draw into a preview canvas, an export canvas or a
 * recording mock in tests.
 */

import { clamp, clamp01, ease, lerp, stagger, wave } from "./easing";
import {
  iconStrokes,
  partialStrokes,
  penPosition,
  type Polyline,
} from "./icons";
import type {
  ArrowElement,
  BackgroundKind,
  ChartElement,
  CounterElement,
  FigureElement,
  FontId,
  IconElement,
  ListElement,
  LowerThirdElement,
  MotionElement,
  MotionScene,
  MotionSpec,
  MotionTheme,
  ShapeElement,
  TextElement,
} from "./spec";
import {
  counterValue,
  elementState,
  formatNumber,
  locate,
  transitionEase,
  typewriterCount,
  type ElementState,
} from "./timeline";

type Ctx = CanvasRenderingContext2D;

export interface VideoLike {
  videoWidth: number;
  videoHeight: number;
}

export interface RenderAssets {
  /** Background clip for "video" backgrounds (lower thirds). */
  video?: (CanvasImageSource & VideoLike) | null;
}

export const FONT_STACKS: Record<FontId, string> = {
  sans: '"Inter", "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif',
  display:
    '"Avenir Next", "Futura", "Montserrat", "Segoe UI", system-ui, sans-serif',
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  hand: '"Marker Felt", "Chalkboard SE", "Segoe Print", "Comic Sans MS", cursive',
};

// Color helpers

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h, 16);
  if (!Number.isFinite(n) || h.length !== 6) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${clamp01(a)})`;
}

/** Relative luminance 0..1 (sRGB approximation). */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Rich text (*accent* runs) + wrapping

export interface Word {
  text: string;
  accent: boolean;
}

/** Split text into lines of words; `*...*` marks accent words. */
export function parseRich(text: string): Word[][] {
  return text.split("\n").map((line) => {
    const words: Word[] = [];
    let accent = false;
    for (const raw of line.split(/\s+/).filter(Boolean)) {
      let w = raw;
      let startAccent: boolean = accent;
      let endAccent = false;
      if (w.startsWith("*")) {
        startAccent = true;
        w = w.slice(1);
      }
      if (w.endsWith("*")) {
        endAccent = true;
        w = w.slice(0, -1);
      }
      if (w.includes("*")) w = w.replace(/\*/g, "");
      if (w) words.push({ text: w, accent: startAccent });
      accent = startAccent && !endAccent;
    }
    return words;
  });
}

export interface LaidWord extends Word {
  x: number;
  width: number;
  line: number;
  index: number;
}

export interface TextLayout {
  words: LaidWord[];
  lineWidths: number[];
  lineHeight: number;
  height: number;
  width: number;
}

/** Greedy wrap at maxWidth px; x is relative to each line's left edge. */
export function layoutText(
  measure: (s: string) => number,
  text: string,
  maxWidth: number,
  lineHeight: number,
): TextLayout {
  const space = measure(" ");
  const out: LaidWord[] = [];
  const lineWidths: number[] = [];
  let line = 0;
  let index = 0;
  for (const para of parseRich(text)) {
    let x = 0;
    for (const w of para) {
      const width = measure(w.text);
      if (x > 0 && x + width > maxWidth) {
        lineWidths[line] = x - space;
        line += 1;
        x = 0;
      }
      out.push({ ...w, x, width, line, index: index++ });
      x += width + space;
    }
    lineWidths[line] = Math.max(0, x - space);
    line += 1;
  }
  const lines = Math.max(1, line);
  return {
    words: out,
    lineWidths,
    lineHeight,
    height: lines * lineHeight,
    width: Math.max(0, ...lineWidths),
  };
}

function fontString(weight: number, px: number, font: FontId): string {
  return `${weight} ${Math.max(1, Math.round(px))}px ${FONT_STACKS[font]}`;
}

// Frame

interface Frame {
  ctx: Ctx;
  W: number;
  H: number;
  M: number;
  theme: MotionTheme;
  t: number;
  hand: boolean;
  assets: RenderAssets;
}

export function renderFrame(
  ctx: Ctx,
  spec: MotionSpec,
  t: number,
  assets: RenderAssets = {},
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const f: Frame = {
    ctx,
    W,
    H,
    M: Math.min(W, H),
    theme: spec.theme,
    t,
    hand: spec.theme.font === "hand",
    assets,
  };
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = spec.theme.bg;
  ctx.fillRect(0, 0, W, H);
  if (!spec.scenes.length) {
    ctx.restore();
    return;
  }
  const loc = locate(spec, t);
  const scene = spec.scenes[loc.index];
  if (loc.prev) {
    const prev = spec.scenes[loc.prev.index];
    const p = transitionEase(loc.transition);
    drawTransition(f, spec, scene, loc.local, prev, loc.prev.local, p);
  } else {
    drawScene(f, spec, scene, loc.local);
  }
  ctx.restore();
}

function drawTransition(
  f: Frame,
  spec: MotionSpec,
  scene: MotionScene,
  local: number,
  prev: MotionScene,
  prevLocal: number,
  p: number,
) {
  const { ctx, W, H } = f;
  const kind = scene.transition;
  // Outgoing scene.
  ctx.save();
  if (kind === "push") ctx.translate(-p * W, 0);
  if (kind === "zoom") {
    ctx.translate(W / 2, H / 2);
    ctx.scale(1 - 0.08 * p, 1 - 0.08 * p);
    ctx.translate(-W / 2, -H / 2);
  }
  if (kind === "slide-left" || kind === "slide-up") {
    ctx.translate(
      kind === "slide-left" ? -p * W * 0.25 : 0,
      kind === "slide-up" ? -p * H * 0.25 : 0,
    );
  }
  drawScene(f, spec, prev, prevLocal);
  if (kind === "slide-left" || kind === "slide-up" || kind === "zoom") {
    ctx.fillStyle = `rgba(0,0,0,${0.35 * p})`;
    ctx.fillRect(-W, -H, W * 3, H * 3);
  }
  ctx.restore();

  // Incoming scene.
  ctx.save();
  switch (kind) {
    case "fade":
      ctx.globalAlpha = p;
      break;
    case "slide-left":
    case "push":
      ctx.translate((1 - p) * W, 0);
      break;
    case "slide-up":
      ctx.translate(0, (1 - p) * H);
      break;
    case "zoom":
      ctx.globalAlpha = p;
      ctx.translate(W / 2, H / 2);
      ctx.scale(1.12 - 0.12 * p, 1.12 - 0.12 * p);
      ctx.translate(-W / 2, -H / 2);
      break;
    case "wipe":
      ctx.beginPath();
      ctx.rect(0, 0, p * W, H);
      ctx.clip();
      break;
    case "circle":
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, p * Math.hypot(W, H) * 0.5 + 0.5, 0, Math.PI * 2);
      ctx.clip();
      break;
    default:
      break;
  }
  drawScene(f, spec, scene, local);
  ctx.restore();
  if (kind === "wipe" && p < 1) {
    ctx.fillStyle = f.theme.accent;
    ctx.fillRect(p * W - f.M * 0.006, 0, f.M * 0.012, H);
  }
}

function drawScene(
  f: Frame,
  spec: MotionSpec,
  scene: MotionScene,
  local: number,
) {
  drawBackground(f, scene.background || spec.background);
  for (const el of scene.elements) {
    const st = elementState(el, scene, local);
    if (!st.visible) continue;
    f.ctx.save();
    applyExit(f, el, st);
    drawElement(f, el, st);
    f.ctx.restore();
  }
}

// Backgrounds

export function drawBackground(f: Frame, kind: BackgroundKind) {
  const { ctx, W, H, M, theme, t } = f;
  const dark = luminance(theme.bg) < 0.35;
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);
  switch (kind) {
    case "solid":
      break;
    case "gradient": {
      const a = t * 0.08;
      const g = ctx.createLinearGradient(
        W * (0.5 - 0.5 * Math.cos(a)),
        0,
        W * (0.5 + 0.5 * Math.cos(a)),
        H,
      );
      g.addColorStop(0, theme.bg);
      g.addColorStop(1, theme.bg2);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      glow(
        ctx,
        W * (0.75 + 0.08 * Math.sin(t * 0.3)),
        H * 0.2,
        M * 0.7,
        theme.accent,
        dark ? 0.18 : 0.12,
      );
      break;
    }
    case "aurora": {
      glow(
        ctx,
        W * (0.2 + 0.1 * Math.sin(t * 0.21)),
        H * (0.25 + 0.1 * Math.cos(t * 0.17)),
        M * 0.9,
        theme.accent,
        0.33,
      );
      glow(
        ctx,
        W * (0.82 + 0.08 * Math.cos(t * 0.19)),
        H * (0.72 + 0.1 * Math.sin(t * 0.23)),
        M * 0.85,
        theme.accent2,
        0.24,
      );
      glow(
        ctx,
        W * (0.55 + 0.15 * Math.sin(t * 0.13)),
        H * (0.5 + 0.2 * Math.sin(t * 0.11)),
        M * 1.1,
        theme.bg2,
        0.55,
      );
      break;
    }
    case "grid":
    case "paper": {
      if (kind === "paper") {
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, theme.bg);
        g.addColorStop(1, theme.bg2);
        ctx.fillStyle = g;
        ctx.globalAlpha = 0.5;
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
      }
      const step = M / (kind === "paper" ? 16 : 10);
      const drift = kind === "grid" ? (t * step * 0.15) % step : 0;
      ctx.strokeStyle =
        kind === "paper" ? rgba(theme.accent, 0.08) : rgba(theme.fg, 0.06);
      ctx.lineWidth = Math.max(1, M * 0.0015);
      ctx.beginPath();
      for (let x = -step + drift; x < W + step; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      }
      for (let y = -step + drift; y < H + step; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      }
      ctx.stroke();
      if (kind === "grid")
        glow(ctx, W * 0.5, H * 0.45, M * 0.8, theme.accent, 0.12);
      break;
    }
    case "dots": {
      glow(
        ctx,
        W * (0.3 + 0.1 * Math.sin(t * 0.2)),
        H * 0.3,
        M * 0.8,
        theme.accent,
        0.22,
      );
      glow(
        ctx,
        W * 0.75,
        H * (0.75 + 0.06 * Math.cos(t * 0.25)),
        M * 0.7,
        theme.accent2,
        0.18,
      );
      const step = M / 22;
      ctx.fillStyle = rgba(theme.fg, 0.1);
      for (let y = step / 2; y < H; y += step)
        for (let x = step / 2; x < W; x += step) {
          ctx.fillRect(x, y, Math.max(1, M * 0.002), Math.max(1, M * 0.002));
        }
      break;
    }
    case "video": {
      const v = f.assets.video;
      if (v && v.videoWidth > 0) {
        const s = Math.max(W / v.videoWidth, H / v.videoHeight);
        const dw = v.videoWidth * s;
        const dh = v.videoHeight * s;
        ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
      } else {
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#2b2f3a");
        g.addColorStop(1, "#11131a");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = M * 0.002;
        ctx.strokeRect(M * 0.03, M * 0.03, W - M * 0.06, H - M * 0.06);
      }
      return; // no vignette over footage
    }
  }
  if (dark) {
    const v = ctx.createRadialGradient(
      W / 2,
      H / 2,
      M * 0.35,
      W / 2,
      H / 2,
      Math.hypot(W, H) * 0.6,
    );
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.42)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }
}

function glow(
  ctx: Ctx,
  x: number,
  y: number,
  r: number,
  color: string,
  a: number,
) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, a));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

// Elements

function applyExit(f: Frame, el: MotionElement, st: ElementState) {
  if (st.exit <= 0) return;
  const { ctx, W, H } = f;
  const e = st.exit;
  const ax = el.x * W;
  const ay = el.y * H;
  switch (el.out) {
    case "fade":
      ctx.globalAlpha *= 1 - e;
      break;
    case "sink":
      ctx.globalAlpha *= 1 - e;
      ctx.translate(0, e * H * 0.04);
      break;
    case "shrink":
      ctx.globalAlpha *= 1 - e;
      ctx.translate(ax, ay);
      ctx.scale(1 - 0.4 * e, 1 - 0.4 * e);
      ctx.translate(-ax, -ay);
      break;
    case "slide":
      ctx.globalAlpha *= 1 - e;
      ctx.translate(-e * W * 0.08, 0);
      break;
    default:
      break;
  }
}

function drawElement(f: Frame, el: MotionElement, st: ElementState) {
  switch (el.type) {
    case "text":
      return drawText(f, el, st);
    case "lowerThird":
      return drawLowerThird(f, el, st);
    case "shape":
      return drawShape(f, el, st);
    case "icon":
      return drawIcon(f, el, st);
    case "figure":
      return drawFigure(f, el, st);
    case "chart":
      return drawChart(f, el, st);
    case "counter":
      return drawCounter(f, el, st);
    case "list":
      return drawList(f, el, st);
    case "arrow":
      return drawArrow(f, el, st);
  }
}

function measureWith(ctx: Ctx) {
  return (s: string) => ctx.measureText(s).width;
}

function drawText(f: Frame, el: TextElement, st: ElementState) {
  const { ctx, W, H, theme } = f;
  const px = el.size * H;
  const font: FontId = el.font || theme.font;
  ctx.font = fontString(el.weight, px, font);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const lineHeight = px * (font === "hand" ? 1.25 : 1.14);
  const layout = layoutText(
    measureWith(ctx),
    el.text,
    el.maxWidth * W,
    lineHeight,
  );
  const top = el.y * H - layout.height / 2;
  const anchorX = el.x * W;
  const lineLeft = (line: number) => {
    const lw = layout.lineWidths[line] ?? 0;
    return el.align === "left"
      ? anchorX
      : el.align === "right"
        ? anchorX - lw
        : anchorX - lw / 2;
  };
  const baseColor = el.color || theme.fg;
  const n = layout.words.length;
  const p = st.enter;
  const raw = st.enterRaw;
  const baseline = (line: number) => top + line * lineHeight + px * 0.86;

  // Whole-block animations.
  ctx.save();
  if (el.anim === "fade") ctx.globalAlpha *= p;
  if (el.anim === "rise") {
    ctx.globalAlpha *= clamp01(p * 1.4);
    ctx.translate(0, (1 - p) * px * 0.7);
  }
  if (el.anim === "slide") {
    ctx.globalAlpha *= clamp01(p * 1.4);
    ctx.translate((1 - p) * -W * 0.06, 0);
  }
  if (el.anim === "pop") {
    const s = ease("outBack", raw);
    ctx.globalAlpha *= clamp01(raw * 2);
    ctx.translate(anchorX, el.y * H);
    ctx.scale(0.6 + 0.4 * s, 0.6 + 0.4 * s);
    ctx.translate(-anchorX, -el.y * H);
  }

  if (el.anim === "typewriter") {
    const all = layout.words.map((w) => w.text).join(" ");
    let budget = typewriterCount(all, raw);
    let caret: [number, number] | null = null;
    for (const w of layout.words) {
      if (budget <= 0) break;
      const chars = Array.from(w.text);
      const shown = chars.slice(0, budget).join("");
      budget -= chars.length + 1;
      const x = lineLeft(w.line) + w.x;
      ctx.fillStyle = w.accent ? theme.accent : baseColor;
      ctx.fillText(shown, x, baseline(w.line));
      caret = [x + ctx.measureText(shown).width, baseline(w.line)];
    }
    if (caret && (raw < 1 || Math.floor(st.age * 2) % 2 === 0)) {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(
        caret[0] + px * 0.06,
        caret[1] - px * 0.78,
        Math.max(2, px * 0.07),
        px * 0.9,
      );
    }
    ctx.restore();
    return;
  }

  if (el.anim === "write") {
    // Handwriting: each line is revealed left to right behind a pen.
    const lines = layout.lineWidths.length;
    for (const w of layout.words) {
      ctx.fillStyle = w.accent ? theme.accent : baseColor;
      ctx.fillText(w.text, lineLeft(w.line) + w.x, baseline(w.line));
    }
    ctx.restore();
    // Paint the unrevealed part back over with the clip inverted.
    for (let line = 0; line < lines; line++) {
      const lp = stagger(raw, line, lines, 0.1);
      if (lp >= 1) continue;
      const lw = layout.lineWidths[line] ?? 0;
      const x0 = lineLeft(line) + lw * lp;
      const y0 = top + line * lineHeight - px * 0.1;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, lw * (1 - lp) + px, lineHeight + px * 0.3);
      ctx.clip();
      drawBackgroundPatch(f);
      ctx.restore();
      if (lp > 0) {
        ctx.fillStyle = theme.accent2;
        ctx.beginPath();
        ctx.arc(
          x0,
          baseline(line) - px * 0.3,
          Math.max(2, px * 0.09),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }
    return;
  }

  for (const w of layout.words) {
    const x = lineLeft(w.line) + w.x;
    const y = baseline(w.line);
    let wp = 1;
    ctx.save();
    if (el.anim === "words") {
      wp = stagger(raw, w.index, n, 0.55);
      const e = ease(el.ease === "smooth" ? "outBack" : el.ease, wp);
      ctx.globalAlpha *= clamp01(wp * 2.2);
      const cx = x + w.width / 2;
      ctx.translate(cx, y - px * 0.35 + (1 - e) * px * 0.5);
      ctx.scale(0.7 + 0.3 * e, 0.7 + 0.3 * e);
      ctx.translate(-cx, -(y - px * 0.35));
    } else if (el.anim === "mask") {
      wp = ease(
        "outCubic",
        stagger(raw, w.line, layout.lineWidths.length, 0.3),
      );
      ctx.beginPath();
      ctx.rect(x - px, y - px * 1.05, w.width + px * 2, px * 1.35);
      ctx.clip();
      ctx.translate(0, (1 - wp) * px * 1.2);
    }
    if (w.accent) {
      // Marker underline sweeps in after the word lands.
      const up =
        clamp01((raw - 0.35) * 1.8) *
        (el.anim === "words" ? clamp01(wp * 1.2) : 1);
      if (up > 0) {
        ctx.fillStyle = rgba(theme.accent2, 0.35);
        roundRect(
          ctx,
          x - px * 0.04,
          y - px * 0.22,
          (w.width + px * 0.08) * ease("outCubic", up),
          px * 0.24,
          px * 0.08,
        );
        ctx.fill();
      }
      ctx.fillStyle = theme.accent;
    } else {
      ctx.fillStyle = baseColor;
    }
    if (el.anim === "letters") {
      const chars = Array.from(w.text);
      let cx = x;
      chars.forEach((c, k) => {
        const lp = stagger(raw, w.index * 4 + k, n * 4 + chars.length, 0.7);
        ctx.save();
        ctx.globalAlpha *= clamp01(lp * 1.6);
        ctx.translate(0, (1 - ease("outCubic", lp)) * px * 0.4);
        ctx.fillText(c, cx, y);
        ctx.restore();
        cx += ctx.measureText(c).width;
      });
    } else {
      ctx.fillText(w.text, x, y);
    }
    ctx.restore();
  }
  ctx.restore();
}

/** Repaint the background inside the current clip (handwriting reveal). */
function drawBackgroundPatch(f: Frame) {
  // Paper / solid whiteboards: a flat fill matches; others get their bg.
  drawBackground(f, f.hand ? "paper" : "solid");
}

function roundRect(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function drawLowerThird(f: Frame, el: LowerThirdElement, st: ElementState) {
  const { ctx, W, H, M, theme } = f;
  const raw = st.enterRaw;
  const titlePx = H * 0.052;
  const subPx = H * 0.03;
  const font = theme.font;
  ctx.font = fontString(700, titlePx, font);
  const tw = ctx.measureText(el.title).width;
  ctx.font = fontString(500, subPx, font);
  const sw = ctx.measureText(el.subtitle).width;
  const padX = M * 0.035;
  const boxW = Math.max(tw, sw) + padX * 2;
  const boxH = titlePx * 1.25 + (el.subtitle ? subPx * 1.6 : 0) + M * 0.04;
  const barW = Math.max(3, M * 0.01);
  const right = el.side === "right";
  const left = right ? el.x * W - boxW - barW : el.x * W;
  const top = el.y * H - boxH / 2;
  const barP = ease("outExpo", clamp01(raw / 0.4));
  const boxP = ease("outExpo", clamp01((raw - 0.25) / 0.6));
  const txtP = ease("outCubic", clamp01((raw - 0.45) / 0.55));
  // Accent bar grows from the middle.
  ctx.fillStyle = theme.accent;
  const barX = right ? left + boxW : left;
  ctx.fillRect(barX, top + (boxH * (1 - barP)) / 2, barW, boxH * barP);
  // Panel slides out from behind the bar.
  ctx.save();
  ctx.beginPath();
  if (right) ctx.rect(left + boxW * (1 - boxP), top, boxW * boxP, boxH);
  else ctx.rect(left + barW, top, boxW * boxP, boxH);
  ctx.clip();
  const panelX = right ? left : left + barW;
  const shift = (1 - boxP) * boxW * (right ? 1 : -1);
  ctx.fillStyle = rgba(luminance(theme.bg) < 0.35 ? theme.bg : "#0b0d17", 0.82);
  ctx.fillRect(panelX + shift, top, boxW, boxH);
  ctx.globalAlpha *= txtP;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const tx = panelX + padX + shift;
  ctx.font = fontString(700, titlePx, font);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(
    el.title,
    tx,
    top + M * 0.02 + titlePx * 0.95 + (1 - txtP) * titlePx * 0.4,
  );
  if (el.subtitle) {
    ctx.font = fontString(500, subPx, font);
    ctx.fillStyle = theme.accent2;
    ctx.fillText(
      el.subtitle,
      tx,
      top + M * 0.02 + titlePx * 1.25 + subPx * 1.2,
    );
  }
  ctx.restore();
}

function shapeColor(f: Frame, el: { color: string }) {
  return el.color || f.theme.accent;
}

function drawShape(f: Frame, el: ShapeElement, st: ElementState) {
  const { ctx, W, H, M } = f;
  const cx = el.x * W;
  let cy = el.y * H;
  const round =
    el.shape === "circle" ||
    el.shape === "ring" ||
    el.shape === "blob" ||
    el.shape === "triangle";
  const w = round ? el.w * M : el.w * W;
  const h = round ? el.w * M : el.h * H;
  const color = shapeColor(f, el);
  const raw = st.enterRaw;
  let scale = 1;
  let rot = (el.rotation * Math.PI) / 180;
  let draw = 1;
  ctx.globalAlpha *= el.opacity;
  switch (el.anim) {
    case "pop":
      scale = ease("outBack", raw);
      break;
    case "fade":
      ctx.globalAlpha *= st.enter;
      break;
    case "draw":
      draw = st.enter;
      break;
    case "spin":
      scale = ease("outBack", raw);
      rot += st.age * 0.9;
      break;
    case "float":
      scale = ease("outBack", raw);
      cy += Math.sin(st.age * 1.6 + el.x * 7) * H * 0.012;
      break;
    case "pulse":
      scale = ease("outBack", raw) * (1 + 0.06 * wave(st.age, 1.6));
      break;
  }
  if (scale <= 0.001 || draw <= 0) return;
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.scale(scale, scale);
  const lw = Math.max(2, M * 0.007);
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  const filled =
    el.fill && el.anim !== "draw" && el.shape !== "ring" && el.shape !== "line";
  switch (el.shape) {
    case "circle":
    case "ring": {
      ctx.beginPath();
      ctx.arc(0, 0, w / 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * draw);
      if (filled) ctx.fill();
      else ctx.stroke();
      break;
    }
    case "rect":
    case "pill": {
      const r = el.shape === "pill" ? Math.min(w, h) / 2 : M * 0.02;
      if (filled) {
        roundRect(ctx, -w / 2, -h / 2, w, h, r);
        ctx.fill();
      } else {
        const pts: Polyline = [
          [-w / 2, -h / 2],
          [w / 2, -h / 2],
          [w / 2, h / 2],
          [-w / 2, h / 2],
          [-w / 2, -h / 2],
        ];
        strokeLines(ctx, partialStrokes([pts], draw));
      }
      break;
    }
    case "triangle": {
      const pts: Polyline = [
        [0, -h / 2],
        [w / 2, h / 2],
        [-w / 2, h / 2],
        [0, -h / 2],
      ];
      if (filled) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        pts.slice(1).forEach((p) => ctx.lineTo(p[0], p[1]));
        ctx.fill();
      } else strokeLines(ctx, partialStrokes([pts], draw));
      break;
    }
    case "line": {
      ctx.lineWidth = Math.max(2, h);
      ctx.beginPath();
      ctx.moveTo((-w / 2) * draw, 0);
      ctx.lineTo((w / 2) * draw, 0);
      ctx.stroke();
      break;
    }
    case "blob": {
      const r = w / 2;
      const n = 8;
      const pts: [number, number][] = [];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const rr =
          r *
          (1 +
            0.14 * Math.sin(st.age * 1.2 + k * 2.1) +
            0.06 * Math.cos(st.age * 0.7 + k));
        pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
      const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 0, 0, 0, r * 1.2);
      g.addColorStop(0, rgba(color, 0.9));
      g.addColorStop(1, rgba(f.theme.accent2, 0.5));
      ctx.fillStyle = g;
      ctx.beginPath();
      const mid = (
        a: [number, number],
        b: [number, number],
      ): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const m0 = mid(pts[n - 1], pts[0]);
      ctx.moveTo(m0[0], m0[1]);
      for (let k = 0; k < n; k++) {
        const m = mid(pts[k], pts[(k + 1) % n]);
        ctx.quadraticCurveTo(pts[k][0], pts[k][1], m[0], m[1]);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
  }
}

function strokeLines(ctx: Ctx, lines: Polyline[]) {
  ctx.beginPath();
  for (const l of lines) {
    ctx.moveTo(l[0][0], l[0][1]);
    for (let i = 1; i < l.length; i++) ctx.lineTo(l[i][0], l[i][1]);
  }
  ctx.stroke();
}

function drawIcon(f: Frame, el: IconElement, st: ElementState) {
  const { ctx, W, H, M, theme } = f;
  const size = el.size * M;
  const cx = el.x * W;
  let cy = el.y * H;
  const color = el.color || theme.accent;
  const raw = st.enterRaw;
  let scale = 1;
  let draw = 1;
  if (el.anim === "pop") scale = ease("outBack", raw);
  if (el.anim === "fade") ctx.globalAlpha *= st.enter;
  if (el.anim === "draw") draw = st.enter;
  if (el.anim === "float") {
    scale = ease("outBack", raw);
    cy += Math.sin(st.age * 1.5) * H * 0.012;
  } else if (st.enterRaw >= 1) {
    cy += Math.sin(st.age * 1.2 + el.x * 5) * H * 0.004;
  }
  if (scale <= 0.001) return;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  if (el.badge) {
    const r = size * 0.62;
    ctx.fillStyle = rgba(color, 0.14);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.55);
    ctx.lineWidth = Math.max(1.5, size * 0.03);
    ctx.beginPath();
    ctx.arc(
      0,
      0,
      r,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * (el.anim === "draw" ? draw : 1),
    );
    ctx.stroke();
  }
  const s = (size * (el.badge ? 0.62 : 0.9)) / 24;
  ctx.save();
  ctx.scale(s, s);
  ctx.translate(-12, -12);
  ctx.lineWidth = f.hand ? 2.1 : 1.8;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  const strokes = iconStrokes(el.icon);
  strokeLines(ctx, partialStrokes(strokes, draw));
  if (el.anim === "draw" && draw > 0 && draw < 1) {
    const pen = penPosition(strokes, draw);
    if (pen) {
      ctx.fillStyle = theme.accent2;
      ctx.beginPath();
      ctx.arc(pen[0], pen[1], 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  void M;
}

// Stick figure

interface Pose {
  /** Angles in degrees from straight down, positive = toward facing side. */
  armL: [number, number];
  armR: [number, number];
  legL: [number, number];
  legR: [number, number];
  lean: number;
}

const POSE_TABLE: Record<FigureElement["pose"], Pose> = {
  stand: {
    armL: [-12, -4],
    armR: [12, 4],
    legL: [-10, 0],
    legR: [10, 0],
    lean: 0,
  },
  wave: {
    armL: [-12, -4],
    armR: [130, 160],
    legL: [-10, 0],
    legR: [10, 0],
    lean: -2,
  },
  point: {
    armL: [-14, -6],
    armR: [88, 92],
    legL: [-10, 0],
    legR: [12, 0],
    lean: 3,
  },
  walk: {
    armL: [-20, -10],
    armR: [20, 30],
    legL: [-22, -8],
    legR: [22, 0],
    lean: 4,
  },
  cheer: {
    armL: [-150, -165],
    armR: [150, 165],
    legL: [-14, 0],
    legR: [14, 0],
    lean: 0,
  },
  think: {
    armL: [-10, -4],
    armR: [30, 150],
    legL: [-8, 0],
    legR: [8, 0],
    lean: -3,
  },
  present: {
    armL: [-14, -6],
    armR: [110, 120],
    legL: [-10, 0],
    legR: [10, 0],
    lean: 2,
  },
};

function animatedPose(pose: FigureElement["pose"], age: number): Pose {
  const p = POSE_TABLE[pose];
  const out: Pose = {
    armL: [...p.armL] as [number, number],
    armR: [...p.armR] as [number, number],
    legL: [...p.legL] as [number, number],
    legR: [...p.legR] as [number, number],
    lean: p.lean,
  };
  const breathe = Math.sin(age * 2.2) * 3;
  out.armL[0] += breathe;
  out.armR[0] -= breathe;
  if (pose === "wave") out.armR[1] += Math.sin(age * 9) * 22;
  if (pose === "walk") {
    const s = Math.sin(age * 6);
    out.legL = [-22 * s, -22 * s + (s > 0 ? -18 : 0)];
    out.legR = [22 * s, 22 * s + (s < 0 ? -18 : 0)];
    out.armL = [16 * s, 16 * s + 10];
    out.armR = [-16 * s, -16 * s + 10];
  }
  if (pose === "cheer") {
    const b = Math.abs(Math.sin(age * 5));
    out.armL[1] -= b * 10;
    out.armR[1] += b * 10;
  }
  if (pose === "point" || pose === "present")
    out.armR[1] += Math.sin(age * 3) * 4;
  return out;
}

function limb(
  x: number,
  y: number,
  len: number,
  a1: number,
  a2: number,
  dir: number,
): [[number, number], [number, number]] {
  const r1 = (a1 * Math.PI) / 180;
  const r2 = (a2 * Math.PI) / 180;
  const j: [number, number] = [
    x + Math.sin(r1) * len * dir,
    y + Math.cos(r1) * len,
  ];
  const e: [number, number] = [
    j[0] + Math.sin(r2) * len * dir,
    j[1] + Math.cos(r2) * len,
  ];
  return [j, e];
}

function drawFigure(f: Frame, el: FigureElement, st: ElementState) {
  const { ctx, W, H, theme } = f;
  const h = el.size * H;
  const raw = st.enterRaw;
  const pop = ease("outBack", raw);
  if (pop <= 0.001) return;
  const dir = el.facing === "left" ? -1 : 1;
  const pose = animatedPose(el.pose, st.age);
  const bounce =
    el.pose === "cheer" ? -Math.abs(Math.sin(st.age * 5)) * h * 0.03 : 0;
  const footY = el.y * H + h / 2;
  const cx = el.x * W;
  ctx.globalAlpha *= clamp01(raw * 2);
  ctx.translate(cx, footY);
  ctx.scale(pop, pop);
  ctx.translate(0, bounce);
  // Proportions.
  const head = h * 0.13;
  const torso = h * 0.34;
  const limbLen = h * 0.19;
  const hipY = -h * 0.42;
  const neckY = hipY - torso;
  const leanX = Math.sin((pose.lean * Math.PI) / 180) * torso * dir;
  const color = el.color || theme.fg;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, h * 0.032);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Ground shadow.
  ctx.fillStyle = rgba(theme.fg, 0.1);
  ctx.beginPath();
  ctx.ellipse(0, 0, h * 0.16, h * 0.025, 0, 0, Math.PI * 2);
  ctx.fill();
  const path = (pts: [number, number][]) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
  };
  // Legs.
  const [kL, fL] = limb(
    0,
    hipY,
    limbLen * 1.1,
    pose.legL[0],
    pose.legL[1],
    dir,
  );
  const [kR, fR] = limb(
    0,
    hipY,
    limbLen * 1.1,
    pose.legR[0],
    pose.legR[1],
    dir,
  );
  path([fL, kL, [0, hipY], kR, fR]);
  // Torso.
  path([
    [0, hipY],
    [leanX, neckY],
  ]);
  // Arms (from the shoulder, slightly below the neck).
  const sy = neckY + torso * 0.12;
  const sx = leanX * 0.88;
  const [eL, hL] = limb(sx, sy, limbLen, pose.armL[0], pose.armL[1], dir);
  const [eR, hR] = limb(sx, sy, limbLen, pose.armR[0], pose.armR[1], dir);
  path([hL, eL, [sx, sy], eR, hR]);
  // Head.
  const hx = leanX * 1.05;
  const hy = neckY - head * 1.05;
  ctx.fillStyle = theme.bg;
  ctx.beginPath();
  ctx.arc(hx, hy, head, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Face: eyes blink every ~3.5 s, smile.
  const blink = st.age % 3.5 < 0.12 ? 0.2 : 1;
  ctx.fillStyle = color;
  for (const ex of [-0.32, 0.32]) {
    ctx.beginPath();
    ctx.ellipse(
      hx + (ex + 0.18 * dir) * head,
      hy - head * 0.12,
      head * 0.09,
      head * 0.12 * blink,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.lineWidth = Math.max(1.5, h * 0.02);
  ctx.beginPath();
  ctx.arc(
    hx + 0.15 * dir * head,
    hy + head * 0.12,
    head * 0.42,
    Math.PI * 0.2,
    Math.PI * 0.8,
  );
  ctx.stroke();
  // Thinking dots.
  if (el.pose === "think") {
    ctx.fillStyle = rgba(theme.fg, 0.6);
    [0, 1, 2].forEach((k) => {
      const a = clamp01((st.age - 0.6 - k * 0.3) * 3);
      if (a <= 0) return;
      ctx.globalAlpha *= 1;
      ctx.beginPath();
      ctx.arc(
        hx + dir * head * (1.3 + k * 0.6),
        hy - head * (1.1 + k * 0.6),
        head * (0.1 + k * 0.06) * a,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    });
  }
  // Speech bubble.
  if (el.say) {
    const bp = ease("outBack", clamp01((st.age - 0.5) / 0.5));
    if (bp > 0) {
      const px = h * 0.07;
      ctx.font = fontString(700, px, theme.font);
      const tw = ctx.measureText(el.say).width;
      const bw = tw + px * 1.4;
      const bh = px * 1.9;
      const bx = hx + dir * head * 1.4 + (dir < 0 ? -bw : 0);
      const by = hy - head * 1.6 - bh;
      ctx.save();
      ctx.translate(hx + dir * head, hy - head);
      ctx.scale(bp, bp);
      ctx.translate(-(hx + dir * head), -(hy - head));
      ctx.fillStyle = theme.fg;
      roundRect(ctx, bx, by, bw, bh, bh * 0.45);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(hx + dir * head * 1.7, by + bh - 1);
      ctx.lineTo(hx + dir * head * 1.1, hy - head * 1.1);
      ctx.lineTo(hx + dir * head * 2.4, by + bh - 1);
      ctx.fill();
      ctx.fillStyle = theme.bg;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(el.say, bx + px * 0.7, by + bh / 2 + px * 0.05);
      ctx.restore();
    }
  }
}

// Charts

function drawChart(f: Frame, el: ChartElement, st: ElementState) {
  const { ctx, W, H, M, theme } = f;
  const w = el.w * W;
  const h = el.h * H;
  const x0 = el.x * W - w / 2;
  const y0 = el.y * H - h / 2;
  const raw = st.enterRaw;
  const colors = [el.color || theme.accent, theme.accent2];
  const labelPx = Math.max(10, M * 0.03);
  const valuePx = Math.max(11, M * 0.036);
  const fmt = (v: number) =>
    `${formatNumber(v, Number.isInteger(v) ? 0 : 1)}${el.unit}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const data = el.data;
  const n = data.length;
  if (el.chart === "bar") {
    const max = Math.max(1e-9, ...data.map((d) => Math.abs(d.value)));
    const base = y0 + h - labelPx * 1.8;
    const plotH = base - y0 - valuePx * 1.6;
    const slot = w / n;
    const bw = Math.min(slot * 0.62, M * 0.16);
    ctx.strokeStyle = rgba(theme.fg, 0.25);
    ctx.lineWidth = Math.max(1, M * 0.002);
    ctx.beginPath();
    ctx.moveTo(x0, base);
    ctx.lineTo(x0 + w * ease("outCubic", clamp01(raw * 2)), base);
    ctx.stroke();
    data.forEach((d, i) => {
      const p = ease(el.ease, stagger(raw, i, n, 0.5));
      const bh = (Math.abs(d.value) / max) * plotH * p;
      const cx = x0 + slot * (i + 0.5);
      const g = ctx.createLinearGradient(0, base - bh, 0, base);
      g.addColorStop(0, colors[i % 2]);
      g.addColorStop(1, rgba(colors[i % 2], 0.55));
      ctx.fillStyle = g;
      roundRect(
        ctx,
        cx - bw / 2,
        base - bh,
        bw,
        bh,
        Math.min(bw * 0.18, bh / 2),
      );
      ctx.fill();
      if (p > 0.02) {
        ctx.globalAlpha = clamp01(p * 1.5);
        ctx.fillStyle = theme.fg;
        ctx.font = fontString(800, valuePx, theme.font);
        ctx.fillText(
          fmt(counterValue(0, d.value, p, Number.isInteger(d.value) ? 0 : 1)),
          cx,
          base - bh - valuePx * 0.45,
        );
        ctx.font = fontString(500, labelPx, theme.font);
        ctx.fillStyle = theme.muted;
        ctx.fillText(d.label, cx, base + labelPx * 1.35);
        ctx.globalAlpha = 1;
      }
    });
  } else if (el.chart === "line") {
    const max = Math.max(...data.map((d) => d.value));
    const min = Math.min(0, ...data.map((d) => d.value));
    const base = y0 + h - labelPx * 1.8;
    const plotTop = y0 + valuePx * 1.4;
    const pts: Polyline = data.map((d, i) => [
      x0 + (n === 1 ? w / 2 : (w * i) / (n - 1)),
      base - ((d.value - min) / Math.max(1e-9, max - min)) * (base - plotTop),
    ]);
    const p = ease("inOutCubic", raw);
    // Area fill under the drawn part.
    const part = partialStrokes([pts], p)[0];
    if (part && part.length > 1) {
      const g = ctx.createLinearGradient(0, plotTop, 0, base);
      g.addColorStop(0, rgba(colors[0], 0.35));
      g.addColorStop(1, rgba(colors[0], 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(part[0][0], base);
      part.forEach((q) => ctx.lineTo(q[0], q[1]));
      ctx.lineTo(part[part.length - 1][0], base);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = colors[0];
      ctx.lineWidth = Math.max(2, M * 0.008);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      strokeLines(ctx, [part]);
    }
    pts.forEach((q, i) => {
      const dp = clamp01((p * (n - 1) - i) * 3 + 1);
      if (n > 1 && dp <= 0) return;
      const s = ease("outBack", dp);
      ctx.fillStyle = theme.bg;
      ctx.strokeStyle = colors[1];
      ctx.lineWidth = Math.max(2, M * 0.006);
      ctx.beginPath();
      ctx.arc(q[0], q[1], M * 0.012 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = dp;
      ctx.fillStyle = theme.fg;
      ctx.font = fontString(700, valuePx * 0.8, theme.font);
      ctx.fillText(fmt(data[i].value), q[0], q[1] - valuePx * 0.6);
      ctx.fillStyle = theme.muted;
      ctx.font = fontString(500, labelPx, theme.font);
      ctx.fillText(data[i].label, q[0], base + labelPx * 1.35);
      ctx.globalAlpha = 1;
    });
  } else if (el.chart === "donut") {
    const total = Math.max(
      1e-9,
      data.reduce((a, d) => a + Math.max(0, d.value), 0),
    );
    const r = Math.min(w, h) * 0.38;
    const cx = el.x * W;
    const cy = el.y * H;
    ctx.lineWidth = r * 0.32;
    ctx.lineCap = "butt";
    let a = -Math.PI / 2;
    const p = ease(el.ease, raw);
    const palette = [
      colors[0],
      colors[1],
      theme.fg,
      theme.muted,
      rgba(colors[0], 0.55),
      rgba(colors[1], 0.55),
    ];
    data.forEach((d, i) => {
      const sweep = (Math.max(0, d.value) / total) * Math.PI * 2;
      const end = Math.min(a + sweep, -Math.PI / 2 + Math.PI * 2 * p);
      if (end > a) {
        ctx.strokeStyle = palette[i % palette.length];
        ctx.beginPath();
        ctx.arc(cx, cy, r, a, end - 0.01);
        ctx.stroke();
      }
      a += sweep;
    });
    ctx.fillStyle = theme.fg;
    ctx.font = fontString(800, r * 0.42, theme.font);
    ctx.textBaseline = "middle";
    ctx.fillText(
      fmt(counterValue(0, data[0]?.value ?? 0, p, 0)),
      cx,
      cy - r * 0.05,
    );
    ctx.font = fontString(500, labelPx, theme.font);
    ctx.fillStyle = theme.muted;
    ctx.fillText(data[0]?.label ?? "", cx, cy + r * 0.32);
  } else {
    // progress: each datum is a 0..100 bar.
    const rowH = Math.min(h / n, M * 0.12);
    data.forEach((d, i) => {
      const p = ease(el.ease, stagger(raw, i, n, 0.4));
      const y = el.y * H - (rowH * n) / 2 + rowH * i;
      const v = clamp(d.value, 0, 100);
      ctx.fillStyle = rgba(theme.fg, 0.12);
      roundRect(ctx, x0, y + rowH * 0.45, w, rowH * 0.28, rowH * 0.14);
      ctx.fill();
      ctx.fillStyle = colors[i % 2];
      roundRect(
        ctx,
        x0,
        y + rowH * 0.45,
        Math.max(rowH * 0.28, (w * v * p) / 100),
        rowH * 0.28,
        rowH * 0.14,
      );
      ctx.fill();
      ctx.textAlign = "left";
      ctx.fillStyle = theme.fg;
      ctx.font = fontString(600, labelPx, theme.font);
      ctx.fillText(d.label, x0, y + rowH * 0.36);
      ctx.textAlign = "right";
      ctx.font = fontString(800, valuePx, theme.font);
      ctx.fillText(
        `${formatNumber(counterValue(0, v, p, 0), 0)}${el.unit || "%"}`,
        x0 + w,
        y + rowH * 0.36,
      );
    });
  }
}

function drawCounter(f: Frame, el: CounterElement, st: ElementState) {
  const { ctx, W, H, theme } = f;
  const px = el.size * H;
  const v = counterValue(el.from, el.to, st.enter, el.decimals);
  const num = formatNumber(v, el.decimals);
  const font = theme.font === "hand" ? "hand" : theme.font;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.font = fontString(800, px, font);
  const nw = ctx.measureText(`${el.prefix}${num}`).width;
  // Width of the final number keeps the layout from jittering while counting.
  const finalW = ctx.measureText(
    `${el.prefix}${formatNumber(el.to, el.decimals)}`,
  ).width;
  ctx.font = fontString(800, px * 0.5, font);
  const sw = ctx.measureText(el.suffix).width;
  const total = Math.max(nw, finalW) + (el.suffix ? sw + px * 0.04 : 0);
  const x = el.x * W - total / 2;
  const y = el.y * H + px * 0.34;
  const s = 0.85 + 0.15 * ease("outBack", clamp01(st.enterRaw * 2));
  ctx.globalAlpha *= clamp01(st.enterRaw * 4);
  ctx.translate(el.x * W, el.y * H);
  ctx.scale(s, s);
  ctx.translate(-el.x * W, -el.y * H);
  ctx.font = fontString(800, px, font);
  ctx.fillStyle = el.color || theme.fg;
  ctx.fillText(`${el.prefix}${num}`, x + (Math.max(nw, finalW) - nw), y);
  if (el.suffix) {
    ctx.font = fontString(800, px * 0.5, font);
    ctx.fillStyle = theme.accent;
    ctx.fillText(
      el.suffix,
      x + Math.max(nw, finalW) + px * 0.04,
      y - px * 0.36,
    );
  }
  if (el.label) {
    ctx.font = fontString(500, px * 0.2, theme.font);
    ctx.fillStyle = theme.muted;
    ctx.textAlign = "center";
    ctx.globalAlpha *= clamp01((st.enterRaw - 0.4) * 2);
    ctx.fillText(el.label, el.x * W, y + px * 0.42);
  }
}

function drawList(f: Frame, el: ListElement, st: ElementState) {
  const { ctx, W, H, theme } = f;
  const px = el.size * H;
  const font = theme.font;
  ctx.font = fontString(500, px, font);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const lineH = px * 1.3;
  const bullet = px * 1.25;
  const textX = el.x * W + bullet + px * 0.6;
  const maxW = Math.max(px * 4, el.maxWidth * W - bullet - px * 0.6);
  let y = el.y * H;
  el.items.forEach((item, i) => {
    const t0 = i * el.gap;
    const p = clamp01((st.age - t0) / Math.max(0.05, el.inDur));
    const e = ease("outCubic", p);
    const layout = layoutText(measureWith(ctx), item, maxW, lineH);
    const blockH = Math.max(bullet, layout.height);
    if (p > 0) {
      ctx.save();
      ctx.globalAlpha *= clamp01(p * 1.6);
      ctx.translate((1 - e) * px * 1.2, 0);
      // Bullet.
      const bx = el.x * W + bullet / 2;
      const by = y + bullet / 2;
      const c = el.color || theme.accent;
      const bs = ease("outBack", p);
      ctx.save();
      ctx.translate(bx, by);
      ctx.scale(bs, bs);
      if (el.style === "dot") {
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(0, 0, bullet * 0.22, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = rgba(c, el.style === "number" ? 1 : 0.18);
        ctx.beginPath();
        ctx.arc(0, 0, bullet / 2, 0, Math.PI * 2);
        ctx.fill();
        if (el.style === "number") {
          ctx.fillStyle = luminance(c) > 0.5 ? "#111111" : "#ffffff";
          ctx.font = fontString(800, bullet * 0.55, font);
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(i + 1), 0, bullet * 0.03);
        } else {
          ctx.strokeStyle = c;
          ctx.lineWidth = Math.max(2, bullet * 0.1);
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          const s = bullet / 24;
          ctx.scale(s, s);
          ctx.translate(-12, -12);
          strokeLines(
            ctx,
            partialStrokes(iconStrokes("check"), clamp01(p * 1.5)),
          );
        }
      }
      ctx.restore();
      ctx.font = fontString(500, px, font);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      for (const w of layout.words) {
        ctx.fillStyle = w.accent ? theme.accent : theme.fg;
        ctx.fillText(
          w.text,
          textX + w.x,
          y + w.line * lineH + bullet / 2 + px * 0.35,
        );
      }
      ctx.restore();
    }
    y += blockH + px * 0.75;
  });
}

function drawArrow(f: Frame, el: ArrowElement, st: ElementState) {
  const { ctx, W, H, M, theme } = f;
  const a: [number, number] = [el.x * W, el.y * H];
  const b: [number, number] = [el.x2 * W, el.y2 * H];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const mid: [number, number] = [
    (a[0] + b[0]) / 2 - (dy / len) * el.curve * len,
    (a[1] + b[1]) / 2 + (dx / len) * el.curve * len,
  ];
  const pts: Polyline = [];
  for (let k = 0; k <= 24; k++) {
    const t = k / 24;
    pts.push([
      (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * mid[0] + t * t * b[0],
      (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * mid[1] + t * t * b[1],
    ]);
  }
  const p = st.enter;
  ctx.strokeStyle = el.color || (f.hand ? theme.accent2 : rgba(theme.fg, 0.75));
  ctx.lineWidth = Math.max(2, M * (f.hand ? 0.006 : 0.004));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (!f.hand) ctx.setLineDash?.([]);
  const part = partialStrokes([pts], p);
  strokeLines(ctx, part);
  if (p >= 0.98) {
    const end = pts[pts.length - 1];
    const prev = pts[pts.length - 3];
    const ang = Math.atan2(end[1] - prev[1], end[0] - prev[0]);
    const hs = M * 0.022 * ease("outBack", clamp01((st.enterRaw - 0.9) * 10));
    ctx.beginPath();
    ctx.moveTo(
      end[0] - Math.cos(ang - 0.5) * hs,
      end[1] - Math.sin(ang - 0.5) * hs,
    );
    ctx.lineTo(end[0], end[1]);
    ctx.lineTo(
      end[0] - Math.cos(ang + 0.5) * hs,
      end[1] - Math.sin(ang + 0.5) * hs,
    );
    ctx.stroke();
  }
  void lerp;
}
