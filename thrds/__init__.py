from .core import Action, ActionType, EditRateLimited, Image, Message, Msg, OrphanedRepliesError, SenderChangeForbidden, SenderChangePolicy, SyncOptions, SyncResult, Thread, sync
from .discord import NO_MENTIONS, DiscordClient, DiscordHybridClient, DiscordWebhookClient
from .doc import Doc, DocMessage, DocSyncResult, DocThread, Frontmatter
from .linked import LinkedSyncResult, LinkedThread, Section
from .lint import BskyLinter, DiscordLinter, LintIssue, LintReport, MastodonLinter
from .mastodon import MastodonClient
from .protocol import ThreadClient
from .slack import (
    FileNotProcessedError,
    FileSwap,
    FileSwapError,
    FilesNotAttachedError,
    RecoveredSession,
    ScanCapReached,
    SlackApiError,
    SlackClient,
    is_processed,
)
from .state import SessionState, StagingChrome, ThreadEntry, ThreadTarget
from .threadfile import ThreadFile, thread_files, thread_filename

__all__ = [
    "Action",
    "ActionType",
    "BskyLinter",
    "DiscordClient",
    "DiscordHybridClient",
    "DiscordWebhookClient",
    "DiscordLinter",
    "NO_MENTIONS",
    "Doc",
    "DocMessage",
    "DocSyncResult",
    "DocThread",
    "EditRateLimited",
    "Frontmatter",
    "Image",
    "LinkedSyncResult",
    "LinkedThread",
    "LintIssue",
    "LintReport",
    "MastodonClient",
    "MastodonLinter",
    "Message",
    "Msg",
    "OrphanedRepliesError",
    "RecoveredSession",
    "ScanCapReached",
    "Section",
    "SenderChangeForbidden",
    "SenderChangePolicy",
    "SessionState",
    "FileNotProcessedError",
    "FileSwap",
    "FileSwapError",
    "FilesNotAttachedError",
    "SlackApiError",
    "SlackClient",
    "is_processed",
    "StagingChrome",
    "SyncOptions",
    "SyncResult",
    "Thread",
    "ThreadClient",
    "ThreadEntry",
    "ThreadFile",
    "ThreadTarget",
    "sync",
    "thread_filename",
    "thread_files",
]

# BskyClient requires atproto; import lazily
try:
    from .bsky import BskyClient
    __all__.append("BskyClient")
except ImportError:
    pass
