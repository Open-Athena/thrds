"""Wire-level tests for Slack image blocks (`specs/editable-image-blocks.md`).

`SlackClient.post`/`edit` lift trailing `![alt](url)` doc lines into Block
Kit `image` blocks; `_message_markdown` reconstructs the lines on read-back.
Also covers the user-token sender-override guard from the same spec.
"""
from __future__ import annotations

import pytest

from thrds.slack import SlackClient


class _FakeSlackClient(SlackClient):
    """SlackClient stubbing `_request` — records payloads for assertions."""
    def __init__(self, token: str = 'x', **kwargs):
        super().__init__(token=token, channel='C_TARGET', **kwargs)
        self.calls: list[tuple[str, dict]] = []

    def _request(self, endpoint, data=None, method='POST'):
        self.calls.append((endpoint, data))
        if endpoint == 'chat.postMessage':
            return {'ts': '1.000001', 'channel': 'C_TARGET'}
        if endpoint == 'chat.update':
            return {'ts': data.get('ts'), 'channel': data.get('channel')}
        raise NotImplementedError(f'no handler for {endpoint}')


def _payload(client: _FakeSlackClient, endpoint: str) -> dict:
    got_endpoint, data = client.calls[-1]
    assert got_endpoint == endpoint
    return data


CARD = 'https://gcs-usage-icons.pages.dev/card.png'
FOOTER = '→ <#C0T>'


# --- post: lifting ---

def test_post_lifts_trailing_image_into_blocks():
    client = _FakeSlackClient()
    client.post(f'August usage\n\n![usage card]({CARD})')
    data = _payload(client, 'chat.postMessage')
    assert data['text'] == 'August usage'
    assert data['blocks'] == [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': 'August usage'}},
        {'type': 'image', 'image_url': CARD, 'alt_text': 'usage card'},
    ]


def test_post_images_kwarg_matches_content_image_line():
    # `images=[Image(url=…)]` folds into content as a trailing `![alt](url)`
    # line, so it produces the byte-identical payload to the content form.
    from thrds.core import Image

    a = _FakeSlackClient()
    a.post('August usage', images=[Image(url=CARD, alt='usage card')])
    b = _FakeSlackClient()
    b.post(f'August usage\n\n![usage card]({CARD})')
    assert _payload(a, 'chat.postMessage') == _payload(b, 'chat.postMessage')


def test_post_images_kwarg_bust_folds_with_marker():
    from thrds.core import Image

    a = _FakeSlackClient()
    a.post('caption', images=[Image(url=CARD, alt='c', bust=True)])
    b = _FakeSlackClient()
    b.post(f'caption\n\n![c]({CARD}){{bust}}')
    # Both cache-bust: the wire image_url carries a thrds_bust param.
    block_a = _payload(a, 'chat.postMessage')['blocks'][-1]
    block_b = _payload(b, 'chat.postMessage')['blocks'][-1]
    assert block_a['type'] == 'image' and 'thrds_bust=' in block_a['image_url']
    assert block_a.keys() == block_b.keys()


def test_post_body_still_converted_to_mrkdwn():
    client = _FakeSlackClient()
    client.post(f'**August** usage\n\n![card]({CARD})')
    data = _payload(client, 'chat.postMessage')
    assert data['text'] == '*August* usage'
    assert data['blocks'][0] == {
        'type': 'section', 'text': {'type': 'mrkdwn', 'text': '*August* usage'},
    }


def test_post_without_images_sends_no_blocks():
    client = _FakeSlackClient()
    client.post('plain message')
    data = _payload(client, 'chat.postMessage')
    assert data['text'] == 'plain message'
    assert 'blocks' not in data


def test_post_multiple_images_in_order():
    client = _FakeSlackClient()
    client.post(f'body\n\n![a]({CARD})\n\n![b](https://h/b.png)')
    data = _payload(client, 'chat.postMessage')
    assert [b['image_url'] for b in data['blocks'][1:]] == [CARD, 'https://h/b.png']


def test_post_bust_appends_token(monkeypatch):
    monkeypatch.setattr('thrds.slack.bust_token', lambda: '777')
    client = _FakeSlackClient()
    client.post(f'body\n\n![card]({CARD}){{bust}}')
    data = _payload(client, 'chat.postMessage')
    assert data['blocks'][1] == {
        'type': 'image', 'image_url': f'{CARD}?thrds_bust=777', 'alt_text': 'card',
    }


def test_post_raw_mode_does_not_lift():
    client = _FakeSlackClient()
    content = f'body\n\n![card]({CARD})'
    client.post(content, raw=True)
    data = _payload(client, 'chat.postMessage')
    assert data['text'] == content
    assert 'blocks' not in data


def test_post_image_only_message_raises():
    client = _FakeSlackClient()
    with pytest.raises(ValueError, match='only image lines'):
        client.post(f'![card]({CARD})')


def test_post_body_over_section_limit_splits_at_paragraphs():
    # Slack caps each section's text at 3000, not the message: a longer body
    # spans several sections, each whole paragraphs, still one message.
    client = _FakeSlackClient()
    a, b, c = 'a' * 1500, 'b' * 1400, 'c' * 1000
    client.post(f'{a}\n\n{b}\n\n{c}\n\n![card]({CARD})')
    data = _payload(client, 'chat.postMessage')
    assert data['blocks'] == [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': f'{a}\n\n{b}'}},
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': c}},
        {'type': 'image', 'image_url': CARD, 'alt_text': 'card'},
    ]


