from __future__ import annotations

from collections.abc import Sequence

from .core import EditRateLimited, Image, Message, SyncOptions, SyncResult, Thread, sync

try:
    from atproto import Client as AtClient
    from atproto_client.models.app.bsky.feed.post import ReplyRef
    from atproto_client.models.app.bsky.feed.defs import ThreadViewPost
    from atproto_client.models.com.atproto.repo.strong_ref import Main as StrongRef
except ImportError as e:
    raise ImportError(
        "Bluesky support requires the 'atproto' package. "
        "Install it with: pip install thrds[bsky]"
    ) from e

POST_LIMIT = 300


class BskyClient:
    """Bluesky ThreadClient implementation using AT Protocol.

    Bluesky has no edit API, so `edit()` raises `EditRateLimited`
    to trigger the sync algorithm's delete+repost fallback.
    """

    def __init__(self, client: AtClient | None = None, handle: str | None = None, password: str | None = None):
        """Initialize with an already-logged-in client, or handle+password to create one."""
        if client is not None:
            self._client = client
        elif handle and password:
            self._client = AtClient()
            self._client.login(handle, password)
        else:
            raise ValueError("Provide either a logged-in `client` or `handle` + `password`")

    @property
    def did(self) -> str:
        return self._client.me.did

    def list_messages(self, thread_id: str) -> list[Message]:
        """Fetch thread posts in chronological order. thread_id = root post URI."""
        resp = self._client.get_post_thread(uri=thread_id, depth=100)
        posts: list[Message] = []
        self._collect_thread(resp.thread, posts)
        return posts

    def _collect_thread(self, node: ThreadViewPost, out: list[Message]) -> None:
        """Recursively collect thread posts in chronological order (DFS, parent before children)."""
        if not hasattr(node, 'post'):
            return
        text = node.post.record.text if hasattr(node.post.record, 'text') else ''
        out.append(Message(id=node.post.uri, content=text))
        if hasattr(node, 'replies') and node.replies:
            # Sort replies chronologically
            replies = sorted(node.replies, key=lambda r: r.post.indexed_at if hasattr(r, 'post') else '')
            # Only follow replies from the same author (our thread, not other people's replies)
            for reply in replies:
                if hasattr(reply, 'post') and reply.post.author.did == self.did:
                    self._collect_thread(reply, out)

    def post(
        self,
        content: str,
        thread_id: str | None = None,
        *,
        username: str | None = None,
        icon_url: str | None = None,
        icon_emoji: str | None = None,
        images: Sequence[Image] = (),
        broadcast: bool = False,
    ) -> Message:
        """Create a post. If thread_id is given, reply to the root post.

        Sender-override fields (username/icon_url/icon_emoji) exist for
        `ThreadClient` protocol parity, but Bluesky has no per-message sender
        concept — so any non-None value **raises** rather than being silently
        dropped (a caller asking for a sender it can't get should know).

        ``broadcast`` is Slack's `reply_broadcast` (`SlackClient.post`); Bluesky
        has no analogue, so ``broadcast=True`` **raises** rather than posting a
        reply the caller believes is also surfaced somewhere it isn't."""
        if broadcast:
            raise NotImplementedError(
                "Bluesky has no `reply_broadcast` analogue (`broadcast=` is "
                "Slack-specific)."
            )
        if username is not None or icon_url is not None or icon_emoji is not None:
            raise NotImplementedError(
                "Bluesky has no per-message sender concept "
                "(username/icon_url/icon_emoji cannot be honored)."
            )
        if images:
            raise NotImplementedError(
                "Bluesky image embeds aren't wired in this client "
                "(`images=` is unsupported)."
            )
        if len(content) > POST_LIMIT:
            raise ValueError(f"Post exceeds Bluesky's {POST_LIMIT} char limit ({len(content)} chars)")

        if thread_id is None:
            resp = self._client.send_post(text=content)
        else:
            # Get root post for ReplyRef
            root_resp = self._client.get_post_thread(uri=thread_id, depth=0)
            root_post = root_resp.thread.post
            root_ref = StrongRef(uri=root_post.uri, cid=root_post.cid)
            # For flat threads, parent = root (all replies are direct children of OP)
            reply_to = ReplyRef(root=root_ref, parent=root_ref)
            resp = self._client.send_post(text=content, reply_to=reply_to)

        return Message(id=resp.uri, content=content)

    def edit(self, message_id: str, content: str, *, images: Sequence[Image] = ()) -> Message:
        """Bluesky doesn't support editing. Trigger delete+repost fallback."""
        raise EditRateLimited("Bluesky does not support editing posts")

    def delete(self, message_id: str) -> None:
        """Delete a post by AT URI."""
        # URI format: at://did:plc:xxx/app.bsky.feed.post/rkey
        parts = message_id.split('/')
        rkey = parts[-1]
        self._client.delete_post(rkey)

    def sync(
        self,
        thread: Thread,
        thread_id: str | None = None,
        dry_run: bool = False,
        pace: float = 0.5,
        jitter: float = 0.0,
    ) -> SyncResult:
        """Sync a thread to the desired state.

        Default pace is 0.5s between operations (Bluesky rate limits
        are stricter than Slack/Discord).
        """
        return sync(
            client=self,
            desired=thread,
            thread_id=thread_id,
            options=SyncOptions(
                dry_run=dry_run,
                pace=pace,
                jitter=jitter,
            ),
        )
