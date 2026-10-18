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
- **Versions**: make 1, 2 or 4 versions at once. They go in one request to
  `POST /api/companies/{companyId}/generated-images/variations` with `count`,
  so they all start or none do: when they would not all fit under the
  six-pending limit, the server answers `429` and says how many can start.
  Each costs the same as a single image.

Agents get the same studio three ways: `gsam image generate` with `--camera`,
`--lens`, `--focal`, `--aperture` and `--count`; the MCP tools `studio_status`,
`studio_make_image`, `studio_get_image` and `studio_list_images`; or the API.
`studio_attach_to_task` attaches a finished image or clip to a task as a file,
through the same upload route and checks as the board.

At most three images are made at once per server, and a company can have six
pending; a seventh request gets `429`. A pending row left behind by a restart
is marked failed after ten minutes. Requests, completions, failures and
deletions are written to the activity log.

## Video studio

The **Videos** tab on the Images page makes short clips through Higgsfield,
from words alone or by animating a finished studio image (open an image and
press **Animate**). It uses the same Higgsfield key as images
(`HIGGSFIELD_API_KEY_ID` and `HIGGSFIELD_API_KEY_SECRET`). Set
`GSAM_VIDEO_PROVIDER=mock`, or `GSAM_IMAGE_PROVIDER=mock` without a video
setting, for practice mode: every request returns a short labelled clip with
no service and no cost. With no key and no practice mode the tab says what to
add and makes nothing.

- **Models**: `kling-2.5-turbo-pro` (5 or 10 s, default), `kling-2.5-turbo-standard`
  (5 or 10 s, animates an image only) and `hailuo-2.3` (6 or 10 s). The server
  refuses a length the model does not offer.
- **Motion** (optional): slow push in, orbit, pan across, drone rise, handheld
  or locked off. The words are added after the description, then any camera
  words, which take the same picks as images.
- **API**: `POST /api/companies/{companyId}/generated-videos` answers `202`
  with a pending clip; poll `GET /api/generated-videos/{id}` until `completed`
  (`contentPath` plays or downloads it) or `failed` (`error` says why). List
  with `GET /api/companies/{companyId}/generated-videos`; only the board can
  `DELETE /api/generated-videos/{id}`. `GET /api/companies/{companyId}/video-generation`
  says whether video is switched on.
- **Agents**: `gsam video generate` (with `--image`, `--motion`, `--model`,
  `--duration` and the camera flags), or the MCP tools `studio_video_status`,
  `studio_make_video`, `studio_get_video` and `studio_list_videos`.

At most two clips are made at once per server, and a company can have three
pending; a fourth request gets `429`. A pending clip left behind by a restart
is marked failed after thirty minutes. Clip files are served with byte ranges,
so they play and seek in every browser.

## House looks

A house look is a company's saved studio settings under one name, such as
"Acme product shots": a style, camera picks and words to add every time (for
example brand colours or lighting). Pick one under **House look** on the
Images or Videos tab, or press **Save as a house look** to keep the current
style and camera. A request carries `lookId`; the server fills in the style
and camera the request leaves out and adds the look's words to the
description, which is stored with them. A company keeps up to 50 looks, and
names are unique regardless of case.

- **API**: `GET` and `POST /api/companies/{companyId}/studio-looks`, then
  `GET`, `PATCH` and `DELETE /api/studio-looks/{id}`. Board users and agents in
  the company can use them; every change is in the activity log.
- **Agents**: `gsam look list`, `gsam look save --name ...`, `gsam look delete`,
  and `--look <name>` on `gsam image generate` and `gsam video generate`; or
  the MCP tools `studio_list_looks`, `studio_save_look`, and `lookId` on
  `studio_make_image` and `studio_make_video`.

### Comparing looks

With two or more looks saved, **Compare looks?** on the Images tab makes the
same description once in each of two to four looks, side by side, so the team
can see which suits it. The request is the variations endpoint with `lookIds`
in place of `count`; every look must belong to the company (`422`
`studio_look_not_found` otherwise) and nothing starts unless all of them fit.
Agents use `gsam image generate --compare "Warm, Cool"` or `lookIds` on the
MCP tool `studio_make_image`.

### Storyboards

**Storyboard** on the Images tab takes two to four short shot lines, such as
"a barista pours the first cup". Each becomes its own picture: the shot comes
first, then the main description they all share, then the house look's words,
so a campaign's pictures belong together. The request is the variations
endpoint with `shots` (up to 300 characters each) and an optional `lookId`.
Agents use `--shot` once per shot on `gsam image generate`, or `shots` on
`studio_make_image`.

