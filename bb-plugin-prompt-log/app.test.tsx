// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
  type RenderSlotOptions,
  type RenderedSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { PROMPTS_CHANGED_CHANNEL } from "./shared.js";

const THREAD = "thr_context";
const BASE = 1_700_000_000_000;

type Row = {
  id: string;
  createdAt: number;
  text: string;
  extraPartCount: number;
};

function row(id: string, minutesAgo: number, text: string): Row {
  return { id, createdAt: BASE - minutesAgo * 60_000, text, extraPartCount: 0 };
}

/** Anchored to the real clock, because day grouping is relative to today. */
function recentRow(id: string, minutesAgo: number, text: string): Row {
  return {
    id,
    createdAt: Date.now() - minutesAgo * 60_000,
    text,
    extraPartCount: 0,
  };
}

const MINUTES_PER_DAY = 60 * 24;

let app: CapturedPluginApp;

beforeAll(async () => {
  // The thunk form installs the test runtime before app.tsx binds it.
  app = await loadPluginApp(() => import("./app"));
});

function panel() {
  const registration = app.threadPanelActions[0];
  if (registration === undefined) throw new Error("no threadPanelAction");
  return registration;
}

// renderSlot mounts into document.body and does not self-clean, so every mount
// is tracked and unmounted between tests. Without this, queries match stale
// panels left over from earlier tests.
const mounted: RenderedSlot[] = [];

function mountPanel(
  options: RenderSlotOptions,
  props: { threadId: string; params: null } = { threadId: THREAD, params: null },
): RenderedSlot {
  const slot = renderSlot(panel(), props, options);
  mounted.push(slot);
  return slot;
}

/** Options with the common case filled in: this thread, one canned response. */
function withPrompts(prompts: Row[], isRunning = false): RenderSlotOptions {
  return {
    rpc: { listPrompts: () => ({ prompts, isRunning }) },
    context: { threadId: THREAD, projectId: null },
  };
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.lifecycle.unmount();
});

/** Visible row text, in the order the panel rendered it. */
function renderedRows(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("li")).map((node) =>
    (node.textContent ?? "").trim(),
  );
}

describe("registration", () => {
  it("registers exactly one thread panel action titled Prompts", () => {
    expect(app.threadPanelActions).toHaveLength(1);
    expect(panel().id).toBe("prompts");
    expect(panel().title).toBe("Prompts");
    // "flush" so the filter box stays pinned and only the list scrolls.
    expect(panel().layout).toBe("flush");
  });
});

describe("thread source", () => {
  it("reads the thread from useBbContext, not from the slot prop", async () => {
    const slot = mountPanel(withPrompts([row("a", 5, "hello")]), {
      // A deliberately different id in the prop: if the panel read the prop,
      // the recorded RPC input would carry this value instead.
      threadId: "thr_from_prop",
      params: null,
    });

    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    expect(slot.inspection.rpcCalls[0]).toEqual({
      method: "listPrompts",
      input: { threadId: THREAD },
    });
  });
});

describe("ordering", () => {
  it("renders newest first even when the server returns oldest first", async () => {
    // Ascending on purpose — the panel must not trust the server's order.
    const slot = mountPanel(
      withPrompts([
        row("oldest", 600, "OLDEST"),
        row("middle", 60, "MIDDLE"),
        row("newest", 1, "NEWEST"),
      ]),
    );

    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(3));
    const rows = renderedRows(slot.container);
    expect(rows[0]).toContain("NEWEST");
    expect(rows[1]).toContain("MIDDLE");
    expect(rows[2]).toContain("OLDEST");
  });
});

describe("filter", () => {
  it("narrows rows by case-insensitive substring", async () => {
    const slot = mountPanel(
      withPrompts([
        row("a", 1, "Add a GITIGNORE file"),
        row("b", 2, "Set the remote repo"),
      ]),
    );

    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(2));

    // Lowercase query against uppercase text proves case-insensitivity.
    fireEvent.change(slot.getByLabelText("Filter prompts"), {
      target: { value: "gitignore" },
    });

    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(1));
    expect(renderedRows(slot.container)[0]).toContain("GITIGNORE");

    // A query matching nothing gets its own state, not a blank panel.
    fireEvent.change(slot.getByLabelText("Filter prompts"), {
      target: { value: "zzz-no-match" },
    });
    await waitFor(() => slot.getByText("No prompts match"));
    expect(renderedRows(slot.container)).toHaveLength(0);
  });
});

