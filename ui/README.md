# @greatstone/ui

Published static assets for the GS Agentic Manager board UI.

## What gets published

The npm package contains the production build under `dist/`. It does not ship the UI source tree or workspace-only dependencies.

## Storybook

Storybook config, stories, and fixtures live under `ui/storybook/`.

```sh
pnpm --filter @greatstone/ui storybook
pnpm --filter @greatstone/ui build-storybook
```

## Typical use

Install the package, then serve or copy the built files from `node_modules/@greatstone/ui/dist`.

## Editor dependency identity

Keep the root and workspace overrides for `@codemirror/state`,
`@codemirror/view`, and `@lezer/common` aligned. CodeMirror requires shared
extension identity, while Lezer parsers and syntax highlighters require shared
`NodeProp` IDs. Multiple Lezer copies can crash code-block highlighting with
`tags is not iterable`. `src/lib/codemirror-single-instance.test.ts` checks the
installed dependency graph and highlights sample code through the editor's real
language dependencies. GitHub Actions owns regeneration of `pnpm-lock.yaml`.
