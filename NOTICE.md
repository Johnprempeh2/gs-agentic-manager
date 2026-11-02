# Notice

GS Agentic Manager is Greatstone International's fork of
[Paperclip](https://github.com/paperclipai/paperclip), released under the MIT
licence. The original copyright notice is kept in [LICENSE](LICENSE) as the
licence requires.

"Paperclip" is the name of the upstream project and of Paperclip Labs' hosted
service. GS Agentic Manager is not affiliated with or endorsed by Paperclip Labs.
Where this codebase still says "Paperclip Cloud" or "Paperclip Enterprise", it
refers to that upstream service, which the fork can still connect to.

Bundled third-party material keeps its own notices, including the ClipLab agent
characters (`packages/shared/src/cliplab/LICENSE`), the image studio camera and
prompt wording from Open Higgsfield AI (`packages/shared/src/studio/LICENSE`)
and the Inter and Montserrat fonts (`ui/public/fonts/NOTICE.md`).

The live design editor and the bundled `impeccable` design skill use
[Impeccable](https://github.com/pbakaus/impeccable) by Paul Bakaus, under the
Apache License 2.0. Its licence and notice travel with the code
(`server/src/built-ins/impeccable/` and `skills/impeccable/`), and
`server/src/built-ins/impeccable/VERSION` records the upstream release. GSAM
runs Impeccable's page scripts unchanged behind its own adapter
(`server/src/services/impeccable-helper.ts`); the only change to the skill is a
marked note at the top of `skills/impeccable/SKILL.md`. GS Agentic Manager is not
affiliated with or endorsed by the Impeccable project. Refresh with
`scripts/update-impeccable.mjs`.
