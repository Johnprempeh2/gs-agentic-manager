import { describe, expect, it } from "vitest";
import { composeImagePrompt, createGeneratedImageSchema } from "../image-generation.js";
import {
  addPromptBooster,
  parseStudioChoice,
  STUDIO_FOCAL_LENGTHS,
  STUDIO_LENSES,
  studioCameraLabel,
  studioCameraSchema,
  studioCameraWords,
} from "./camera.js";

describe("studio camera", () => {
  it("writes the camera, lens, focal length and aperture in Open Higgsfield order", () => {
    expect(
      studioCameraWords({ camera: "70mm-film", lens: "classic-anamorphic", focalLength: 35, aperture: "f1.4" }),
    ).toBe(
      "shot on a grand format 70mm film camera, using a classic anamorphic lens at 35mm (natural cinematic perspective), aperture f/1.4, shallow depth of field, creamy bokeh, cinematic lighting, natural colour science, high dynamic range",
    );
  });

  it("adds nothing when no camera is picked", () => {
    expect(studioCameraWords({})).toBe("");
    expect(studioCameraWords(null)).toBe("");
    expect(studioCameraLabel({})).toBeNull();
  });

  it("works with only some picks", () => {
    expect(studioCameraWords({ focalLength: 85 })).toBe(
      "at 85mm (classic portrait perspective), cinematic lighting, natural colour science, high dynamic range",
    );
    expect(studioCameraLabel({ lens: "vintage-prime", aperture: "f11" })).toBe("Vintage Prime, f/11");
  });

  it("puts the camera wording before the style guidance", () => {
    const composed = composeImagePrompt("A harbour at night.", "photo", { camera: "16mm-film" });
    expect(composed.startsWith("A harbour at night, shot on a classic 16mm film camera,")).toBe(true);
    expect(composed).toContain("As a realistic high quality photograph");
    expect(composeImagePrompt("A harbour", null, null)).toBe("A harbour");
  });

  it("refuses unknown picks", () => {
    expect(studioCameraSchema.safeParse({ focalLength: 40 }).success).toBe(false);
    expect(studioCameraSchema.safeParse({ lens: "fisheye" }).success).toBe(false);
    expect(studioCameraSchema.safeParse({ camera: "16mm-film", extra: true }).success).toBe(false);
    expect(createGeneratedImageSchema.parse({ prompt: "A cat", camera: { aperture: "f4" } }).camera).toEqual({ aperture: "f4" });
  });

  it("reads CLI values by id or label", () => {
    expect(parseStudioChoice(STUDIO_LENSES, "Classic Anamorphic")?.id).toBe("classic-anamorphic");
    expect(parseStudioChoice(STUDIO_LENSES, "vintage-prime")?.id).toBe("vintage-prime");
    expect(parseStudioChoice(STUDIO_FOCAL_LENGTHS, "35mm")?.value).toBe(35);
    expect(parseStudioChoice(STUDIO_FOCAL_LENGTHS, "50")?.value).toBe(50);
    expect(parseStudioChoice(STUDIO_LENSES, "nope")).toBeNull();
  });

  it("adds a booster once", () => {
    expect(addPromptBooster("A cat,", "golden hour")).toBe("A cat, golden hour");
    expect(addPromptBooster("A cat, golden hour", "Golden Hour")).toBe("A cat, golden hour");
    expect(addPromptBooster("", "neon glow")).toBe("neon glow");
  });
});
