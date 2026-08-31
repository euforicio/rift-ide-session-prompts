// bb-plugin-prompt-log — frontend entry.
//
// Registers one surface: a "Prompts" tab in the thread side panel listing every
// prompt sent in the current thread, newest first, grouped by day.
//
// Only the CONTRACT TYPE is imported from ./server, so the backend module (and
// zod, and the node: builtins) stay out of this bundle. The realtime channel
// name is a value, so it lives in ./shared instead.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  definePluginApp,
  useBbContext,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PROMPTS_CHANGED_CHANNEL } from "./shared.js";
import type { LoggedPrompt, rpcContract } from "./server";

/** Accessible name + tooltip for the per-row composer action. */
const COMPOSER_ACTION_LABEL = "Put this prompt in the composer";

/** Lines a collapsed row shows before the expand toggle appears. */
const CLAMP_LINES = 3;
/** How often timestamps are recomputed and the backstop refetch runs. */
const TICK_MS = 30_000;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_WEEK = 604_800;

/**
 * Relative timestamp, formatted by hand to keep runtime dependencies at zero.
 *
 * Each branch floors the unit it has already range-checked, so no branch can
 * emit a "0m ago" or "60m ago" boundary value.
 */
function formatRelativeTime(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (seconds < SECONDS_PER_MINUTE) return "just now";

  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(seconds / SECONDS_PER_DAY);
  if (days < 7) return `${days}d ago`;

  return `${Math.floor(seconds / SECONDS_PER_WEEK)}w ago`;
}

/** Full timestamp for the row's tooltip, where the relative one is too coarse. */
function formatAbsoluteTime(createdAt: number): string {
  return new Date(createdAt).toLocaleString();
}

/**
 * LOCAL calendar-day identity, so grouping matches the day the user would read
 * off a clock rather than a UTC boundary.
 */
function dayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Group heading. "Today"/"Yesterday" carry more meaning than a date, and the
 * year is only shown when it differs from the current one. Uses the platform's
 * own locale formatting rather than a date library.
 */
function formatDayLabel(ms: number, now: number): string {
  if (dayKey(ms) === dayKey(now)) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(ms) === dayKey(yesterday.getTime())) return "Yesterday";

  const date = new Date(ms);
  const isCurrentYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(
    undefined,
    isCurrentYear
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  );
}

interface PromptGroup {
  key: string;
  label: string;
  prompts: LoggedPrompt[];
}

/**
 * Split an ALREADY newest-first list into consecutive day runs. Because the
 * input is sorted, a single pass preserves both the group order and the order
 * within each group — no re-sorting, and no chance of the grouping silently
 * reordering the list.
 */
function groupByDay(prompts: LoggedPrompt[], now: number): PromptGroup[] {
  const groups: PromptGroup[] = [];
  for (const prompt of prompts) {
    const key = dayKey(prompt.createdAt);
    const current = groups[groups.length - 1];
    if (current !== undefined && current.key === key) {
      current.prompts.push(prompt);
      continue;
    }
    groups.push({
      key,
      label: formatDayLabel(prompt.createdAt, now),
      prompts: [prompt],
    });
  }
  return groups;
}

/**
 * Read the thread id out of an untrusted realtime payload. Signals arrive as
 * `unknown`, and this plugin's own channel is the only one delivered here, but
 * the shape is still checked rather than asserted.
 */
function signalThreadId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { threadId } = payload as { threadId?: unknown };
  return typeof threadId === "string" ? threadId : null;
}

const clampStyle: CSSProperties = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: CLAMP_LINES,
  overflow: "hidden",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const expandedStyle: CSSProperties = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

/**
 * "Insert into input" arrow, inline so the plugin needs no icon dependency.
 * Stroke-based and using currentColor, so it follows the host theme; the
 * Button's `[&_svg]:size-4` rule sizes it.
 */
function ComposerArrowIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  );
}

