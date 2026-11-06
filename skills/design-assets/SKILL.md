---
name: design-assets
description: Get, make, check and store a design's images: real brand logos (never drawn), light and dark variants, photos, icons, generated images, and website media library drafts. Look at an image before choosing its background.
---

# Design assets

A design agent never ships a layout that only works with images it does not have. Find or make the asset,
check it, store it, then design around it.

## 1. Look before you place

Before you put any image on a background, look at the image itself (download it and view it). A file name is
not proof of its colours.

- A folder named `light/` or a logo that is mostly white is for **dark** backgrounds. A dark or full-colour logo
  is for **light** backgrounds.
- Never fade a logo or text with opacity to make it quieter. Use a smaller size or a quieter tile instead.
- In a logo row, every logo gets the same treatment: all full colour on light tiles, or all white on dark tiles.

## 2. Real brand logos (clients, partners, tools)

Logos are the brand's real mark. Never draw, generate or retype one.

Try in this order and stop at the first good **wordmark** (the full name logo, not the app icon):

1. **The brand's own site**: press, media or brand page; the header logo (often an SVG in the page source).
2. **Wikimedia Commons**: search `<brand> logo svg`.
3. **Logo.dev** (publishable key, safe in pages; `https://img.logo.dev/<domain>?token=pk_HlIrwjqoSoqLrg1QEYCOuA&size=400&retina=true&format=png`).
   It often returns the square icon, not the wordmark; use it only when an icon is what the design needs.

Check each one by viewing it: right company, current brand (note renames, e.g. Allen & Overy is now A&O Shearman,
so use the mark the client relationship used), no background box, sharp at 2x. If a brand has no good file,
say so and leave that tile out; never substitute an icon in a row of wordmarks.

## 3. Variants

From one good colour logo make what the design needs, with ImageMagick or `sharp`:

- **White** for dark backgrounds: `magick in.png -fill white -colorize 100 out-white.png` (keeps the alpha).
- **Dark** for light backgrounds: `-fill '#121212' -colorize 100`.
- Trim and pad evenly: `magick in.png -trim -bordercolor none -border 8% out.png`.
- Save SVG when the source is SVG; otherwise PNG at 2x the display size.

## 4. Photos, icons and generated images

- **Photos**: Unsplash, with the photographer's credit in the caption. No images from other sites unless they
  are the client's own assets.
- **Icons**: Lucide (`https://unpkg.com/lucide-static@latest/icons/<name>.svg`), stroke 1.75, round caps.
- **Generated images** (backgrounds, illustrations, section art; never logos or real people): GSAM image
  generation, `POST /api/companies/{companyId}/generated-images` with `{ "prompt", "aspectRatio" }`. Prompt in the
  Greatstone look: void #121212, emerald depth, a little lime #c8ff00, no text in the image.

## 5. Store it in the website's media library (drafts)

1. Upload: `POST /api/companies/{companyId}/assets/images` (multipart field `file`, optional `namespace=website`).
   Keep the returned `id` and `sha256`.
2. Add the library entry: `POST /api/companies/{companyId}/website/sites/{siteId}/entries` with
   `{ "collection": "media", "entryKey": "<kebab-name>", "content": { "assetId": "<id>", "alt": "<real alt text>", "caption": "<source and licence>", "width": W, "height": H } }`.
   It is a draft. It reaches the site only in an approved release.
3. In page HTML refer to it as `/media/<sha256>.<ext>` (png, jpg, webp, svg). The release copies it there.

Record where every asset came from in `caption` (for example "Official press kit, bankofireland.com" or
"Unsplash, photo by …").

## 6. Check your own work

Before you show versions, look at them: take a screenshot of the page or artifact at 1440 and 390 wide and view
it. Fix anything unreadable, faded, white on white, cut off or overlapping first. Say in one line what you
checked.
