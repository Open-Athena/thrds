"""Parse and serialize the thread markdown format.

Two layouts share this module:

- **per-thread files** (current; see ``specs/done/per-thread-model.md``) — one
  ``NN-slug.md`` per thread, parsed by :func:`parse_thread` /
  :func:`serialize_thread`. The slug comes from the filename; ``+++``
  separates replies; ``===`` is rejected.
- **single multi-thread doc** (legacy) — one ``.md`` holding every thread,
  parsed by :func:`parse_doc` / :func:`serialize_doc`, where ``===`` starts
  each thread. Retained to read pre-migration sessions and to drive
  ``thrds slack migrate``, which splits such a doc into per-thread files.

Legacy format
-------------
Two block-level delimiters split the document into two levels:

- ``=== slug``  starts a new top-level thread (its OP + zero or more replies).
  The ``slug`` is optional; when present it makes the thread targetable by
  ``[text](#slug)`` cross-references from other threads.
- ``+++``       starts a reply within the current top-level thread.

Text before the first ``===`` is the ``preamble`` — a bare top-level message
with no replies. Optional YAML frontmatter (``---`` delimited) at the very
top of the document carries per-doc metadata: ``channel``, ``thread_ts``,
``session_id``.

``---`` is deliberately NOT reused as a section delimiter: it collides with
YAML frontmatter and Markdown ``<hr>``, and the two-level structure needs
two markers anyway (see ``specs/multi-thread-posts-and-capture.md``).

Round-trip guarantee: ``parse_doc(serialize_doc(doc, fm)) == (doc, fm)``.
Message bodies are strip()'d — surrounding whitespace is not part of the
message. Internal blank lines (paragraph breaks within a message) are
preserved.
"""
from __future__ import annotations

import difflib
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from .core import Image, Msg
from .doc import Doc, DocMessage, DocThread, Frontmatter, SenderProfile
from .imageblock import split_trailing_images


_HEADER_RE = re.compile(r'^===(?:[ \t]+([a-zA-Z0-9_-]+))?[ \t]*$')
# `+++`               → reply from us (author=None), default identity
# `+++ @alice`        → reply from `alice`; foreign, sync leaves it alone
# `+++ as gcs`        → our reply posted as the `gcs` sender profile (frontmatter)
_REPLY_RE = re.compile(
    r'^\+\+\+(?:[ \t]+(?:@(?P<author>[a-zA-Z0-9._-]+)|as[ \t]+(?P<sender>[a-zA-Z0-9_-]+)))?[ \t]*$'
)
# Any line that *intends* to be a reply delimiter (`+++` then whitespace or EOL);
# one matching this but not `_REPLY_RE` is a malformed delimiter, not content.
_REPLY_DELIM_RE = re.compile(r'^\+\+\+([ \t].*)?$')
_SENDER_KEY_RE = re.compile(r'^sender\.(?P<name>[a-zA-Z0-9_-]+)\.(?P<field>name|avatar)$')
_EMOJI_RE = re.compile(r'^:[a-zA-Z0-9_+-]+:$')
_FRONTMATTER_DELIM = '---'
_KNOWN_FRONTMATTER_KEYS = ('channel', 'thread_ts', 'session_id', 'op_sender')


@dataclass
class ParsedDoc:
    """A doc parsed from its .md source, alongside its YAML frontmatter."""
    doc: Doc
    frontmatter: Frontmatter


@dataclass
class ParsedThread:
    """One thread parsed from its own ``NN-slug.md`` file, plus frontmatter.

    The per-thread counterpart to :class:`ParsedDoc`. The thread's slug comes
    from the *filename*, not from any in-file marker — see
    :mod:`thrds.threadfile`.
    """
    thread: DocThread
    frontmatter: Frontmatter


def _match_header(line: str) -> tuple[bool, str | None]:
    """Return (is_header, slug). slug is None for a bare ``===``."""
    m = _HEADER_RE.match(line)
    if m is None:
        return (False, None)
    return (True, m.group(1))


def _parse_frontmatter_body(body: str) -> Frontmatter:
    """Parse ``key: value`` lines into a Frontmatter.

    Deliberately minimal — no nested structures, no list values, no quoting.
    Bump to PyYAML if we ever need more shape than string scalars.
    """
    scalars: dict[str, str] = {}
    sender_fields: dict[str, dict[str, str]] = {}
    for i, line in enumerate(body.split('\n')):
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        if ':' not in stripped:
            raise ValueError(f"Malformed frontmatter line {i}: {line!r}")
        k, _, v = stripped.partition(':')
        k, v = k.strip(), v.strip()
        sender_m = _SENDER_KEY_RE.match(k)
        if sender_m:
            sender_fields.setdefault(sender_m.group('name'), {})[sender_m.group('field')] = v
        else:
            scalars[k] = v
    unknown = set(scalars) - set(_KNOWN_FRONTMATTER_KEYS)
    if unknown:
        raise ValueError(f"Unknown frontmatter keys: {sorted(unknown)}")
    senders = {name: _build_profile(fields) for name, fields in sender_fields.items()}
    return Frontmatter(senders=senders, **scalars)


