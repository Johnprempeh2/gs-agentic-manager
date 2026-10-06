let cached: boolean | undefined;

/** Whether this browser can draw WebGL (the 3D Memory graph). Checked once per page load. */
export function supportsWebGL(): boolean {
  if (cached !== undefined) return cached;
  try {
    const canvas = document.createElement("canvas");
    cached = Boolean(window.WebGLRenderingContext && (canvas.getContext("webgl2") || canvas.getContext("webgl")));
  } catch {
    cached = false;
  }
  return cached;
}
