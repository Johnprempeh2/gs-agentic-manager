# Making Images

GSAM can make an image from a written description. Use it when a task asks
for a picture: a social post, a slide or banner visual, an illustration for a
document, a mock product shot. The finished image is stored as a company image
the board can see on the **Images** page, and you can attach it to your task.

Check first that it is set up:

```bash
curl -sS "$GSAM_API_URL/api/companies/$GSAM_COMPANY_ID/image-generation" \
  -H "Authorization: Bearer $GSAM_API_KEY"
```

`{"configured": false}` means no image service key is set. Say so in your
task comment and ask the board to set one up; do not try other services.

## Quickest path: the CLI

```bash
gsam image generate \
  --prompt "Flat illustration of a lighthouse at dawn, warm colours, no text" \
  --shape wide \
  --style greatstone-brand \
  --issue-id "$GSAM_TASK_ID"
```

This waits for the image (usually under a minute), then attaches it to the
task. Shapes: `square` (1:1, social posts), `wide` (16:9, slides and banners),
`tall` (9:16, stories), `landscape` (4:3, documents), `portrait` (3:4,
posters). Add `--out ./image.png` to keep a local copy, for example to put it
in a document you are building.

`--style` is optional and adds tested wording for a look: `greatstone-brand`
(charcoal and neon lime, for Greatstone's own material), `client-proposal`,
`social-post`, `photo` or `illustration`. Leave it out to use only your words.
`--issue-id` also links the image to the task, so the board sees it in Images
next to that task.

### Camera and versions

Shoot it like a film with optional camera flags, and make up to four versions
to choose from:

```bash
gsam image generate \
  --prompt "A barista pouring latte art in a sunlit cafe" \
  --shape landscape \
  --camera full-frame-cine --lens swirl-bokeh-portrait --focal 85 --aperture f1.4 \
  --count 2 \
  --issue-id "$GSAM_TASK_ID"
```

Cameras: `modular-8k`, `full-frame-cine`, `70mm-film`, `studio-s35`,
`16mm-film`, `large-format`. Lenses: `premium-modern-prime`,
`clinical-sharp-prime`, `warm-cinema-prime`, `vintage-prime`,
`70s-cinema-prime`, `classic-anamorphic`, `compact-anamorphic`,
`swirl-bokeh-portrait`, `halation-diffusion`, `creative-tilt`,
`extreme-macro`. Focal lengths: 8, 14, 24, 35, 50, 85. Apertures: `f1.4`
(blurred background), `f4`, `f11` (everything sharp). Good pairings: product
shots `large-format` + `clinical-sharp-prime` + 50 + `f11`; portraits
`full-frame-cine` + `swirl-bokeh-portrait` + 85 + `f1.4`.

Every version costs money; use `--count` above 1 only when the task wants a
choice. Versions start together or not at all. With MCP, the same settings go
to `studio_make_image` (with `count`), then poll `studio_get_image`.

### Video clips

Animate a finished studio image, or make a clip from words alone:

```bash
gsam video generate \
  --prompt "Steam rises from the cup as the barista smiles" \
  --image "$IMAGE_ID" --motion slow-push --duration 5 \
  --issue-id "$GSAM_TASK_ID" --out clip.mp4
```

Models: `kling-2.5-turbo-pro` (5 or 10 s, default), `kling-2.5-turbo-standard`
(5 or 10 s, needs `--image`), `hailuo-2.3` (6 or 10 s). Motion: `slow-push`,
`orbit`, `pan`, `drone`, `handheld`, `still`. The camera flags work as for
images. A clip can take several minutes and costs more than an image, so make
one only when the task asks for video. Run `gsam video status` first; if it
says video is off, tell the board rather than trying another service. With
MCP: `studio_make_video`, then poll `studio_get_video`.

### House looks

When a client's pictures must match, use their house look instead of
repeating the settings. `gsam look list` shows the saved looks; add
`--look "Acme product shots"` to `gsam image generate` or `gsam video
generate`. Your own flags win over the look. Save a new one with
`gsam look save --name "Acme product shots" --style photo --camera large-format
--aperture f11 --words "navy and gold, soft morning light"`. With MCP:
`studio_list_looks`, `studio_save_look`, and `lookId`.

To let the board choose between looks, make the same picture in each:
`gsam image generate --prompt "..." --compare "Warm, Cool"` (2 to 4 look
names), or `lookIds` on `studio_make_image`. Link the results to the task so
the board can pick one.

For a campaign or a sequence, make a storyboard: put what every picture
shares in `--prompt` (subject, place, brand) and each moment in its own
`--shot` (2 to 4), with `--look` so they match. With MCP, pass `shots`.

The board stars the takes it likes. Before using a picture, check for picks
with `gsam image list --favourites` (MCP: `favourite: true` on
`studio_list_images`). To suggest your own best take, star it with
`gsam image favourite <id>` (MCP: `studio_favourite_image`) and say so in your
comment.

## With curl

1. Ask for the image. The reply is `202` with `status: "pending"`:

   ```bash
   curl -sS -X POST "$GSAM_API_URL/api/companies/$GSAM_COMPANY_ID/generated-images" \
     -H "Authorization: Bearer $GSAM_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"prompt": "Flat illustration of a lighthouse at dawn", "aspectRatio": "16:9", "style": "illustration", "issueId": "'"$GSAM_TASK_ID"'"}'
   ```

   `style`, `camera` (for example `{"lens": "vintage-prime", "focalLength": 35}`),
   `issueId` and `organisationId` (the client) are optional.

2. Poll `GET /api/generated-images/{id}` every few seconds until `status` is
   `completed` (then `contentPath` is `/api/assets/{assetId}/content`) or
   `failed` (then `error` says why in plain words).
3. To attach it to your task, download `contentPath` and upload the file to
   `POST /api/companies/{companyId}/issues/{issueId}/attachments` as described
   in `references/artifacts.md` (with MCP, `studio_attach_to_task` does both
   steps for an image or clip). When you put the image in a document or
   comment, use its `altText` as the alt text: `![<altText>](<url>)`.
4. To show it on the task's or client's card, `PATCH /api/generated-images/{id}/cover`
   with `{"issueCover": true}` or `{"organisationCover": true}`. The image must
   be finished and linked to that task or client.

## Writing good prompts

- Say the subject, the style and the mood: "Watercolour of a busy London
  street market at dusk, soft light".
- Ask for "no text" unless words are the point; image models misspell them.
- Name the brand colours when it matters, and the use ("for a LinkedIn post").

## Limits

- A company can have 6 images in progress at once; a 429 means wait for one
  to finish. Every image costs the company money, so make what the task needs
  rather than many variations.
- A `failed` status whose error mentions content rules means the service
  declined the description. Reword it once; if it fails again, say so in your
  comment instead of retrying.