def _build_profile(fields: dict[str, str]) -> SenderProfile:
    """Build a `SenderProfile` from its ``{name, avatar}`` frontmatter fields.

    ``avatar`` resolves to ``icon_emoji`` when it's a ``:emoji:``, else to
    ``icon_url`` (icon-as-a-unit, matching `Msg`).
    """
    name = fields.get('name')
    avatar = fields.get('avatar')
    icon_url = icon_emoji = None
    if avatar is not None:
        if _EMOJI_RE.match(avatar):
            icon_emoji = avatar
        else:
            icon_url = avatar
    return SenderProfile(name=name, icon_url=icon_url, icon_emoji=icon_emoji)


def _lift_doc_images(content: str, base_dir: Path | None) -> tuple[str, list[Image]]:
    """Lift the trailing ``![alt](target){bust?}`` run into `Image`s, cleaning
    ``content``. ``target`` with a URL scheme → `Image(url=…)`; otherwise a local
    path resolved against ``base_dir`` (or used as-is if none) → `Image(path=…)`.
    ``{bust}`` only applies to a URL. Custom-emoji image lines (``![:x:](…)``)
    are not lifted (they belong to mrkdwn) — `split_trailing_images` skips them."""
    body, refs = split_trailing_images(content)
    if not refs:
        return content, []
    images: list[Image] = []
    for ref in refs:
        if urlsplit(ref.url).scheme:
            images.append(Image(url=ref.url, alt=ref.alt, bust=ref.bust))
        else:
            path = base_dir / ref.url if base_dir is not None else Path(ref.url)
            images.append(Image(path=path, alt=ref.alt))
    return body, images


def resolve_messages(
    messages: list[DocMessage],
    frontmatter: Frontmatter,
    *,
    lift_images: bool = False,
    base_dir: Path | None = None,
) -> list[str | Msg]:
    """Resolve parsed messages to `sync`'s desired input (bare ``str`` or `Msg`).

    ``messages`` is the OP-first list of *our* messages (foreign ones filtered by
    the caller, as before). A message with a sender ref — the OP via
    ``frontmatter.op_sender``, a reply via its own ``sender`` — becomes a `Msg`
    carrying that profile's name/avatar; a message with none stays a bare content
    ``str``, so a sender-free doc yields the exact ``list[str]`` it did before this
    feature (zero behavior change). Refs are already validated at parse time.

    ``lift_images`` pulls the trailing ``![alt](target)`` run out of each
    message's content into `Msg.images` (stripping it from the wire content) —
    the form Discord needs, where an attachment is structural and the bot must
    know a message has one *before* routing it to the webhook. Slack leaves
    ``lift_images=False``: it carries images in content (image blocks that
    round-trip on read-back), so lifting there would desync the reconcile. Local
    ``target`` paths resolve against ``base_dir`` (the doc's directory).
    """
    out: list[str | Msg] = []
    for i, m in enumerate(messages):
        ref = frontmatter.op_sender if i == 0 else m.sender
        content, images = _lift_doc_images(m.content, base_dir) if lift_images else (m.content, [])
        # Pass `images` only when non-empty, so an image-free message keeps the
        # `Msg` default `()` (and a sender-and-image-free one stays a bare str).
        img_kw = {'images': images} if images else {}
        if ref is None and not images:
            out.append(content)
        elif ref is None:
            out.append(Msg(content, **img_kw))
        else:
            p = frontmatter.senders[ref]
            out.append(Msg(content, username=p.name, icon_url=p.icon_url, icon_emoji=p.icon_emoji, **img_kw))
    return out


def _validate_sender_refs(threads: list[DocThread], frontmatter: Frontmatter, *, op_sender: bool) -> None:
    """Raise if any `op_sender` / `+++ as <name>` ref isn't a declared profile."""
    defined = set(frontmatter.senders)
    refs: list[str] = []
    if op_sender and frontmatter.op_sender is not None:
        refs.append(frontmatter.op_sender)
    for thread in threads:
        refs += [m.sender for m in thread.messages if m.sender is not None]
    undefined = sorted({r for r in refs if r not in defined})
    if undefined:
        raise ValueError(
            f"Undefined sender ref(s): {undefined}; declare via `sender.<name>.name` / "
            f"`sender.<name>.avatar` frontmatter keys"
        )


