# Bundled UI Fonts

Paperclip bundles Inter for the board UI so screenshots and packaged installs use
the same sans-serif text stack without relying on host font packages.

## Inter

- Upstream project: https://github.com/rsms/inter
- Version: v4.1
- Source files:
  - https://raw.githubusercontent.com/rsms/inter/v4.1/docs/font-files/InterVariable.woff2
  - https://raw.githubusercontent.com/rsms/inter/v4.1/docs/font-files/InterVariable-Italic.woff2
- License: SIL Open Font License 1.1
- License text: https://github.com/rsms/inter/blob/v4.1/LICENSE.txt

Redistribution note: Inter is redistributed under the SIL Open Font License 1.1.
The bundled WOFF2 files are included unmodified from the upstream v4.1 release.

## Montserrat (Greatstone brand typeface)

GS Agentic Manager sets its interface in Montserrat, the Greatstone house face.
Inter above stays bundled as the fallback for scripts Montserrat does not cover.

- Upstream project: https://github.com/JulietaUla/Montserrat
- Distribution: Fontsource `@fontsource-variable/montserrat` 5.3.0 (variable weight 100 to 900)
- Source files (unicode-range subsets, normal and italic):
  - montserrat-latin-wght-normal.woff2, montserrat-latin-wght-italic.woff2
  - montserrat-latin-ext-wght-normal.woff2, montserrat-latin-ext-wght-italic.woff2
  - montserrat-cyrillic-wght-normal.woff2, montserrat-cyrillic-wght-italic.woff2
  - montserrat-cyrillic-ext-wght-normal.woff2, montserrat-cyrillic-ext-wght-italic.woff2
  - montserrat-vietnamese-wght-normal.woff2, montserrat-vietnamese-wght-italic.woff2
- License: SIL Open Font License 1.1
- License text: https://github.com/JulietaUla/Montserrat/blob/master/OFL.txt

Redistribution note: Montserrat is redistributed under the SIL Open Font License 1.1.
The bundled WOFF2 files are included unmodified from the Fontsource 5.3.0 package.
