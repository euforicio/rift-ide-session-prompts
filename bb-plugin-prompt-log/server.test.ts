import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { PROMPTS_CHANGED_CHANNEL } from "./shared.js";

/** Build a prompt-history record the way the SDK returns one. */
function record(
  id: string,
  createdAt: number,
  input: Array<Record<string, unknown>>,
) {
  return { id, createdAt, input };
}

function hostWithHistory(records: ReturnType<typeof record>[]) {
  return createFakePluginHost({
    pluginId: "prompt-log",
    sdk: {
      threads: {
        promptHistory: async () => records,
      },
    },
  });
}

describe("listPrompts", () => {
  it("flattens text parts and reports the thread's prompts", async () => {
    const { bb, harness } = hostWithHistory([
      record("phist_a", 1_000, [
        { type: "text", text: "first", mentions: [] },
        { type: "text", text: "second", mentions: [] },
      ]),
    ]);
    await plugin(bb);

    const result = await harness.behavior.callRpc("listPrompts", {
      threadId: "thr_1",
    });

    expect(result).toEqual({
      prompts: [
        {
          id: "phist_a",
          createdAt: 1_000,
          text: "first\n\nsecond",
          extraPartCount: 0,
        },
      ],
    });
  });

  it("skips agent-only text, which is injected context rather than typed words", async () => {
    const { bb, harness } = hostWithHistory([
      record("phist_a", 1_000, [
        { type: "text", text: "what I typed", mentions: [] },
        {
          type: "text",
          text: "<resolved mention context>",
          mentions: [],
          visibility: "agent-only",
        },
      ]),
    ]);
    await plugin(bb);

    const result = (await harness.behavior.callRpc("listPrompts", {
      threadId: "thr_1",
    })) as { prompts: Array<{ text: string; extraPartCount: number }> };

    expect(result.prompts[0]!.text).toBe("what I typed");
    // Agent-only text is not an attachment, so it must not inflate the count.
    expect(result.prompts[0]!.extraPartCount).toBe(0);
  });

  it("counts non-text parts instead of dropping them, so an image-only prompt still renders", async () => {
    const { bb, harness } = hostWithHistory([
      record("phist_a", 1_000, [
        { type: "localImage", path: "shot.png" },
        { type: "localFile", path: "log.txt" },
      ]),
    ]);
    await plugin(bb);

    const result = (await harness.behavior.callRpc("listPrompts", {
      threadId: "thr_1",
    })) as { prompts: Array<{ text: string; extraPartCount: number }> };

    expect(result.prompts[0]!.text).toBe("");
    expect(result.prompts[0]!.extraPartCount).toBe(2);
  });

  it("passes the requested thread through to the SDK", async () => {
    const { bb, harness } = hostWithHistory([]);
    await plugin(bb);

    await harness.behavior.callRpc("listPrompts", { threadId: "thr_target" });

    // callsTo returns one argument-array per call.
    const calls = harness.inspection.sdk.callsTo("threads.promptHistory");
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({ threadId: "thr_target" });
  });
});

describe("live updates", () => {
  it("publishes an invalidation when a thread goes active (a prompt was submitted)", async () => {
    const { bb, harness } = hostWithHistory([]);
    await plugin(bb);

    await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_9" }),
    });

    expect(harness.realtimeSignals).toEqual([
      { channel: PROMPTS_CHANGED_CHANNEL, payload: { threadId: "thr_9" } },
    ]);
  });

  it("also publishes on idle, which catches prompts queued into a running turn", async () => {
    const { bb, harness } = hostWithHistory([]);
    await plugin(bb);

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_9" }),
      lastAssistantText: "done",
    });

    expect(harness.realtimeSignals).toEqual([
      { channel: PROMPTS_CHANGED_CHANNEL, payload: { threadId: "thr_9" } },
    ]);
  });

  it("carries the thread id so a panel can ignore other threads' signals", async () => {
    const { bb, harness } = hostWithHistory([]);
    await plugin(bb);

    await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_other" }),
    });

    expect(harness.realtimeSignals[0]!.payload).toEqual({
      threadId: "thr_other",
    });
  });
});
