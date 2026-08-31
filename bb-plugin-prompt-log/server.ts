// bb-plugin-prompt-log — backend entry.
//
// One job: expose this thread's submitted prompts to the Prompts side panel,
// and tell the panel when to refetch.
//
// Reading the prompts is `bb.sdk.threads.promptHistory`, which returns only
// user-submitted prompts — no assistant output and no tool calls — so no
// filtering of agent content is needed here.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PROMPTS_CHANGED_CHANNEL } from "./shared.js";

/**
 * A prompt-history record as the SDK returns it, derived from the SDK's own
 * declaration rather than restated here, so a shape change surfaces as a
 * type error instead of a silent mismatch at runtime.
 */
type PromptHistoryRecord = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["promptHistory"]>
>[number];

/**
 * One prompt flattened for the panel: the text the user typed, plus a count of
 * parts that have no text to show (images, file attachments, and any part type
 * a future BB adds). Flattening on the server keeps the RPC output schema flat
 * and strict, and keeps the panel out of the business of knowing the
 * structured-input union.
 */
const promptSchema = z
  .object({
    id: z.string(),
    createdAt: z.number(),
    text: z.string(),
    extraPartCount: z.number().int().min(0),
  })
  .strict();

export type LoggedPrompt = z.infer<typeof promptSchema>;

// Both schemas run at the wire boundary. app.tsx imports only this type.
export const rpcContract = defineRpcContract({
  listPrompts: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ prompts: z.array(promptSchema) }).strict(),
  },
});

/**
 * Reduce a history record to the row the panel renders.
 *
 * `input` is an array of structured parts. Text parts marked
 * `visibility: "agent-only"` are context BB injected for the agent (resolved
 * @-mentions, for example) rather than words the user typed, so they are
 * skipped: including them would bury the actual request. Every non-text part
 * is counted instead of dropped, so a prompt that was only an image still
 * renders as a row that says so rather than as a blank entry.
 */
function flattenPrompt(record: PromptHistoryRecord): LoggedPrompt {
  const texts: string[] = [];
  let extraPartCount = 0;

  for (const part of record.input) {
    if (part.type === "text") {
      if (part.visibility !== "agent-only") texts.push(part.text);
      continue;
    }
    extraPartCount += 1;
  }

  return {
    id: record.id,
    createdAt: record.createdAt,
    text: texts.join("\n\n").trim(),
    extraPartCount,
  };
}

export default function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  bb.rpc.register(rpcContract, {
    // bb.sdk is bind-gated, so it is read here in the handler rather than in
    // the factory body.
    listPrompts: async ({ threadId }) => {
      const records = await bb.sdk.threads.promptHistory({ threadId });
      return { prompts: records.map(flattenPrompt) };
    },
  });

  // Tell every open panel that a thread's prompt list may have changed. The
  // signal is a bare invalidation — the panel refetches over RPC — so nothing
  // here needs to know what was sent.
  function publishChanged(threadId: string): void {
    bb.log.debug(`publishing ${PROMPTS_CHANGED_CHANNEL} for ${threadId}`);
    bb.realtime.publish(PROMPTS_CHANGED_CHANNEL, { threadId });
  }

  // Two of BB's six thread lifecycle events, for two different cases:
  //
  // - thread.active fires when a thread enters the running state, which is
  //   what submitting a prompt to an idle thread does. This is the normal
  //   path and makes a new prompt appear immediately.
  // - thread.idle fires at the end of a turn, and catches prompts that were
  //   queued or steered into an ALREADY-running turn. Those add rows to the
  //   history without producing a new active transition, so without this the
  //   list would miss them until the next manual refresh.
  bb.events.on("thread.active", ({ thread }) => publishChanged(thread.id));
  bb.events.on("thread.idle", ({ thread }) => publishChanged(thread.id));

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
