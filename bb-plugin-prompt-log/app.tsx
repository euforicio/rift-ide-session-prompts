// bb-plugin-prompt-log — frontend entry.
//
// Registers one surface: a "Prompts" tab in the thread side panel listing every
// prompt sent in the current thread, newest first.
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

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; prompts: LoggedPrompt[] }
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
  onSendToComposer,
}: {
  prompt: LoggedPrompt;
  now: number;
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
    <li className="border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-xs text-muted-foreground"
          title={formatAbsoluteTime(prompt.createdAt)}
        >
          {formatRelativeTime(prompt.createdAt, now)}
        </span>
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

      {hasText ? (
        <p
          ref={textRef}
          style={isExpanded ? expandedStyle : clampStyle}
          className="mt-1 text-sm text-foreground"
        >
          {prompt.text}
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
        const { prompts } = await rpcRef.current.call("listPrompts", {
          threadId,
        });
        if (!isCancelled) setState({ kind: "ready", prompts });
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

  // Filter case-insensitively, then sort newest-first EXPLICITLY rather than
  // trusting the server's ordering.
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched =
      needle === ""
        ? allPrompts
        : allPrompts.filter((prompt) =>
            prompt.text.toLowerCase().includes(needle),
          );
    return [...matched].sort((left, right) => right.createdAt - left.createdAt);
  }, [allPrompts, filter]);

  const isFiltering = filter.trim() !== "";

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
          detail={`Nothing in this thread contains “${filter.trim()}”.`}
          action={
            <Button variant="outline" size="sm" onClick={() => setFilter("")}>
              Clear filter
            </Button>
          }
        />
      );
    }
    return (
      <ul className="flex flex-col">
        {rows.map((prompt) => (
          <PromptRow
            key={prompt.id}
            prompt={prompt}
            now={now}
            onSendToComposer={sendToComposer}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border p-3">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter prompts…"
          aria-label="Filter prompts"
          className="h-8 text-sm"
        />
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
