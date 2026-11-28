"""Tests for `SlackClient(raw=)` / `post(raw=)` / `edit(raw=)` passthrough
(``specs/done/raw-mrkdwn-passthrough.md``).

Content that's already Slack mrkdwn (``<url|text>``, ``*bold*``, ``_italic_``,
``:emoji:``) gets mangled by ``to_slack()``'s md→mrkdwn conversion — the
single-``*`` ``*173*`` becomes ``_173_`` because mrkdwn bold reads as md italic.
``raw=True`` bypasses that conversion; the wire ``text`` is byte-identical to
``content``. Resolution precedence: per-call kwarg > client default > False.
"""
from __future__ import annotations

from thrds.slack import SlackClient


class _FakeSlackClient(SlackClient):
    """SlackClient stubbing `_request` — records the last payload."""
    def __init__(self, **kwargs):
        super().__init__(token='x', channel='C_TARGET', **kwargs)
        self.calls: list[tuple[str, dict]] = []

    def _request(self, endpoint, data=None, method='POST'):
        self.calls.append((endpoint, data))
        if endpoint == 'chat.postMessage':
            return {'ts': '1.000001', 'channel': 'C_TARGET'}
        if endpoint == 'chat.update':
            return {'ts': data.get('ts'), 'channel': data.get('channel')}
        raise NotImplementedError(f'no handler for {endpoint}')


def _wire(client: _FakeSlackClient) -> str:
    """Return the last chat.* payload's `text` field."""
    _endpoint, data = client.calls[-1]
    return data['text']


# `[a](b)` + `*x*` — mrkdwn-hostile string. Under `to_slack`, `[a](b)` becomes
# `<b|a>` and `*x*` becomes `_x_`; raw passes it through byte-identical.
_MRKDWN_HOSTILE = '<https://ex.com|link> *bold*'
_MRKDWN_CONVERTED = '<<https://ex.com|link>|<https://ex.com|link>> _bold_'
# md-flavored input that IS meant to be converted — used to prove `raw=False`
# still runs the conversion when overriding a `raw=True` client default.
_MD_INPUT = '[link](https://ex.com) **bold**'
_MD_CONVERTED = '<https://ex.com|link> *bold*'


# --- baseline: default (raw=False) still converts ---

def test_post_default_still_converts():
    """No client default + no per-call → wire runs through `to_slack`."""
    client = _FakeSlackClient()
    client.post(_MD_INPUT)
    assert _wire(client) == _MD_CONVERTED


def test_edit_default_still_converts():
    """Same for edit — default preserves today's behavior."""
    client = _FakeSlackClient()
    client.edit('1.000001', _MD_INPUT)
    assert _wire(client) == _MD_CONVERTED


# --- per-call raw=True forces verbatim ---

def test_post_raw_true_sends_verbatim():
    """`post(text, raw=True)` → wire text byte-identical to content."""
    client = _FakeSlackClient()
    client.post(_MRKDWN_HOSTILE, raw=True)
    assert _wire(client) == _MRKDWN_HOSTILE


def test_edit_raw_true_sends_verbatim():
    """`edit(id, text, raw=True)` → wire text byte-identical to content."""
    client = _FakeSlackClient()
    client.edit('1.000001', _MRKDWN_HOSTILE, raw=True)
    assert _wire(client) == _MRKDWN_HOSTILE


# --- client-wide default ---

def test_client_default_raw_true_applies_to_post():
    """`SlackClient(raw=True)` + `post(x)` → raw (client default wins)."""
    client = _FakeSlackClient(raw=True)
    client.post(_MRKDWN_HOSTILE)
    assert _wire(client) == _MRKDWN_HOSTILE


def test_client_default_raw_true_applies_to_edit():
    client = _FakeSlackClient(raw=True)
    client.edit('1.000001', _MRKDWN_HOSTILE)
    assert _wire(client) == _MRKDWN_HOSTILE


# --- per-call override wins over client default ---

def test_post_raw_false_overrides_client_raw_true():
    """`SlackClient(raw=True)` + `post(x, raw=False)` → converted (call wins)."""
    client = _FakeSlackClient(raw=True)
    client.post(_MD_INPUT, raw=False)
    assert _wire(client) == _MD_CONVERTED


def test_edit_raw_false_overrides_client_raw_true():
    client = _FakeSlackClient(raw=True)
    client.edit('1.000001', _MD_INPUT, raw=False)
    assert _wire(client) == _MD_CONVERTED


def test_post_raw_true_overrides_client_raw_false():
    """Symmetric: `SlackClient(raw=False)` + `post(x, raw=True)` → raw."""
    client = _FakeSlackClient(raw=False)
    client.post(_MRKDWN_HOSTILE, raw=True)
    assert _wire(client) == _MRKDWN_HOSTILE


# --- raw doesn't disturb other payload fields ---

def test_post_raw_preserves_sender_and_thread_ts():
    """Raw only touches `text`; sender fields, thread_ts, unfurls unchanged."""
    client = _FakeSlackClient(username='bot', icon_url='https://cdn.example/a.png')
    client.post(_MRKDWN_HOSTILE, thread_id='9.99', raw=True)
    _endpoint, data = client.calls[-1]
    assert data['text'] == _MRKDWN_HOSTILE
    assert data['username'] == 'bot'
    assert data['icon_url'] == 'https://cdn.example/a.png'
    assert data['thread_ts'] == '9.99'
    assert data['unfurl_links'] is False   # default suppress_unfurls=True
    assert data['unfurl_media'] is False


def test_edit_raw_preserves_channel_and_ts():
    """Edit payload keeps channel + ts alongside verbatim text."""
    client = _FakeSlackClient(raw=True)
    client.edit('1.000001', _MRKDWN_HOSTILE)
    _endpoint, data = client.calls[-1]
    assert data == {
        'channel': 'C_TARGET',
        'ts': '1.000001',
        'text': _MRKDWN_HOSTILE,
        'unfurl_links': False,
        'unfurl_media': False,
    }


# --- over the 4,000 on `text`, raw goes out as sections too ---

def test_raw_over_the_limit_goes_out_as_sections():
    """Raw skips md→mrkdwn, not the section path: sections carry the wire, `text` is the capped fallback."""
    from thrds.slack import SLACK_MESSAGE_LIMIT, fallback_text
    client = _FakeSlackClient(raw=True)
    rows = [f'{i:02d} *' + 'r' * 66 + '*' for i in range(60)]
    wire = '\n'.join(rows)
    assert len(wire) > SLACK_MESSAGE_LIMIT
    client.post(wire)
    _, data = client.calls[-1]
    assert (data['text'], data['blocks']) == (fallback_text(wire), [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': '\n'.join(rows[:41])}},
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': '\n'.join(rows[41:])}},
    ])
