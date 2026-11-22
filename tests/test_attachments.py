"""Unified image attachments: `Image` + `Msg.images`.

`Msg(content, images=[Image(...)])` carries attachments through `core.sync` to
POST and (when an edit fires) EDIT. A hosted `url` is the cross-platform
currency; Discord's webhook and (since `specs/done/slack-lazy-image-upload.md`) Slack
both upload local bytes. Only the Discord *bot* API and Bluesky can't, so they
raise on non-empty `images`. See `specs/unified-image-attachments.md`.
"""
from __future__ import annotations

import pytest

from thrds.core import Image, Msg, _images, _post_kwargs


def test_image_needs_url_or_path():
    with pytest.raises(ValueError, match="needs a `url` or a `path`"):
        Image()


def test_image_bust_needs_url():
    with pytest.raises(ValueError, match="cache-busts a `url`"):
        Image(path="/x/p.png", bust=True)


def test_post_kwargs_carries_images_from_msg():
    im = Image(url="https://x/p.png", alt="plot")
    kw = _post_kwargs(Msg("body", username="A", images=[im]))
    assert kw == {
        "username": "A",
        "icon_url": None,
        "icon_emoji": None,
        "images": [im],
    }


def test_bare_str_entry_has_no_images():
    assert _post_kwargs("body") == {}
    assert _images("body") == ()


def test_images_helper_reads_msg_attachments():
    im = Image(path="/x/p.png")
    assert _images(Msg("body", images=[im])) == [im]
    assert _images(Msg("body")) == ()


def test_slack_rejects_non_image_suffix(tmp_path):
    # Slack uploads local bytes now (see test_slack_upload.py), but only image
    # formats it accepts; a non-image suffix raises before any upload.
    from thrds.slack import SlackClient

    pdf = tmp_path / "doc.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    client = SlackClient("xoxb-tok", "CHAN")
    with pytest.raises(ValueError, match="supports"):
        client.post("body", images=[Image(path=pdf)])


def test_discord_bot_post_rejects_images():
    from thrds.discord import DiscordClient

    client = DiscordClient("bot-tok", "CHAN", "GUILD")
    with pytest.raises(NotImplementedError, match="webhook transport"):
        client.post("body", images=[Image(url="https://x/p.png")])


def test_discord_bot_edit_rejects_images():
    from thrds.discord import DiscordClient

    client = DiscordClient("bot-tok", "CHAN", "GUILD")
    with pytest.raises(NotImplementedError, match="webhook transport"):
        client.edit("m1", "body", images=[Image(url="https://x/p.png")])


def test_bsky_post_rejects_images():
    pytest.importorskip("atproto")  # Bluesky client requires the optional extra
    from thrds.bsky import BskyClient

    client = BskyClient.__new__(BskyClient)  # skip login; the raise precedes any client use
    with pytest.raises(NotImplementedError, match="image embeds aren't wired"):
        client.post("body", images=[Image(url="https://x/p.png")])
