"""Wire-level tests for Slack image blocks (`specs/editable-image-blocks.md`).

`SlackClient.post`/`edit` lift trailing `![alt](url)` doc lines into Block
Kit `image` blocks; `_message_markdown` reconstructs the lines on read-back.
Also covers the user-token sender-override guard from the same spec.
"""
from __future__ import annotations

import json

import pytest

from thrds.slack import SLACK_MESSAGE_LIMIT, SlackApiError, SlackClient, fallback_text, request_shape, section_blocks


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


def test_post_line_over_section_limit_with_image_raises():
    client = _FakeSlackClient()
    body = 'x' * 3001
    with pytest.raises(ValueError, match=r"^Message body has a line over Slack's 3000-char section limit \(3001 chars\)$"):
        client.post(f'{body}\n\n![card]({CARD})')


def test_post_paragraph_over_section_limit_splits_at_lines():
    # Outside a staging sync, a paragraph over the section limit splits at its line breaks.
    client = _FakeSlackClient()
    rows = [f'{i:02d}' + 'r' * 97 for i in range(40)]
    client.post('\n'.join(rows) + f'\n\n![card]({CARD})')
    data = _payload(client, 'chat.postMessage')
    assert data['blocks'] == [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': '\n'.join(rows[:30])}},
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': '\n'.join(rows[30:])}},
        {'type': 'image', 'image_url': CARD, 'alt_text': 'card'},
    ]


def test_sync_paragraph_over_section_limit_raises():
    # In a staging sync the pull reads the message back into the doc, where a line split would become a paragraph break.
    client = _FakeSlackClient()
    client._chrome_by_content = {}
    rows = [f'{i:02d}' + 'r' * 97 for i in range(40)]
    with pytest.raises(ValueError, match=r"^Message body has a paragraph over Slack's 3000-char section limit \(3999 chars\); break it with a blank line or shorten it$"):
        client.post('\n'.join(rows) + f'\n\n![card]({CARD})')


def _texts(blocks: list[dict]) -> list[str]:
    assert {b['type'] for b in blocks} == {'section'}
    return [b['text']['text'] for b in blocks]


def test_section_blocks_lines_splits_a_long_paragraph_at_line_breaks():
    # 40 lines of 99 chars (+ '\n') = 3999 chars, one paragraph: 30 lines fill a section (2999 chars).
    rows = [f'{i:02d}' + 'r' * 97 for i in range(40)]
    para = '\n'.join(rows)
    with pytest.raises(ValueError, match=r"^Message body has a paragraph over Slack's 3000-char section limit \(3999 chars\); break it with a blank line or shorten it$"):
        section_blocks(para)
    assert _texts(section_blocks(para, lines=True)) == ['\n'.join(rows[:30]), '\n'.join(rows[30:])]


def test_section_blocks_lines_keeps_paragraph_packing():
    # Paragraphs that fit pack at blank lines exactly as without `lines`; the line-split one's last piece can
    # take a following short paragraph.
    rows = [f'{i:02d}' + 'r' * 97 for i in range(40)]
    head, tail = 'h' * 100, 't' * 100
    text = '\n\n'.join([head, '\n'.join(rows), tail])
    assert _texts(section_blocks(text, lines=True)) == [
        head,
        '\n'.join(rows[:30]),
        '\n'.join(rows[30:]) + '\n\n' + tail,
    ]
    short = f'{head}\n\n{tail}'
    assert section_blocks(short, lines=True) == section_blocks(short)


def test_section_blocks_lines_raises_on_a_single_long_line():
    with pytest.raises(ValueError, match=r"^Message body has a line over Slack's 3000-char section limit \(3001 chars\)$"):
        section_blocks('ok\n' + 'x' * 3001, lines=True)


# --- the flat `text` beside blocks: Slack caps it at 4,000 (`msg_too_long`) whatever the blocks ---

# Two paragraphs of 30 lines × 70 chars (2,129 chars each): 4,260 chars, each paragraph its own section.
ROWS = [f'{i:02d} ' + 'p' * 67 for i in range(60)]
LONG = '\n'.join(ROWS[:30]) + '\n\n' + '\n'.join(ROWS[30:])


def test_fallback_text_cuts_at_a_line():
    assert fallback_text('short') == 'short'
    exact = 'x' * SLACK_MESSAGE_LIMIT
    assert fallback_text(exact) == exact
    # 56 whole lines fit in 3,976 chars, leaving room for '\n…'; the 57th would end past 3,998.
    capped = fallback_text(LONG)
    assert capped == '\n'.join(ROWS[:30]) + '\n\n' + '\n'.join(ROWS[30:56]) + '\n…'
    assert len(capped) == 3978
    # A line over the cap is cut within it.
    assert fallback_text('y' * 5000) == 'y' * (SLACK_MESSAGE_LIMIT - 1) + '…'


