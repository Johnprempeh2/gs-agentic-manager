# Hermes Gateway Adapter Compatibility Shim

`@greatstone/adapter-hermes-gateway` is a deprecated compatibility shim.

Use `@greatstone/hermes-paperclip-adapter` for new installs and import gateway
entrypoints from `@greatstone/hermes-paperclip-adapter/gateway`. The adapter
type remains `hermes_gateway`; only package ownership changed.

`hermes_gateway` is for an already-running Hermes API server. It does not start
the local Hermes CLI. If GS Agentic Manager should launch local `hermes chat` as a child
process, use `hermes_local` from `@greatstone/hermes-paperclip-adapter`
instead.

The shim preserves the legacy exports for one release:

- `.`
- `./server`
- `./ui`
- `./cli`
- `./ui-parser`

These exports forward to the unified Hermes package. Existing
`@greatstone/adapter-hermes-gateway` plugin installs should continue to load
during the compatibility window, but should migrate to
`@greatstone/hermes-paperclip-adapter` before the shim is removed.
