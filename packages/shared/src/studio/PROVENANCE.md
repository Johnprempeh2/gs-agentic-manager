# Image studio camera and prompt wording

Source: https://github.com/ClabstreamTeam/Open-Higgsfield-AI (a fork of
https://github.com/Anil-matcha/Open-Higgsfield-AI)
Files used: `src/lib/promptUtils.js` (camera, lens, focal length and aperture
wording, prompt enhancer tags and quick prompts) and the idea behind
`src/components/CameraControls.js` and `src/components/ImageStudio.js`.
Fork commit: 44788b5
License: MIT (see LICENSE). The upstream repository is MIT licensed; the
copyright line is copied from its LICENSE file.

GSAM adaptations: the wording is kept as data in TypeScript with stable ids,
plain-English hints for non-technical users, and a zod schema so agents and the
API can pick the same settings. The vanilla JS components, the Muapi.ai client
and the bundled lens photographs are not included; GSAM sends requests through
its own server-side providers (Higgsfield, OpenAI or practice mode).
