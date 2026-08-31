// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
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
function withPrompts(prompts: Row[]): RenderSlotOptions {
  return {
    rpc: { listPrompts: () => ({ prompts }) },
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
          return { prompts: [row("a", 3, "recovered")] };
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

    fireEvent.click(slot.getByText("To composer"));

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