/** Dismiss glyph for the filter's clear control. */
function ClearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/**
 * Render `text` with every case-insensitive occurrence of `query` marked.
 *
 * This matters because rows are clamped to three lines: a row can match on text
 * that is not even visible, so without marking it there is no way to see WHY it
 * survived the filter.
 *
 * The highlight uses `bg-foreground/20` rather than `<mark>`'s default yellow,
 * which would ignore the host theme and go unreadable in dark mode.
 */
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (query === "") return <>{text}</>;

  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = 0;

  for (;;) {
    const found = haystack.indexOf(needle, cursor);
    if (found === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (found > cursor) parts.push(text.slice(cursor, found));
    parts.push(
      <mark
        key={`m${matchIndex++}`}
        className="rounded bg-foreground/20 text-foreground"
      >
        {text.slice(found, found + needle.length)}
      </mark>,
    );
    cursor = found + needle.length;
  }

  return <>{parts}</>;
}

/**
 * "The agent is working on this right now" marker.
 *
 * A pulsing ring rather than a spinner: it sits inline beside a timestamp in a
 * narrow column, so it must not reserve spinner-sized space or draw the eye
 * away from the prompt text. `role="status"` gives assistive tech the same
 * information the dot conveys visually.
 */
function RunningIndicator() {
  return (
    <span
      role="status"
      className="flex shrink-0 items-center gap-1.5 text-xs text-foreground"
    >
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-foreground opacity-60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-foreground" />
      </span>
      working
    </span>
  );
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; prompts: LoggedPrompt[]; isRunning: boolean }
  | { kind: "error"; message: string };

/** Shared framing for the non-list states, so the panel is never blank. */
function PanelMessage({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <p className="text-sm text-foreground">{title}</p>
      {detail !== undefined && (
        <p className="text-xs text-muted-foreground">{detail}</p>
      )}
      {action}
    </div>
  );
}