def parse_doc(text: str) -> ParsedDoc:
    """Parse a `.md` doc into a `Doc` + its frontmatter."""
    lines = text.split('\n')
    i = 0
    frontmatter = Frontmatter()

    if i < len(lines) and lines[i].strip() == _FRONTMATTER_DELIM:
        end = next((j for j in range(i + 1, len(lines)) if lines[j].strip() == _FRONTMATTER_DELIM), None)
        if end is None:
            raise ValueError("Frontmatter opened with `---` but no closing delimiter found")
        frontmatter = _parse_frontmatter_body('\n'.join(lines[i + 1:end]))
        i = end + 1

    while i < len(lines) and not lines[i].strip():
        i += 1

    preamble_lines: list[str] = []
    while i < len(lines):
        is_header, _ = _match_header(lines[i])
        if is_header:
            break
        preamble_lines.append(lines[i])
        i += 1
    preamble_text = '\n'.join(preamble_lines).strip()
    preamble = preamble_text or None

    threads: list[DocThread] = []
    seen_slugs: set[str] = set()
    while i < len(lines):
        is_header, slug = _match_header(lines[i])
        if not is_header:
            raise ValueError(f"Expected `===` thread header at line {i}, got: {lines[i]!r}")
        if slug is not None:
            if slug in seen_slugs:
                raise ValueError(f"Duplicate thread slug: {slug!r}")
            seen_slugs.add(slug)
        i += 1
        start = i
        while i < len(lines):
            is_next_header, _ = _match_header(lines[i])
            if is_next_header:
                break
            i += 1
        threads.append(DocThread(messages=_split_messages(lines[start:i], slug), slug=slug))

    if frontmatter.op_sender is not None:
        raise ValueError(
            "`op_sender` is only supported in per-thread files, not multi-thread docs "
            "(which OP would it name?); annotate replies with `+++ as <sender>` instead"
        )
    _validate_sender_refs(threads, frontmatter, op_sender=False)
    return ParsedDoc(doc=Doc(threads=threads, preamble=preamble), frontmatter=frontmatter)


def _split_messages(lines: list[str], label: str | None) -> list[DocMessage]:
    """Split ``lines`` on ``+++`` into OP + replies, validating non-emptiness.

    ``label`` names the thread in error messages — its slug, or ``None`` for a
    thread that has none.
    """
    current: list[str] = []
    current_author: str | None = None  # OP is always ours
    current_sender: str | None = None  # OP sender is frontmatter `op_sender`, not here
    messages: list[DocMessage] = []
    for line in lines:
        if _REPLY_DELIM_RE.match(line):
            reply_m = _REPLY_RE.match(line)
            if reply_m is None:
                raise ValueError(
                    f"Thread {label!r}: malformed reply delimiter {line!r} — use `+++`, "
                    f"`+++ @author` (foreign), or `+++ as <sender>` (custom sender)"
                )
            messages.append(DocMessage(
                content='\n'.join(current).strip(), author=current_author, sender=current_sender,
            ))
            current = []
            current_author = reply_m.group('author')
            current_sender = reply_m.group('sender')
            continue
        current.append(line)
    messages.append(DocMessage(
        content='\n'.join(current).strip(), author=current_author, sender=current_sender,
    ))
    if not messages[0].content:
        raise ValueError(f"Thread {label!r}: OP (first message) is empty")
    for j, m in enumerate(messages[1:], start=1):
        if not m.content:
            raise ValueError(f"Thread {label!r}: reply {j} is empty")
    return messages


def parse_thread(text: str, slug: str | None = None) -> ParsedThread:
    """Parse one thread's ``.md`` file into a `DocThread` + its frontmatter.

    The per-thread-file counterpart to :func:`parse_doc`: the whole file is a
    single thread (OP plus ``+++``-separated replies), and the slug comes from
    the filename rather than a ``=== slug`` header. A stray ``===`` is an
    error — it's the old multi-thread-per-file syntax, and silently accepting
    it would let a doc that means several threads post as one.

    Round-trip guarantee: ``parse_thread(serialize_thread(t, fm)) == (t, fm)``.
    """
    lines = text.split('\n')
    i = 0
    frontmatter = Frontmatter()

    if i < len(lines) and lines[i].strip() == _FRONTMATTER_DELIM:
        end = next((j for j in range(i + 1, len(lines)) if lines[j].strip() == _FRONTMATTER_DELIM), None)
        if end is None:
            raise ValueError("Frontmatter opened with `---` but no closing delimiter found")
        frontmatter = _parse_frontmatter_body('\n'.join(lines[i + 1:end]))
        i = end + 1

    while i < len(lines) and not lines[i].strip():
        i += 1

    body = lines[i:]
    for n, line in enumerate(body):
        is_header, _ = _match_header(line)
        if is_header:
            raise ValueError(
                f"Thread {slug!r}: unexpected `===` at line {i + n}: one file is one thread; "
                f"`===` (multi-thread-per-file) was retired — split into `NN-slug.md` files "
                f"via `thrds slack migrate`"
            )

    thread = DocThread(messages=_split_messages(body, slug), slug=slug)
    _validate_sender_refs([thread], frontmatter, op_sender=True)
    return ParsedThread(thread=thread, frontmatter=frontmatter)


