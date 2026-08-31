# Prompt Log

A [bb](https://get-bb.dev) plugin that lists every prompt you sent in a thread,
newest first, in a side-panel tab called **Prompts**.

When an agent's replies are long, finding your own messages means scrolling back
through walls of tool output. This gives you your prompts — and only your
prompts — as a compact, scannable list.

## What it does

- **Prompts tab** in the thread side panel, next to "Start side chat" and
  "Start terminal".
- **Newest first.** Sorted descending on `createdAt` in the frontend, so the
  order does not depend on the server's default ordering.
- **Day groups.** Rows sit under sticky `Today` / `Yesterday` / `Aug 28`
  headings, so scrolling a long thread walks through sessions rather than an
  undifferentiated stream.
- **Relative timestamps** ("2m ago", "1h ago"), refreshed every 30s, with the
  exact time in each row's tooltip, in a machine-readable `<time>` element.
- **Working marker.** While the thread is running, the prompt being worked on
  carries a pulsing "working" dot, so the panel shows what the agent is doing
  right now.
- **3-line clamp** with a More/Less toggle, shown only on rows whose text is
  actually truncated at the panel's current width.
- **Live updates.** A new prompt appears at the top without reopening the panel;
  no manual refresh control is needed (see "Refreshing").
- **Composer button.** Each row puts its text back in the composer so you can
  re-run or amend an earlier request (see "Composer action").
- **Filter box** — case-insensitive substring match, with matches highlighted in
  the row text and an `×` to clear it. Highlighting matters because rows are
  clamped: a row can match on text that is not currently visible.
- **Never blank.** Distinct states for loading, empty history, no filter match,
  no thread, and a load failure (with Retry).

## How it works

`server.ts` exposes one RPC method, `listPrompts`, over
`bb.sdk.threads.promptHistory({ threadId })` — a source that contains only
user-submitted prompts, so no assistant output or tool calls need filtering out.

Each history record's `input` is an array of structured parts. The server
flattens it to a single string plus a count:

- `type: "text"` parts are joined, except those marked
  `visibility: "agent-only"` — that is context bb injected for the agent
  (resolved @-mentions and similar), not words you typed.
- Every other part type is counted, not dropped, so an image-only prompt still
  renders as a row that says `+1 non-text part` rather than a blank entry. This
  is also how it degrades on part types a future bb adds.

For live updates the server publishes a bare invalidation on the
`prompts-changed` channel, and the panel refetches:

- `thread.active` — a thread entering the running state, which is what
  submitting a prompt to an idle thread does. This is the normal path.
- `thread.idle` — the end of a turn, which catches prompts **queued or steered
  into an already-running turn**. Those add history rows without producing a new
  `active` transition, so without this they would not appear until the 30s
  backstop tick described under "Refreshing".
- `thread.failed` — a turn ending in failure, which produces no `idle`
  transition. Without it the panel would keep showing the "working" marker on a
  thread that had already stopped.

The panel also refetches on each *re*-connection
(`useRealtimeConnectionState()`), because realtime signals are ephemeral and are
never replayed — anything published while the socket was down is lost.

`shared.ts` holds the channel name. It exists so `app.tsx` never imports a
*value* from `server.ts`: a type-only import is erased from the frontend bundle,
but a value import is not, and would pull zod and the `node:` builtins into it.

## Dependencies

Runtime `dependencies` are deliberately just two:

| Package | Why |
| --- | --- |
| `zod` | RPC contract schemas. bb does not shim zod. |
| `@radix-ui/react-slot` | Used by the vendored `components/ui/button`. Not a portal family, so not shimmed. |

Everything bb shims at runtime (react, react-dom, sonner, clsx, tailwind-merge,
class-variance-authority, the portal radix families) is a **type-only
`devDependencies`** entry at the host's version — run `bb plugin types` to
repin them rather than choosing versions by hand. Timestamps are formatted by
hand; there is no date library.

## Development

```sh
bb plugin install .    # register this directory in place
bb plugin dev          # rebuild + hot reload on save
bb plugin logs prompt-log -f
bb plugin list
```

```sh
npm test          # vitest: backend harness + jsdom panel tests
npm run typecheck # tsc --noEmit
npm run build     # bb plugin build
```

`vitest.config.ts` restates the `@/*` alias because vitest runs on vite, which
does not read it from `tsconfig.json` the way `bb plugin build` does.

## The working marker

`listPrompts` also returns `isRunning`, derived server-side from
`bb.sdk.threads.get(...).status` — true for `active` and `starting` (a session
spinning up is already working from the user's point of view), false for `idle`,
`stopping` and `error`. It is a **boolean, not the raw status enum**: the panel
does not need BB's status vocabulary, and a new status value therefore cannot
break the frontend.

The marker is keyed to the newest prompt's **identity**, computed from the
unfiltered list — not to "whatever row is on top". A filter can put a much older
prompt first, and labelling that one as in-flight would be actively misleading.
There is a test for exactly that case.

## Composer action

Each row's arrow button calls `useComposer().setText(...)`, which **replaces**
the composer draft rather than appending to it. That is deliberate: the composer
then contains exactly that prompt, every time, with no dependence on invisible
state.

It is also safe, and this was **verified in the running app**: BB's composer
undo (`Cmd+Z`) restores a draft that `setText` replaced. So an in-progress
message is recoverable.

Do not "fix" this by switching to `addQuote()` (which appends a `> ` blockquote)
or by conditionally appending only when a draft exists. Both trade a predictable
single behavior for a safety net the host already provides.

The button is icon-only because the label was identical on every row, carrying no
information after the first while costing ~22% of the row width in a ~420px
column. Its accessible name is on `aria-label` and the native tooltip is on a
wrapper `span`, because the vendored `Button` deliberately omits `title`. The
glyph is an inline stroke SVG using `currentColor`, so it follows the host theme
and adds no icon dependency.

## Refreshing

There is deliberately **no manual Refresh control**. A live panel that ships one
implies its own list cannot be trusted, and in a ~420px column that button costs
permanent space for an occasional case. Four things keep the list current
instead:

| Trigger | Covers |
| --- | --- |
| Panel mount | Opening the tab |
| `thread.active` signal | Submitting a prompt to an idle thread (instant) |
| `thread.idle` signal | End of a turn |
| 30s backstop tick | Everything else, including a missed signal |

The backstop exists for one real gap: a prompt **queued or steered into an
already-running turn** causes no new `active` transition, because the thread was
already active. Event-driven refresh alone would leave it invisible for the whole
turn — precisely when this panel is most useful. The tick that keeps relative
timestamps honest doubles as that refetch, so it costs no extra timer, and the
worst-case delay is 30 seconds rather than the length of a turn.

The error state keeps its own **Retry** button. That one is load-bearing: nothing
else recovers a failed initial load.
