# @deepseek-ai/dsh-client-ui-settings-plugin-center

English | [中文](README.zh.md)

The desktop plugin-center browser contribution: two tabs in the existing Plugins settings section — **Discover** (search the `dsh-plugin` topic, inspect a candidate, confirm install scripts, install an exact version) and **Manage** (installed desktop-profile plugins, the persisted operation ledger, removal, and retry of failed changes). Both tabs drive the `window.dshStudio` bridge only the DSH Studio Electron shell provides; on any other deployment they render a desktop-only notice.

The desktop profile mounts this package through the desktop-integration bundle's patch (row `desktop-plugin-center`); the packaged runtime ships it as a dependency of the `@deepseek-ai/dsh-web-app` bundle.

## Current behavior

- Registers the `settings.plugins.tab` entries `discover` (order 5) and `manage` (order 6) with the `settings.pluginCenter` locale dictionaries.
- The bridge accessor is injected (never imported): tabs call `window.dshStudio` lazily and degrade to a notice when it is absent.
- Install script confirmation is mandatory: a candidate whose exact version declares lifecycle scripts or native build steps asks "Allow install scripts" before installing.
- A `restart-required` operation surfaces the restart confirmation, which calls the bridge's `restartHarness`.
- Failed operations in Manage can be retried; a `scripts-not-confirmed` failure re-asks for the script confirmation instead of silently retrying.

## Development

`pnpm run bundle` builds `lib/client.js` through the shared client-bundle preset (platform-module externals + the module-table handoff). Component and plugin tests run in the jsdom lane under the root vitest configuration.

## Model Experience

### Desktop bridge surface

#### What the model sees

None: the plugin-center tabs only drive the `window.dshStudio` bridge (`searchPlugins`, `inspectPlugin`, `installPlugin`, `removePlugin`, `listInstalledPlugins`, `restartHarness`) inside browser Settings. They register nothing model-facing and add no prompt section.

#### Token effect

None: the tabs add zero model tokens; no model input is assembled or sent.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Desktop-only bridge** — the tabs render a desktop-only notice on a plain Harness web deployment because `window.dshStudio` exists only in the DSH Studio Electron shell.
- **Retry uses the safe default** — retrying a failed install outside `scripts-not-confirmed` resubmits without scripts; a script-needing package must re-confirm through the Discover tab or the confirmation gate.
