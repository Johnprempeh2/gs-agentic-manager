import sharp from "sharp";
import type { ImageAspectRatio } from "@greatstone/shared";
import type { ImageGenerationProvider } from "./types.js";

// Practice mode: draws a labelled placeholder so the whole flow can be tried
// without an image service or any spend. Only used when explicitly chosen.

const DIMENSIONS: Record<ImageAspectRatio, [number, number]> = {
  "1:1": [768, 768],
  "16:9": [1024, 576],
  "9:16": [576, 1024],
  "4:3": [1024, 768],
  "3:4": [768, 1024],
};

function escapeXml(value: string) {
  return value.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function hueFor(prompt: string) {
  let hash = 0;
  for (const char of prompt) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > width) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
    if (lines.length === 5) break;
  }
  if (line && lines.length < 6) lines.push(line);
  return lines;
}

export function createMockImageProvider(options: { delayMs?: number } = {}): ImageGenerationProvider {
  return {
    id: "mock",
    model: "practice",
    async generate({ prompt, aspectRatio }) {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const [width, height] = DIMENSIONS[aspectRatio];
      const hue = hueFor(prompt);
      const lines = wrap(prompt, Math.round(width / 26));
      const text = lines
        .map((line, index) => `<tspan x="50%" dy="${index === 0 ? 0 : 1.3}em">${escapeXml(line)}</tspan>`)
        .join("");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},70%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},70%,38%)"/>
</linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<text x="50%" y="${Math.round(height / 2 - lines.length * 14)}" text-anchor="middle" font-family="sans-serif" font-size="28" fill="white">${text}</text>
<text x="50%" y="${height - 32}" text-anchor="middle" font-family="sans-serif" font-size="18" fill="white" fill-opacity="0.75">Practice image</text>
</svg>`;
      const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
      return { image: { bytes, contentType: "image/png" }, providerRequestId: null };
    },
  };
}