function PromptRow({
  prompt,
  now,
  query,
  isRunning,
  onSendToComposer,
}: {
  prompt: LoggedPrompt;
  now: number;
  query: string;
  /** True only for the one prompt the agent is currently working on. */
  isRunning: boolean;
  onSendToComposer: (prompt: LoggedPrompt) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [doesOverflow, setDoesOverflow] = useState(false);
  const textRef = useRef<HTMLParagraphElement | null>(null);

  // Measure whether the clamped text is actually truncated, so the toggle only
  // appears on rows that need it. Measuring beats guessing from text length:
  // the panel is user-resizable, and wrapping depends on its real width.
  //
  // While expanded this deliberately does not run — scrollHeight then equals
  // clientHeight, which would read as "no overflow" and remove the button the
  // user needs to collapse the row again.
  useEffect(() => {
    if (isExpanded) return;
    const node = textRef.current;
    if (node === null) return;

    const measure = () => {
      setDoesOverflow(node.scrollHeight > node.clientHeight + 1);
    };
    measure();

    // Re-measure when the panel is resized. Guarded because ResizeObserver is
    // absent in some environments (jsdom under test); the one-shot measure
    // above still runs there.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [prompt.text, isExpanded]);

  const hasText = prompt.text !== "";

  return (
    <li className="border-b border-border px-4 pt-2.5 pb-7 transition-colors last:border-b-0 hover:bg-state-hover">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <time
            dateTime={new Date(prompt.createdAt).toISOString()}
            className="text-xs text-muted-foreground"
            title={formatAbsoluteTime(prompt.createdAt)}
          >
            {formatRelativeTime(prompt.createdAt, now)}
          </time>
          {isRunning && <RunningIndicator />}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {doesOverflow && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs text-muted-foreground"
              aria-expanded={isExpanded}
              onClick={() => setIsExpanded((previous) => !previous)}
            >
              {isExpanded ? "Less" : "More"}
            </Button>
          )}
          {/* The label was identical on every row, so it carried no
              information after the first one and cost ~22% of the row width in
              a ~420px column. The accessible name lives on aria-label, and the
              wrapper carries the native tooltip because the vendored Button
              deliberately omits `title`. */}
          <span title={COMPOSER_ACTION_LABEL}>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-muted-foreground"
              aria-label={COMPOSER_ACTION_LABEL}
              disabled={!hasText}
              onClick={() => onSendToComposer(prompt)}
            >
              <ComposerArrowIcon />
            </Button>
          </span>
        </div>
      </div>

      {/* Only the content is indented. The timestamp and actions stay
          flush with the row edge, so the text reads as a block beneath
          its own header rather than as another column. */}
      <div className="pl-3">
        {hasText ? (
          <p
            ref={textRef}
            style={isExpanded ? expandedStyle : clampStyle}
            className="mt-1 text-sm text-foreground"
          >
            <HighlightedText text={prompt.text} query={query} />
          </p>
        ) : (
          <p className="mt-1 text-sm italic text-muted-foreground">
            No text in this prompt
          </p>
        )}

        {prompt.extraPartCount > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            +{prompt.extraPartCount} non-text{" "}
            {prompt.extraPartCount === 1 ? "part" : "parts"}
          </p>
        )}
      </div>
    </li>
  );
}

function PromptsPanel() {
  // The thread comes from the route context, not from the slot's props.
  const { threadId } = useBbContext();
  const composer = useComposer();

  // useRpc's identity is not documented as stable across renders, so it is
  // held in a ref and kept out of the fetch effect's dependencies. Depending
  // on it directly would risk an unbounded refetch loop.
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [filter, setFilter] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(() => {
    setReloadToken((previous) => previous + 1);
  }, []);

  // Fetch on mount, on thread change, and whenever something asks for a
  // refresh (a realtime signal, a reconnect, the backstop tick, or Retry).
  useEffect(() => {
    if (threadId === null) return;
    let isCancelled = false;

    void (async () => {
      try {
        const { prompts, isRunning } = await rpcRef.current.call(
          "listPrompts",
          { threadId },
        );
        if (!isCancelled) setState({ kind: "ready", prompts, isRunning });
      } catch (error) {
        if (isCancelled) return;
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [threadId, reloadToken]);

  // One timer, two jobs: keep the relative timestamps honest, and act as a
  // slow backstop refetch.
  //
  // The backstop is what makes the list trustworthy without a manual Refresh
  // control. The event-driven path covers submitting to an idle thread
  // (thread.active) and the end of a turn (thread.idle), but a prompt queued
  // or STEERED INTO AN ALREADY-RUNNING TURN produces no new active
  // transition — so without this it would stay invisible for the length of
  // that turn, which is exactly when this panel is most useful.
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      refresh();
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Live updates: the server publishes on every thread.active / thread.idle.
  useRealtime(
    PROMPTS_CHANGED_CHANNEL,
    useCallback(
      (payload: unknown) => {
        if (threadId === null) return;
        if (signalThreadId(payload) !== threadId) return;
        refresh();
      },
      [threadId, refresh],
    ),
  );

  // Realtime signals are ephemeral and are never replayed, so anything
  // published while the socket was down is simply lost. Refetch on each
  // RE-connection to close that gap. The first connection is skipped because
  // the fetch effect above has already run for it.
  const connectionState = useRealtimeConnectionState();
  const hasConnectedRef = useRef(false);
  useEffect(() => {
    if (connectionState !== "connected") return;
    if (!hasConnectedRef.current) {
      hasConnectedRef.current = true;
      return;
    }
    refresh();
  }, [connectionState, refresh]);

  const sendToComposer = useCallback(
    (prompt: LoggedPrompt) => {
      composer.setText(prompt.text);
      composer.focus();
      toast.success("Prompt copied to the composer");
    },
    [composer],
  );

  const allPrompts = state.kind === "ready" ? state.prompts : [];
  const isRunning = state.kind === "ready" && state.isRunning;
  const query = filter.trim();

  // The marker is keyed to the newest prompt's IDENTITY, computed from the
  // unfiltered list. Marking "whatever row is on top" would be wrong: a filter
  // can put a much older prompt first, and labelling that one as in-flight
  // would be actively misleading.
  const newestPromptId = useMemo(() => {
    let newest: LoggedPrompt | null = null;
    for (const prompt of allPrompts) {
      if (newest === null || prompt.createdAt > newest.createdAt) newest = prompt;
    }
    return newest?.id ?? null;
  }, [allPrompts]);
  const isFiltering = query !== "";

  // Filter case-insensitively, then sort newest-first EXPLICITLY rather than
  // trusting the server's ordering.
  const rows = useMemo(() => {
    const needle = query.toLowerCase();
    const matched =
      needle === ""
        ? allPrompts
        : allPrompts.filter((prompt) =>
            prompt.text.toLowerCase().includes(needle),
          );
    return [...matched].sort((left, right) => right.createdAt - left.createdAt);
  }, [allPrompts, query]);

  const groups = useMemo(() => groupByDay(rows, now), [rows, now]);

  function renderBody() {
    if (threadId === null) {
      return <PanelMessage title="Open a thread to see its prompts" />;
    }
    if (state.kind === "loading") {
      return <PanelMessage title="Loading prompts…" />;
    }
    if (state.kind === "error") {
      return (
        <PanelMessage
          title="Could not load prompts"
          detail={state.message}
          action={
            <Button variant="outline" size="sm" onClick={refresh}>
              Retry
            </Button>
          }
        />
      );
    }
    if (allPrompts.length === 0) {
      return (
        <PanelMessage
          title="No prompts yet"
          detail="Prompts you send in this thread show up here."
        />
      );
    }
    if (rows.length === 0) {
      return (
        <PanelMessage
          title="No prompts match"
          detail={`Nothing in this thread contains “${query}”.`}
          action={
            <Button variant="outline" size="sm" onClick={() => setFilter("")}>
              Clear filter
            </Button>
          }
        />
      );
    }
    // Groups are <section>s rather than list items so the only <li> elements in
    // the panel remain the prompt rows themselves.
    return (
      <div>
        {groups.map((group) => (
          <section key={group.key}>
            {/* Sticky within its own section, so the heading stays visible
                while you scroll that day and is then pushed out by the next. */}
            <h3 className="sticky top-0 z-10 border-b border-border bg-background px-4 py-1.5 text-xs font-medium text-muted-foreground">
              {group.label}
            </h3>
            <ul className="flex flex-col">
              {group.prompts.map((prompt) => (
                <PromptRow
                  key={prompt.id}
                  prompt={prompt}
                  now={now}
                  query={query}
                  isRunning={isRunning && prompt.id === newestPromptId}
                  onSendToComposer={sendToComposer}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="relative">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter prompts…"
            aria-label="Filter prompts"
            // pr-8 keeps typed text from running under the clear control.
            className="h-8 pr-8 text-sm"
          />
          {isFiltering && (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => setFilter("")}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
            >
              <ClearIcon />
            </button>
          )}
        </div>
        {state.kind === "ready" && (
          <p className="mt-2 text-xs text-muted-foreground">
            {isFiltering
              ? `${rows.length} of ${allPrompts.length}`
              : `${allPrompts.length} ${allPrompts.length === 1 ? "prompt" : "prompts"}`}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{renderBody()}</div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "prompts",
    title: "Prompts",
    icon: "ListView",
    // "flush" hands the tab its full area with no host padding or scrolling,
    // so the filter box can stay pinned while only the list scrolls.
    layout: "flush",
    component: PromptsPanel,
    // Braced body: `run` is declared `void | Promise<void>`, so a concise
    // arrow would return openPanel's boolean and fail to typecheck.
    run: ({ openPanel }) => {
      openPanel({ title: "Prompts" });
    },
  });
});
