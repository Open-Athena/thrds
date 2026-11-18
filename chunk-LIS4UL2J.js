import {
  hash53,
  stableStringify
} from "./chunk-YSTFV535.js";

// src/core.ts
var EditRateLimited = class extends Error {
  constructor(message) {
    super(message ?? "edit rate limited");
    this.name = "EditRateLimited";
  }
};
var OrphanedRepliesError = class extends Error {
  constructor(messageId, replyCount) {
    super(
      `Refusing to delete message ${messageId}: it has ${replyCount} thread replies that would be orphaned. Pass orphansOk=true to delete anyway.`
    );
    this.messageId = messageId;
    this.replyCount = replyCount;
    this.name = "OrphanedRepliesError";
  }
  messageId;
  replyCount;
};
var toMsg = (m) => typeof m === "string" ? { text: m } : m;
var THRDS_HASH = "thrds_hash";
function msgHash(m) {
  const msg = toMsg(m);
  const payload = msg.metadata ? { ...msg.metadata.event_payload } : void 0;
  if (payload) delete payload[THRDS_HASH];
  return hash53(
    stableStringify({
      text: msg.text,
      blocks: msg.blocks,
      metadata: msg.metadata ? { event_type: msg.metadata.event_type, event_payload: payload } : void 0
    })
  );
}
var isRich = (m) => typeof m !== "string" && (m.blocks !== void 0 || m.metadata !== void 0);
var contentKey = (m) => isRich(m) ? `thrds:${msgHash(m)}` : toMsg(m).text;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function sync(client, desired, threadId, options = {}) {
  const { dryRun = false, pace = 0, jitter = 0 } = options;
  const actions = [];
  const messageIds = [];
  let mutated = false;
  const doPace = async () => {
    if (mutated && pace > 0) {
      const delay = pace + Math.random() * jitter;
      await sleep(delay * 1e3);
    }
    mutated = true;
  };
  const allExisting = threadId !== void 0 ? await client.list(threadId) : [];
  const existing = allExisting.filter((m) => m.editable !== false);
  const M = desired.messages.length;
  const N = existing.length;
  if (M < N) {
    for (let i = N - 1; i >= M; i--) {
      const msg = existing[i];
      actions.push({
        type: "DELETE",
        index: i,
        messageId: msg.id,
        priorContent: msg.content
      });
      if (!dryRun) {
        await doPace();
        await client.delete(msg.id);
      }
    }
  }
  const overlap = Math.min(M, N);
  let repostFrom = null;
  for (let i = 0; i < overlap; i++) {
    const ex = existing[i];
    const want = desired.messages[i];
    if ((ex.key ?? ex.content) === contentKey(want)) {
      actions.push({
        type: "SKIP",
        index: i,
        messageId: ex.id,
        content: toMsg(want).text
      });
      messageIds.push(ex.id);
      continue;
    }
    actions.push({
      type: "EDIT",
      index: i,
      messageId: ex.id,
      content: toMsg(want).text,
      priorContent: ex.content
    });
    if (dryRun) {
      messageIds.push(ex.id);
      continue;
    }
    try {
      await doPace();
      const result = await client.edit(ex.id, want);
      messageIds.push(result.id);
    } catch (e) {
      if (e instanceof EditRateLimited) {
        repostFrom = i;
        break;
      }
      throw e;
    }
  }
  if (repostFrom !== null) {
    for (let j = overlap - 1; j >= repostFrom; j--) {
      const msg = existing[j];
      actions.push({
        type: "DELETE",
        index: j,
        messageId: msg.id,
        priorContent: msg.content
      });
      await doPace();
      await client.delete(msg.id);
    }
    for (let j = repostFrom; j < M; j++) {
      const want = desired.messages[j];
      actions.push({ type: "POST", index: j, content: toMsg(want).text });
      await doPace();
      const result = await client.post(want, threadId);
      messageIds.push(result.id);
    }
    return {
      threadId: threadId ?? "",
      messageIds,
      actions
    };
  }
  let finalThreadId = threadId;
  if (M > N) {
    let start = N;
    if (threadId === void 0 && N === 0) {
      const want = desired.messages[0];
      actions.push({ type: "POST", index: 0, content: toMsg(want).text });
      if (dryRun) {
        messageIds.push("<new>");
        finalThreadId = "<new>";
      } else {
        await doPace();
        const result = await client.post(want);
        finalThreadId = result.id;
        messageIds.push(result.id);
      }
      start = 1;
    }
    for (let i = start; i < M; i++) {
      const want = desired.messages[i];
      actions.push({ type: "POST", index: i, content: toMsg(want).text });
      if (dryRun) {
        messageIds.push("<new>");
      } else {
        await doPace();
        const result = await client.post(want, finalThreadId);
        messageIds.push(result.id);
      }
    }
  }
  return {
    threadId: finalThreadId ?? "",
    messageIds,
    actions
  };
}

export {
  EditRateLimited,
  OrphanedRepliesError,
  toMsg,
  THRDS_HASH,
  msgHash,
  isRich,
  contentKey,
  sync
};
//# sourceMappingURL=chunk-LIS4UL2J.js.map