describe("empty and error states", () => {
  it("shows 'No prompts yet' for an empty history", async () => {
    const slot = mountPanel(withPrompts([]));
    await waitFor(() => slot.getByText("No prompts yet"));
  });

  it("shows the error with a working Retry button", async () => {
    let attempts = 0;
    const slot = mountPanel({
      rpc: {
        listPrompts: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("Thread not found");
          return { prompts: [row("a", 3, "recovered")], isRunning: false };
        },
      },
      context: { threadId: THREAD, projectId: null },
    });

    await waitFor(() => slot.getByText("Could not load prompts"));
    // The underlying message is surfaced, not swallowed.
    slot.getByText(/Thread not found/);

    fireEvent.click(slot.getByText("Retry"));

    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(1));
    expect(renderedRows(slot.container)[0]).toContain("recovered");
  });
});

describe("copy to composer", () => {
  it("puts the row's text in the composer and focuses it", async () => {
    const slot = mountPanel(withPrompts([row("a", 2, "re-run this please")]));

    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(1));
    expect(slot.inspection.composer.text).toBe("");

    // Icon-only now, so query by accessible name rather than visible text.
    fireEvent.click(
      slot.getByRole("button", { name: "Put this prompt in the composer" }),
    );

    await waitFor(() =>
      expect(slot.inspection.composer.text).toBe("re-run this please"),
    );
    expect(slot.inspection.composer.focusCount).toBeGreaterThan(0);
  });
});

describe("live updates", () => {
  it("refetches on a realtime signal for this thread only", async () => {
    const slot = mountPanel(withPrompts([row("a", 1, "one")]));

    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));

    // A signal for a different thread must be ignored.
    await slot.behavior.emitRealtime(PROMPTS_CHANGED_CHANNEL, {
      threadId: "thr_somewhere_else",
    });
    expect(slot.inspection.rpcCalls).toHaveLength(1);

    // A signal for this thread refetches.
    await slot.behavior.emitRealtime(PROMPTS_CHANGED_CHANNEL, {
      threadId: THREAD,
    });
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));
  });

  it("ignores a malformed signal payload instead of throwing", async () => {
    const slot = mountPanel(withPrompts([]));

    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    await slot.behavior.emitRealtime(PROMPTS_CHANGED_CHANNEL, "not-an-object");
    await slot.behavior.emitRealtime(PROMPTS_CHANGED_CHANNEL, { threadId: 42 });
    expect(slot.inspection.rpcCalls).toHaveLength(1);
  });

  it("backstops with a slow refetch, covering a prompt steered into a running turn", async () => {
    // No lifecycle event fires when a prompt is queued into an already-active
    // thread, so the timer is the only thing that surfaces it before the turn
    // ends. This is why the panel ships no manual Refresh control.
    vi.useFakeTimers();
    try {
      const slot = mountPanel(withPrompts([]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(slot.inspection.rpcCalls).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(slot.inspection.rpcCalls).toHaveLength(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(slot.inspection.rpcCalls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches on reconnect, because signals sent while offline are never replayed", async () => {
    const slot = mountPanel(withPrompts([]));

    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));

    await slot.behavior.setRealtimeConnectionState("reconnecting");
    expect(slot.inspection.rpcCalls).toHaveLength(1);

    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));
  });
});

describe("no thread in context", () => {
  it("never renders a blank panel", () => {
    const slot = mountPanel({
      rpc: { listPrompts: () => ({ prompts: [] }) },
      context: { threadId: null, projectId: null },
    });

    slot.getByText("Open a thread to see its prompts");
    expect(slot.inspection.rpcCalls).toHaveLength(0);
  });
});

describe("expand and collapse", () => {
  // jsdom reports every element as zero-height, so the panel's real overflow
  // measurement can never trigger. Shadow the two properties it reads to
  // simulate text taller (or not) than its 3-line clamp.
  function forceHeights(scrollHeight: number, clientHeight: number) {
    for (const [name, value] of [
      ["scrollHeight", scrollHeight],
      ["clientHeight", clientHeight],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get: () => value,
      });
    }
  }

  afterEach(() => {
    // Remove the shadowing so Element.prototype's own definitions apply again.
    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });

  it("offers a toggle only when the clamped text actually overflows", async () => {
    forceHeights(200, 60);
    const slot = mountPanel(
      withPrompts([row("a", 1, "a very long pasted prompt")]),
    );

    await waitFor(() => slot.getByText("More"));
    fireEvent.click(slot.getByText("More"));
    await waitFor(() => slot.getByText("Less"));
    fireEvent.click(slot.getByText("Less"));
    await waitFor(() => slot.getByText("More"));
  });

  it("omits the toggle when the text fits", async () => {
    forceHeights(60, 60);
    const slot = mountPanel(withPrompts([row("a", 1, "short")]));

    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(1));
    expect(slot.queryByText("More")).toBeNull();
  });
});

