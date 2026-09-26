# @greatstone/create-paperclip-plugin

Scaffolding tool for creating new GS Agentic Manager plugins.

```bash
npx @greatstone/create-paperclip-plugin my-plugin
```

Or with options:

```bash
npx @greatstone/create-paperclip-plugin @acme/my-plugin \
  --template connector \
  --category connector \
  --display-name "Acme Connector" \
  --description "Syncs Acme data into GS Agentic Manager" \
  --author "Acme Inc"
```

Supported templates: `default`, `connector`, `workspace`  
Supported categories: `connector`, `workspace`, `automation`, `ui`

Generates:
- typed manifest + worker entrypoint
- example UI widget using the supported `@greatstone/plugin-sdk/ui` hooks
- test file using `@greatstone/plugin-sdk/testing`
- `esbuild` and `rollup` config files using SDK bundler presets
- dev server script for hot-reload (`paperclip-plugin-dev-server`)

The scaffold starts with plain React elements so the generated plugin stays minimal. For GS Agentic Manager-native controls, import shared host components such as `MarkdownEditor`, `FileTree`, `AssigneePicker`, and `ProjectPicker` from `@greatstone/plugin-sdk/ui`.

Inside this repo, the generated package uses `@greatstone/plugin-sdk` via `workspace:*`.

Outside this repo, the scaffold snapshots `@greatstone/plugin-sdk` from your local GS Agentic Manager checkout into a `.paperclip-sdk/` tarball and points the generated package at that local file by default. You can override the SDK source explicitly:

```bash
node packages/plugins/create-paperclip-plugin/dist/bin.js @acme/my-plugin \
  --output /absolute/path/to/plugins \
  --sdk-path /absolute/path/to/paperclip/packages/plugins/sdk
```

That gives you an outside-repo local development path before the SDK is published to npm.

## Workflow after scaffolding

```bash
cd my-plugin
pnpm install
pnpm dev       # watch worker + manifest + ui bundles
pnpm dev:ui    # local UI preview server with hot-reload events
pnpm test
```
