# Image Generation

GSAM can make images from a written description. Board users do it on the
**Images** page; agents do it with `gsam image generate` or the API
(`skills/paperclip/references/images.md`). Every finished image is stored as
an ordinary company asset and listed on the Images page.

## Turning it on

The image service is chosen from the server environment. Restart the server
after changing it.

| Variable | Meaning |
| --- | --- |
| `HIGGSFIELD_API_KEY_ID`, `HIGGSFIELD_API_KEY_SECRET` | Higgsfield key pair, made at [console.higgsfield.ai](https://console.higgsfield.ai) (the secret is shown once). No higgsfield.ai plan is needed. With these set, Higgsfield is used automatically. `HF_API_KEY_ID`/`HF_API_KEY_SECRET`, or one `HIGGSFIELD_API_KEY=id:secret`, also work. |
| `HIGGSFIELD_IMAGE_MODEL` | Optional. Model path, default `higgsfield-ai/soul/standard`. Any Higgsfield text-to-image model path that accepts `prompt` and `aspect_ratio` works, for example `higgsfield-ai/soul/v2/standard`. |
| `HIGGSFIELD_IMAGE_RESOLUTION` | Optional. Sent as `resolution`. Soul standard accepts `720p` (its default) or `1080p`; other models may differ. |
| `HIGGSFIELD_API_BASE_URL` | Optional. Default `https://api.higgsfield.ai`. |
| `GSAM_IMAGE_PROVIDER` | Optional. `higgsfield`, `openai` or `mock`. `mock` draws labelled placeholder images with no service and no cost, for trying the flow. |
| `GSAM_IMAGE_OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL` | Used only with `GSAM_IMAGE_PROVIDER=openai` (falls back to `OPENAI_API_KEY`; default model `gpt-image-1`). OpenAI is never picked automatically, because `OPENAI_API_KEY` is usually there for agents. |

Higgsfield is pay as you go: the API runs on its own prepaid US dollar
balance (5 dollars minimum top-up), separate from any higgsfield.ai plan, and
only finished images are charged. Requests wait while the balance is empty. A missing or rejected key, an empty account and a refused prompt each
show a plain message on the image card.

## How it works

1. `POST /api/companies/{companyId}/generated-images` with `prompt` and
   `aspectRatio` (`1:1`, `16:9`, `9:16`, `4:3`, `3:4`) saves a pending row and
   answers `202`. Optional: `style` (a preset id: `greatstone-brand`,
   `client-proposal`, `social-post`, `photo`, `illustration`), `issueId` (the
   task it is for) and `organisationId` (the client). The style's wording is
   added to the prompt sent to the provider; the row keeps the person's words.
2. The server asks the provider in the background (Higgsfield: submit, poll
   `status_url`, download `images[0].url`), stores the file under
   `assets/generated-images`, and marks the row `completed` with its `assetId`,
   or `failed` with a reason.
3. Callers poll `GET /api/generated-images/{id}`. The Images page polls every
   three seconds while anything is pending.
4. `GET /api/companies/{companyId}/generated-images` takes `q` (words in the
   description), `issueId` and `organisationId` to filter the gallery.

From a task, **Make an image** (next to Upload attachment) opens the same
composer in a dialog and adds the finished picture to the task through the
normal attachment upload. The same button sits next to Upload files on a
client's documents (the image is linked to that client and filed in the stage
it was made from) and in board chat, where it joins the next message.

Every image carries `altText`: a short description written from the prompt,
with directions such as "no text" or "4k" left out. The UI uses it for the
`alt` attribute so screen readers have plain words for the picture. It is
worked out from the prompt, not by a language model, so it costs nothing.

A finished image linked to a task or a client can be that task's or client's
cover: `PATCH /api/generated-images/{id}/cover` with `issueCover` and/or
`organisationCover` (true or false). Each task and client has at most one
cover, so setting a new one clears the last. The board cards read every cover
in one call, `GET /api/companies/{companyId}/generated-images/covers`. In the
gallery, open an image and press **Use as cover for ...**.

## Image studio: camera, finishing touches and versions

The Images page works as an image studio, built from the ideas in
[Open Higgsfield AI](https://github.com/ClabstreamTeam/Open-Higgsfield-AI)
(MIT; see `packages/shared/src/studio/PROVENANCE.md`).

- **Camera** (optional): pick a camera body, lens, focal length and aperture,
  or a ready-made look (Film still, Portrait, Product advert, Retro). The
  request carries `camera: { camera, lens, focalLength, aperture }` with the
  ids in `packages/shared/src/studio/camera.ts`; the server adds the matching
  words (for example "shot on a classic 16mm film camera, using a vintage
  prime lens at 50mm") after the person's words and before any style
  guidance. The row keeps the picks, and the gallery shows them.
- **Finishing touches** (optional): one tap adds lighting, mood, look or finish
  words to the description itself.
- **Versions**: make 1, 2 or 4 versions at once. Each is its own request and
  costs the same as a single image, so the six-pending limit still applies.

Agents get the same studio three ways: `gsam image generate` with `--camera`,
`--lens`, `--focal`, `--aperture` and `--count`; the MCP tools `studio_status`,
`studio_make_image`, `studio_get_image` and `studio_list_images`; or the API.

At most three images are made at once per server, and a company can have six
pending; a seventh request gets `429`. A pending row left behind by a restart
is marked failed after ten minutes. Requests, completions, failures and
deletions are written to the activity log.
