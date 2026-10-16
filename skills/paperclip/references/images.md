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

## With curl

1. Ask for the image. The reply is `202` with `status: "pending"`:

   ```bash
   curl -sS -X POST "$GSAM_API_URL/api/companies/$GSAM_COMPANY_ID/generated-images" \
     -H "Authorization: Bearer $GSAM_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"prompt": "Flat illustration of a lighthouse at dawn", "aspectRatio": "16:9", "style": "illustration", "issueId": "'"$GSAM_TASK_ID"'"}'
   ```

   `style`, `issueId` and `organisationId` (the client) are optional.

2. Poll `GET /api/generated-images/{id}` every few seconds until `status` is
   `completed` (then `contentPath` is `/api/assets/{assetId}/content`) or
   `failed` (then `error` says why in plain words).
3. To attach it to your task, download `contentPath` and upload the file to
   `POST /api/companies/{companyId}/issues/{issueId}/attachments` as described
   in `references/artifacts.md`. When you put the image in a document or
   comment, use its `altText` as the alt text: `![<altText>](<url>)`.

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
