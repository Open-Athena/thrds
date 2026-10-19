# thrds (TypeScript)

Declarative thread sync for Slack, Discord, and Bluesky — TS impl.

> The Python impl lives on the [`py` branch][py-branch] (and on PyPI as [`thrds`][pypi]).
> See [`specs/typescript-port.md`][port-spec] for the porting plan.

## Status

**Pre-release** — `core` (diff/edit/post/delete algorithm), `SlackClient`, and `LinkedThread` / `syncLinked` are ported and tested (39 tests). Not yet published to npm.

## Install

```bash
pnpm add @rdub/thrds
```

Published as `@rdub/thrds` rather than `thrds` because npm blocks the unscoped name as "too similar" to the `three` package. The Python package on PyPI remains [`thrds`][pypi].

## Usage

### Slack

```ts
import { SlackClient } from "@rdub/thrds";

const slack = new SlackClient({
  token: "xoxb-...",
  channel: "C0AQC2VKEJF",
  username: "my-bot",
  iconEmoji: ":robot_face:",
});

// Create new thread
const result = await slack.sync({ messages: ["OP", "Reply 1", "Reply 2"] });

// Update existing thread (edits changed messages, appends new, deletes extras)
await slack.sync(
  { messages: ["OP", "Reply 1", "Reply 2"] },
  { threadTs: "1775516040.743629" },
);
```

### Generic

```ts
import { sync } from "@rdub/thrds";
import type { Thread, ThreadClient } from "@rdub/thrds";

const client: ThreadClient = /* your client */;
const result = await sync(client, { messages: ["OP", "Reply"] });
// result.actions: Action[]  (POST / EDIT / DELETE / SKIP per slot)
// result.messageIds: string[]
// result.threadId: string
```

### Linked summary threads

Post summary bullets that link to detail messages in the same Slack thread:

```ts
import { SlackClient } from "@rdub/thrds";
import type { LinkedThread } from "@rdub/thrds";

const slack = new SlackClient({ token: "xoxb-...", channel: "C0..." });
const linked: LinkedThread = {
  summaryPrefix: "# Daily Digest",
  sections: [
    { title: "Topic A", summary: "Brief summary", body: "Full detail text..." },
    { title: "Topic B", summary: "Another summary", body: "More details..." },
  ],
};
const result = await slack.syncLinked(linked, { threadTs: /* optional */ });
```

Two-phase sync: posts all messages with placeholder links, then edits summaries with real permalinks once message ids are known.

## Sync algorithm

Given desired messages `M` and existing thread messages `N`:

1. **Delete** extras from the end (backwards — replies before OP)
2. **Edit** overlapping messages where content changed (skip unchanged)
3. **Post** new messages at the end

Foreign (non-editable) messages — e.g. human replies in a bot thread — are automatically skipped. The sync only operates on the bot's own messages (`message.editable === false` ⇒ preserved in place), leaving everyone else's untouched.

## Test fixtures

`tests/fixtures/sync.json` is shared with the Python impl as the cross-language contract for the sync algorithm. To pull updates from the `py` branch:

```bash
git checkout py -- tests/fixtures/
```

## Publishing

CI on tag `ts-vX.Y.Z` publishes to npm via [OIDC trusted publishing][npm-tp] — no long-lived `NPM_TOKEN` secret. One-time bootstrap (npm doesn't let trusted publishers be configured on a package that doesn't yet exist):

1. Inaugural `npm publish --access public --provenance` from local (after `npm login`).
2. On npmjs.com: package settings → **Trusted Publishers** → add `Open-Athena/thrds`, workflow `release.yml`, environment blank.
3. All subsequent releases via CI.

[py-branch]: https://github.com/Open-Athena/thrds/tree/py
[pypi]: https://pypi.org/project/thrds
[port-spec]: https://github.com/Open-Athena/thrds/blob/py/specs/typescript-port.md
[npm-tp]: https://docs.npmjs.com/trusted-publishers
