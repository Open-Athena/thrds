from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from .core import Image, Message


class ThreadClient(Protocol):
    def list_messages(self, thread_id: str) -> list[Message]: ...
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
    ) -> Message: ...
    def edit(
        self,
        message_id: str,
        content: str,
        *,
        images: Sequence[Image] = (),
    ) -> Message: ...
    def delete(self, message_id: str) -> None: ...