def _render_frontmatter(frontmatter: Frontmatter | None) -> list[str]:
    """Frontmatter block as serialized parts (empty when absent or all-None)."""
    if frontmatter is None:
        return []
    fm_lines = [
        f'{k}: {getattr(frontmatter, k)}'
        for k in _KNOWN_FRONTMATTER_KEYS
        if getattr(frontmatter, k) is not None
    ]
    for name in sorted(frontmatter.senders):
        profile = frontmatter.senders[name]
        if profile.name is not None:
            fm_lines.append(f'sender.{name}.name: {profile.name}')
        avatar = profile.icon_url if profile.icon_url is not None else profile.icon_emoji
        if avatar is not None:
            fm_lines.append(f'sender.{name}.avatar: {avatar}')
    if not fm_lines:
        return []
    fm_body = '\n'.join(fm_lines)
    return [f'{_FRONTMATTER_DELIM}\n{fm_body}\n{_FRONTMATTER_DELIM}']


def _reply_delim(msg: DocMessage) -> str:
    """The `+++` line for a reply: foreign (`@author`), custom sender (`as`), or bare."""
    if msg.author:
        return f'+++ @{msg.author}'
    if msg.sender:
        return f'+++ as {msg.sender}'
    return '+++'


def serialize_thread(thread: DocThread, frontmatter: Frontmatter | None = None) -> str:
    """Serialize one `DocThread` to canonical per-thread `.md`.

    No ``===`` header — the slug lives in the filename. Canonical form matches
    :func:`serialize_doc`: single blank line between sections, trailing
    newline, no leading blank lines.
    """
    parts: list[str] = _render_frontmatter(frontmatter)

    for i, msg in enumerate(thread.messages):
        if i > 0:
            parts.append(_reply_delim(msg))
        elif msg.author is not None or msg.sender is not None:
            raise ValueError(
                f"Thread {thread.slug!r}: OP author/sender must be None (top-level = ours; "
                f"OP sender lives in frontmatter `op_sender`), got author={msg.author!r} "
                f"sender={msg.sender!r}"
            )
        parts.append(msg.content.strip())

    return '\n\n'.join(parts) + '\n'


def diff_texts(
    a: str,
    b: str,
    from_label: str,
    to_label: str,
    context: int = 3,
) -> str:
    """Unified diff of two `.md` texts; empty string when they're identical.

    The per-thread counterpart to :func:`diff_docs` compares a working-tree
    file byte-for-byte against what `pull` would write, so it needs a diff that
    does *not* canonicalize its left side — non-canonical local formatting is a
    change `pull` would make, and hiding it would misreport.
    """
    return "".join(difflib.unified_diff(
        a.splitlines(keepends=True),
        b.splitlines(keepends=True),
        fromfile=from_label,
        tofile=to_label,
        n=context,
    ))


def diff_docs(
    a: Doc,
    b: Doc,
    from_label: str = 'local',
    to_label: str = 'slack',
    context: int = 3,
) -> str:
    """Unified diff of two Docs as canonical `.md` text.

    Both sides are serialized via `serialize_doc` (no frontmatter — the diff
    is about doc content, not per-source metadata), so formatting variants
    that round-trip to the same canonical form don't leak into the diff.
    Returns an empty string when the two Docs are canonically identical.
    """
    return diff_texts(
        serialize_doc(a),
        serialize_doc(b),
        from_label=from_label,
        to_label=to_label,
        context=context,
    )


def serialize_doc(doc: Doc, frontmatter: Frontmatter | None = None) -> str:
    """Serialize a Doc (+ optional frontmatter) to canonical `.md`.

    Canonical form: single blank line between every top-level section,
    trailing newline, no leading blank lines. This is the fixed point of
    parse ∘ serialize.
    """
    parts: list[str] = _render_frontmatter(frontmatter)

    if doc.preamble:
        parts.append(doc.preamble.strip())

    for thread in doc.threads:
        header = f'=== {thread.slug}' if thread.slug else '==='
        parts.append(header)
        for i, msg in enumerate(thread.messages):
            if i > 0:
                parts.append(_reply_delim(msg))
            elif msg.author is not None or msg.sender is not None:
                raise ValueError(
                    f"Thread {thread.slug!r}: OP author/sender must be None (top-level = ours), "
                    f"got author={msg.author!r} sender={msg.sender!r}"
                )
            parts.append(msg.content.strip())

    return '\n\n'.join(parts) + '\n'