def test_split_sections_read_back_as_the_posted_content():
    client = _FakeSlackClient()
    content = f"{'a' * 2000}\n\n{'b' * 2000}\n\n![card]({CARD})"
    client.post(content)
    _, data = client.calls[-1]
    assert [b['type'] for b in data['blocks']] == ['section', 'section', 'image']
    assert SlackClient._message_markdown({'text': data['text'], 'blocks': data['blocks']}) == content


def test_post_paragraph_over_section_limit_with_image_raises():
    client = _FakeSlackClient()
    body = 'x' * 3001
    with pytest.raises(ValueError, match='paragraph over'):
        client.post(f'{body}\n\n![card]({CARD})')


def test_post_empty_alt_warns():
    client = _FakeSlackClient()
    with pytest.warns(UserWarning, match='empty alt text'):
        client.post(f'body\n\n![]({CARD})')


# --- edit ---

def test_edit_lifts_trailing_image_into_blocks():
    client = _FakeSlackClient()
    client.edit('1.000001', f'updated body\n\n![card]({CARD})')
    data = _payload(client, 'chat.update')
    assert data['ts'] == '1.000001'
    assert data['text'] == 'updated body'
    assert data['blocks'] == [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': 'updated body'}},
        {'type': 'image', 'image_url': CARD, 'alt_text': 'card'},
    ]


def test_edit_without_images_clears_blocks():
    """Dropping the doc's image line must clear the live image blocks —
    `chat.update` preserves existing blocks unless told otherwise."""
    client = _FakeSlackClient()
    client.edit('1.000001', 'no more image')
    data = _payload(client, 'chat.update')
    assert data['blocks'] == []


def test_edit_raw_mode_leaves_blocks_alone():
    client = _FakeSlackClient()
    client.edit('1.000001', 'wire mrkdwn', raw=True)
    data = _payload(client, 'chat.update')
    assert 'blocks' not in data


def test_edit_refreshes_bust_token(monkeypatch):
    monkeypatch.setattr('thrds.slack.bust_token', lambda: '778')
    client = _FakeSlackClient()
    client.edit('1.000001', f'body v2\n\n![card]({CARD}){{bust}}')
    data = _payload(client, 'chat.update')
    assert data['blocks'][1]['image_url'] == f'{CARD}?thrds_bust=778'


# --- staging-chrome interplay ---

def test_draft_chrome_folds_footer_into_section_with_images():
    client = _FakeSlackClient()
    content = f'Body\n\n![card]({CARD})'
    client._chrome_by_content = {content: FOOTER}
    client.post(content)
    data = _payload(client, 'chat.postMessage')
    assert data['text'] == f'Body\n\n{FOOTER}'
    assert data['blocks'] == [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': f'Body\n\n{FOOTER}'}},
        {'type': 'image', 'image_url': CARD, 'alt_text': 'card'},
    ]


def test_finalized_chrome_context_stays_after_images():
    client = _FakeSlackClient()
    content = f'Body\n\n![card]({CARD})'
    client._chrome_by_content = {content: FOOTER}
    client._finalized_content = {content}
    client.post(content)
    data = _payload(client, 'chat.postMessage')
    assert data['blocks'] == [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': 'Body'}},
        {'type': 'image', 'image_url': CARD, 'alt_text': 'card'},
        {'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': FOOTER}]},
    ]


# --- read-back (`_message_markdown`) ---

def test_message_markdown_reconstructs_image_lines():
    m = {'text': 'Body', 'blocks': [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': 'Body'}},
        {'type': 'image', 'image_url': CARD, 'alt_text': 'usage card'},
    ]}
    assert SlackClient._message_markdown(m) == f'Body\n\n![usage card]({CARD})'


def test_message_markdown_bust_param_round_trips_to_suffix():
    m = {'text': 'Body', 'blocks': [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': 'Body'}},
        {'type': 'image', 'image_url': f'{CARD}?thrds_bust=777', 'alt_text': 'card'},
    ]}
    assert SlackClient._message_markdown(m) == f'Body\n\n![card]({CARD}){{bust}}'


def test_message_markdown_strips_draft_chrome_from_section():
    m = {'text': f'Body\n\n{FOOTER}', 'blocks': [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': f'Body\n\n{FOOTER}'}},
        {'type': 'image', 'image_url': CARD, 'alt_text': 'card'},
    ]}
    assert SlackClient._message_markdown(m) == f'Body\n\n![card]({CARD})'


def test_post_then_readback_round_trips_content():
    """The converge no-op property: what we send reconstructs to exactly what
    the doc says, so the next sync SKIPs instead of editing forever."""
    client = _FakeSlackClient()
    content = f'Monthly usage\n\n![card]({CARD}){{bust}}'
    client.post(content)
    _, data = client.calls[-1]
    m = {'text': data['text'], 'blocks': data['blocks']}
    assert SlackClient._message_markdown(m) == content


# --- user-token sender-override guard ---

def test_user_token_sender_override_raises():
    client = _FakeSlackClient(token='xoxp-123')
    with pytest.raises(ValueError, match='requires a bot token'):
        client.post('hello', username='Digest Bot')
    assert client.calls == []


def test_user_token_client_default_icon_raises():
    client = _FakeSlackClient(token='xoxp-123', icon_url='https://h/i.png')
    with pytest.raises(ValueError, match='requires a bot token'):
        client.post('hello')


def test_user_token_plain_post_ok():
    client = _FakeSlackClient(token='xoxp-123')
    client.post('hello')
    data = _payload(client, 'chat.postMessage')
    assert data['text'] == 'hello'


def test_bot_token_sender_override_ok():
    client = _FakeSlackClient(token='xoxb-123')
    client.post('hello', username='Digest Bot', icon_emoji=':chart:')
    data = _payload(client, 'chat.postMessage')
    assert data['username'] == 'Digest Bot'
    assert data['icon_emoji'] == ':chart:'