def test_post_with_image_caps_the_fallback_text():
    client = _FakeSlackClient()
    client.post(f'{LONG}\n\n![card]({CARD})')
    data = _payload(client, 'chat.postMessage')
    assert data['text'] == fallback_text(LONG)
    assert data['blocks'] == [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': '\n'.join(ROWS[:30])}},
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': '\n'.join(ROWS[30:])}},
        {'type': 'image', 'image_url': CARD, 'alt_text': 'card'},
    ]
    # The blocks keep the whole body, and read back as the posted content.
    assert SlackClient._message_markdown({'text': data['text'], 'blocks': data['blocks']}) == f'{LONG}\n\n![card]({CARD})'


def test_edit_with_image_caps_the_fallback_text():
    client = _FakeSlackClient()
    client.edit('1.000001', f'{LONG}\n\n![card]({CARD})')
    data = _payload(client, 'chat.update')
    assert data['text'] == fallback_text(LONG)
    assert [b['text']['text'] for b in data['blocks'][:2]] == ['\n'.join(ROWS[:30]), '\n'.join(ROWS[30:])]


def test_fallback_text_within_the_limit_is_the_whole_wire():
    client = _FakeSlackClient()
    body = '\n'.join(ROWS[:30])
    client.edit('1.000001', f'{body}\n\n![card]({CARD})')
    assert _payload(client, 'chat.update')['text'] == body


LONG_SECTIONS = [
    {'type': 'section', 'text': {'type': 'mrkdwn', 'text': '\n'.join(ROWS[:30])}},
    {'type': 'section', 'text': {'type': 'mrkdwn', 'text': '\n'.join(ROWS[30:])}},
]


def test_text_only_over_the_limit_goes_out_as_sections():
    # The same path as a message with images: sections carry the body, `text` is the capped fallback.
    client = _FakeSlackClient()
    client.edit('1.000001', LONG)
    data = _payload(client, 'chat.update')
    assert (data['text'], data['blocks']) == (fallback_text(LONG), LONG_SECTIONS)
    assert SlackClient._message_markdown({'text': data['text'], 'blocks': data['blocks']}) == LONG
    client.post(LONG, thread_id='1.0')
    data = _payload(client, 'chat.postMessage')
    assert (data['text'], data['blocks'], data['thread_ts']) == (fallback_text(LONG), LONG_SECTIONS, '1.0')


def test_raw_text_over_the_limit_goes_out_as_sections():
    client = _FakeSlackClient()
    client.edit('1.000001', LONG, raw=True)
    data = _payload(client, 'chat.update')
    assert (data['text'], data['blocks']) == (fallback_text(LONG), LONG_SECTIONS)


def test_text_only_within_the_limit_stays_text():
    client = _FakeSlackClient()
    body = '\n'.join(ROWS[:56])
    client.edit('1.000001', body)
    data = _payload(client, 'chat.update')
    assert (data['text'], data['blocks']) == (body, [])


def test_text_only_over_the_block_limit_raises():
    client = _FakeSlackClient()
    body = '\n\n'.join('q' * 2999 for _ in range(51))
    with pytest.raises(ValueError, match=r"^Message has 51 blocks, over Slack's 50$"):
        client.post(body)


def _refusing(monkeypatch, error: str) -> None:
    """Slack answers every request ``{"ok": false, "error": error}``."""
    class _R:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return json.dumps({'ok': False, 'error': error}).encode()
    monkeypatch.setattr('thrds.slack.urllib.request.urlopen', lambda req, *a, **k: _R())


def test_slack_api_error_carries_the_request_shape(monkeypatch):
    _refusing(monkeypatch, 'msg_too_long')
    client = SlackClient(token='xoxb-x', channel='C1')
    with pytest.raises(SlackApiError) as e:
        client.edit('1.0', f'{LONG}\n\n![card]({CARD})')
    assert (e.value.endpoint, e.value.code, e.value.shape, str(e.value)) == (
        'chat.update',
        'msg_too_long',
        'text 3978 chars, 3 blocks, longest section 2129 chars',
        'Slack API error: msg_too_long (chat.update: text 3978 chars, 3 blocks, longest section 2129 chars)',
    )
    with pytest.raises(SlackApiError) as e:
        client.post('short', raw=True)
    assert (e.value.shape, str(e.value)) == (
        'text 5 chars',
        'Slack API error: msg_too_long (chat.postMessage: text 5 chars)',
    )


def test_slack_api_error_without_a_message_has_no_shape(monkeypatch):
    _refusing(monkeypatch, 'message_not_found')
    with pytest.raises(SlackApiError) as e:
        SlackClient(token='xoxb-x', channel='C1')._request('chat.delete', {'channel': 'C1', 'ts': '1.0'})
    assert (e.value.shape, str(e.value)) == (None, 'Slack API error: message_not_found')


def test_request_shape():
    assert request_shape(None) is None
    assert request_shape({'channel': 'C1'}) is None
    assert request_shape({'text': 'abc', 'blocks': []}) == 'text 3 chars, 0 blocks'
    assert request_shape({'blocks': [{'type': 'image'}, {'type': 'section', 'text': {'type': 'mrkdwn', 'text': 'xy'}}]}) == '2 blocks, longest section 2 chars'


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
