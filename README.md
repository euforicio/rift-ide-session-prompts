# bb-ide-session-prompts

Plugins for [bb](https://get-bb.dev), an agentic IDE for managing coding agents
across projects, threads, and environments.

This repository holds one plugin today, with room for more session-related ones
later. Each plugin is a top-level directory with its own `package.json` and
README.

## Plugins

| Directory | Plugin | What it does |
| --- | --- | --- |
| [`bb-plugin-prompt-log/`](bb-plugin-prompt-log/) | **Prompt Log** | Adds a **Prompts** tab to the thread side panel listing every prompt you sent, newest first — day-grouped, filterable, live-updating, with a button to put any prompt back in the composer. |

## Install

From the Git URL, without cloning:

```sh
bb plugin install git:git@github.com:pablooliva/bb-ide-session-prompts.git \
  --subdirectory bb-plugin-prompt-log
```

`--subdirectory` is required: the repo root is not itself a plugin.

From a local clone, registered in place so edits are picked up by
`bb plugin dev`:

```sh
git clone git@github.com:pablooliva/bb-ide-session-prompts.git
cd bb-ide-session-prompts
bb plugin install ./bb-plugin-prompt-log
```

## Requirements

Set by [`bb-plugin-prompt-log/package.json`](bb-plugin-prompt-log/package.json):

- bb `>= 0.40`
- bb plugin SDK `>= 0.4.21`
- Node `>= 22.18.0`

## Development

Work inside a plugin directory, not the repo root:

```sh
cd bb-plugin-prompt-log
npm install
npm test          # vitest: backend harness + jsdom panel tests
npm run typecheck # tsc --noEmit
npm run build     # bb plugin build
```

With the plugin installed from a local path, `bb plugin dev` rebuilds and hot
reloads on save, and `bb plugin logs prompt-log -f` tails its output.

See [`bb-plugin-prompt-log/README.md`](bb-plugin-prompt-log/README.md) for the
design notes — how live refresh is wired, why there is no manual Refresh button,
and which dependencies are deliberately not bundled.