describe("day grouping", () => {
  function headings(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("h3")).map((node) =>
      (node.textContent ?? "").trim(),
    );
  }

  it("labels today and yesterday, and orders groups newest day first", async () => {
    const slot = mountPanel(
      withPrompts([
        recentRow("t", 5, "TODAY PROMPT"),
        recentRow("y", MINUTES_PER_DAY, "YESTERDAY PROMPT"),
        recentRow("o", MINUTES_PER_DAY * 3, "OLDER PROMPT"),
      ]),
    );

    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(3));

    const labels = headings(slot.container);
    expect(labels).toHaveLength(3);
    expect(labels[0]).toBe("Today");
    expect(labels[1]).toBe("Yesterday");
    // Three days back is a calendar date, not a relative word.
    expect(labels[2]).not.toBe("Today");
    expect(labels[2]).not.toBe("Yesterday");

    // Grouping must not disturb the strict newest-first row order.
    const rows = renderedRows(slot.container);
    expect(rows[0]).toContain("TODAY PROMPT");
    expect(rows[1]).toContain("YESTERDAY PROMPT");
    expect(rows[2]).toContain("OLDER PROMPT");
  });

  it("puts same-day prompts under a single heading", async () => {
    const slot = mountPanel(
      withPrompts([recentRow("a", 5, "one"), recentRow("b", 30, "two")]),
    );

    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(2));
    expect(headings(slot.container)).toEqual(["Today"]);
  });
});

describe("filter match highlighting", () => {
  function marks(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("mark")).map((node) =>
      node.textContent ?? "",
    );
  }

  it("marks matches while preserving the original casing", async () => {
    const slot = mountPanel(withPrompts([row("a", 1, "Add a GITIGNORE file")]));
    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(1));
    expect(marks(slot.container)).toHaveLength(0);

    fireEvent.change(slot.getByLabelText("Filter prompts"), {
      target: { value: "gitignore" },
    });

    await waitFor(() => expect(marks(slot.container)).toHaveLength(1));
    // Lowercase query, uppercase source: the row must render its own text.
    expect(marks(slot.container)[0]).toBe("GITIGNORE");
  });

  it("marks every occurrence, not just the first", async () => {
    const slot = mountPanel(withPrompts([row("a", 1, "log the log of the log")]));
    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(1));

    fireEvent.change(slot.getByLabelText("Filter prompts"), {
      target: { value: "log" },
    });

    await waitFor(() => expect(marks(slot.container)).toHaveLength(3));
  });
});

describe("filter clear control", () => {
  it("appears only while filtering, and clears the filter", async () => {
    const slot = mountPanel(
      withPrompts([row("a", 1, "alpha"), row("b", 2, "beta")]),
    );
    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(2));
    expect(slot.queryByRole("button", { name: "Clear filter" })).toBeNull();

    fireEvent.change(slot.getByLabelText("Filter prompts"), {
      target: { value: "alpha" },
    });
    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(1));

    fireEvent.click(slot.getByRole("button", { name: "Clear filter" }));

    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(2));
    expect(slot.queryByRole("button", { name: "Clear filter" })).toBeNull();
  });
});

describe("timestamp semantics", () => {
  it("renders a machine-readable <time> element", async () => {
    const prompt = row("a", 5, "hello");
    const slot = mountPanel(withPrompts([prompt]));
    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(1));

    const time = slot.container.querySelector("time");
    expect(time).not.toBeNull();
    expect(time!.getAttribute("datetime")).toBe(
      new Date(prompt.createdAt).toISOString(),
    );
  });
});

describe("running indicator", () => {
  function indicators(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll('[role="status"]'));
  }

  it("marks the newest prompt while the thread is working", async () => {
    const slot = mountPanel(
      withPrompts([row("new", 1, "NEWEST"), row("old", 60, "OLDER")], true),
    );

    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(2));
    await waitFor(() => expect(indicators(slot.container)).toHaveLength(1));

    // Exactly one marker, and it belongs to the first (newest) row.
    const rows = Array.from(slot.container.querySelectorAll("li"));
    expect(rows[0]!.querySelector('[role="status"]')).not.toBeNull();
    expect(rows[1]!.querySelector('[role="status"]')).toBeNull();
    expect(rows[0]!.textContent).toContain("working");
  });

  it("shows no marker when the thread is idle", async () => {
    const slot = mountPanel(
      withPrompts([row("new", 1, "NEWEST"), row("old", 60, "OLDER")], false),
    );

    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(2));
    expect(indicators(slot.container)).toHaveLength(0);
  });

  it("does not mark a row merely because a filter put it on top", async () => {
    // "OLDER" is the only match, so it becomes the first rendered row — but it
    // is not the prompt being worked on, so it must not be marked.
    const slot = mountPanel(
      withPrompts([row("new", 1, "NEWEST"), row("old", 60, "OLDER")], true),
    );
    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(2));

    fireEvent.change(slot.getByLabelText("Filter prompts"), {
      target: { value: "older" },
    });

    await waitFor(() => expect(renderedRows(slot.container)).toHaveLength(1));
    expect(renderedRows(slot.container)[0]).toContain("OLDER");
    expect(indicators(slot.container)).toHaveLength(0);
  });
});
