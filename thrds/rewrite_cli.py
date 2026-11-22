"""`thrds slack rewrite {plan,show,apply}`: bulk rewrite of an app's existing messages.

Library and design: `thrds/rewrite.py`, `specs/done/bulk-rewrite.md`.
"""
from __future__ import annotations

import json
import sys
from importlib import import_module
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import click

from .rewrite import (
    DEFAULT_PACE,
    Kind,
    Plan,
    Render,
    apply,
    find_history,
    find_ids,
    find_thread,
    plan,
    substitute,
)


def err(*msg) -> None:
    print(*msg, file=sys.stderr)


def load_render(ref: str) -> Render:
    """``MODULE:FN`` or ``path/to/file.py:FN`` → the render function."""
    mod_ref, sep, fn_name = ref.rpartition(":")
    if not sep or not mod_ref or not fn_name:
        raise click.BadParameter(f"expected MODULE:FN or FILE.py:FN, got {ref!r}", param_hint="-r/--render")
    if mod_ref.endswith(".py"):
        path = Path(mod_ref).resolve()
        spec = spec_from_file_location(path.stem, path)
        if spec is None or spec.loader is None:
            raise click.BadParameter(f"can't load {mod_ref}", param_hint="-r/--render")
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
    else:
        module = import_module(mod_ref)
    fn = getattr(module, fn_name, None)
    if not callable(fn):
        raise click.BadParameter(f"{mod_ref} has no function {fn_name}", param_hint="-r/--render")
    return fn


def parse_subs(subs: tuple[str, ...]) -> dict[str, str]:
    out = {}
    for s in subs:
        old, sep, new = s.partition("=")
        if not sep or not old:
            raise click.BadParameter(f"expected OLD=NEW, got {s!r}", param_hint="-s/--sub")
        out[old] = new
    return out


def _client(channel_ref: str):
    from .cli import _make_slack_client, _resolve_channel
    client = _make_slack_client()
    client.channel = _resolve_channel(client, channel_ref)
    return client


@click.group("rewrite")
def rewrite_cli():
    """Bulk rewrite: find this app's messages, re-render them, review the plan, apply it.

    `plan` writes a JSON plan (one action per message: edit / repost / noop /
    skip / blocked), `show` previews one, `apply` carries it out (a dry run
    unless `-y`). See `specs/done/bulk-rewrite.md`.
    """


@rewrite_cli.command("plan")
@click.option("-a", "--after", help="Only messages after this ts (`oldest`).")
@click.option("-b", "--before", help="Only messages before this ts (`latest`).")
@click.option("-c", "--channel", required=True, help="Channel id or name.")
@click.option("-f", "--foreign", is_flag=True, help="Include others' messages (planned as blocked).")
@click.option("-i", "--id", "ids", multiple=True, help="Exactly this message ts (repeatable); instead of history / a thread.")
@click.option("-m", "--allow-move", is_flag=True, help="Allow a repost that moves a message to the end of its channel / thread.")
@click.option("-o", "--output", type=click.Path(dir_okay=False, path_type=Path), help="Write the plan here (default: stdout).")
@click.option("-r", "--render", "render_ref", help="Render function, MODULE:FN or FILE.py:FN: `render(found) -> Desired | Skip`.")
@click.option("-s", "--sub", "subs", multiple=True, help="Replace OLD with NEW in text and blocks (repeatable): the built-in render.")
@click.option("-t", "--thread", "thread_ts", help="Only this thread (its parent and replies).")
@click.option("-w", "--with-replies", is_flag=True, help="With history: follow each thread's parent with its replies.")
def rewrite_plan(
    after: str | None,
    before: str | None,
    channel: str,
    foreign: bool,
    ids: tuple[str, ...],
    allow_move: bool,
    output: Path | None,
    render_ref: str | None,
    subs: tuple[str, ...],
    thread_ts: str | None,
    with_replies: bool,
):
    """Find the messages in scope, render each, and write the plan (JSON); the preview goes to stderr."""
    if (render_ref is None) == (not subs):
        raise click.UsageError("pass exactly one of -r/--render or -s/--sub")
    if ids and (thread_ts or after or before or with_replies):
        raise click.UsageError("-i/--id takes no -t / -a / -b / -w")
    if thread_ts and (after or before or with_replies):
        raise click.UsageError("-t/--thread takes no -a / -b / -w")
    render = load_render(render_ref) if render_ref is not None else substitute(parse_subs(subs))
    client = _client(channel)
    if ids:
        found = find_ids(client, ids)
    elif thread_ts:
        found = find_thread(client, thread_ts, include_foreign=foreign)
    else:
        found = find_history(client, oldest=after, latest=before, include_replies=with_replies, include_foreign=foreign)
    p = plan(found, render, reorder_ok=allow_move)
    text = json.dumps(p.to_json(), indent=2, ensure_ascii=False) + "\n"
    if output is None:
        click.echo(text, nl=False)
    else:
        output.write_text(text)
    err(p.format_preview(color=sys.stderr.isatty()))
    if output is not None:
        err(f"Wrote {output}")


KIND_NAMES = [k.value for k in Kind]


@rewrite_cli.command("show")
@click.option("-j", "--json", "as_json", is_flag=True, help="Emit the review form (the plan plus per-action diffs and counts).")
@click.option("-k", "--kind", "kinds", multiple=True, type=click.Choice(KIND_NAMES), help="Only these kinds (repeatable; default: all but noop).")
@click.argument("plan_path", type=click.Path(exists=True, dir_okay=False, path_type=Path))
def rewrite_show(as_json: bool, kinds: tuple[str, ...], plan_path: Path):
    """Preview a plan."""
    p = Plan.load(plan_path)
    if as_json:
        click.echo(json.dumps(p.review_json(), indent=2, ensure_ascii=False))
        return
    click.echo(p.format_preview(color=sys.stdout.isatty(), kinds=[Kind(k) for k in kinds] if kinds else None))


@rewrite_cli.command("apply")
@click.option("-i", "--id", "ids", multiple=True, help="Only this message ts (repeatable).")
@click.option("-p", "--pace", type=float, default=DEFAULT_PACE, show_default=True, help="Seconds between writes.")
@click.option("-r", "--receipts", type=click.Path(dir_okay=False, path_type=Path), help="Receipts file (JSONL; default: PLAN with `.receipts.jsonl`).")
@click.option("-y", "--yes", is_flag=True, help="Write. Without it, a dry run that still checks each message.")
@click.argument("plan_path", type=click.Path(exists=True, dir_okay=False, path_type=Path))
def rewrite_apply(ids: tuple[str, ...], pace: float, receipts: Path | None, yes: bool, plan_path: Path):
    """Apply a plan's edits and reposts, each checked against the message's planned content hash."""
    p = Plan.load(plan_path)
    channels = sorted({a.channel for a in p.actions if a.writes})
    if not channels:
        err("Nothing to apply")
        return
    if len(channels) > 1:
        raise click.UsageError(f"plan spans channels {', '.join(channels)}; one per plan")
    client = _client(channels[0])
    receipts = receipts or plan_path.with_suffix(".receipts.jsonl")
    report = apply(
        p,
        client,
        dry_run=not yes,
        only=ids or None,
        receipts=receipts,
        pace=pace,
        on_outcome=lambda o: err(f"{o.status.value:9} {o.kind.value:6} {o.ts}" + (f" → {o.new_ts}" if o.new_ts else "") + (f": {o.error}" if o.error else "")),
    )
    err(f"{'Applied' if yes else 'Dry run'}: {report.summary()}")
    if not yes:
        err("Pass -y to write.")
    failed = {"failed", "undeleted"} & set(report.counts())
    if failed:
        raise click.exceptions.Exit(1)


@rewrite_cli.command("review")
@click.option("-O", "--no-open", is_flag=True, help="Don't open the page in a browser.")
@click.option("-p", "--port", type=int, default=None, help="Port (default 3078; 0: any free port).")
@click.option("-r", "--receipts", type=click.Path(dir_okay=False, path_type=Path), help="Receipts file (JSONL; default: PLAN with `.receipts.jsonl`).")
@click.argument("plan_path", type=click.Path(exists=True, dir_okay=False, path_type=Path))
def rewrite_review(no_open: bool, port: int | None, receipts: Path | None, plan_path: Path):
    """Serve the review page for a plan on localhost: filter, compare, select, check, and apply.

    `Check` dry-runs the selected actions; `Apply` writes them (asking first),
    with the same hash checks and receipts as `apply -y`.
    """
    import webbrowser

    from .rewrite_review import DEFAULT_PORT, serve

    p = Plan.load(plan_path)
    channels = sorted({a.channel for a in p.actions if a.writes})
    if len(channels) > 1:
        raise click.UsageError(f"plan spans channels {', '.join(channels)}; one per plan")
    receipts = receipts or plan_path.with_suffix(".receipts.jsonl")
    clients: list = []

    def run(plan_: Plan, ids: list[str], dry_run: bool):
        if not clients:
            clients.append(_client(channels[0]))
        report = apply(plan_, clients[0], dry_run=dry_run, only=ids, receipts=receipts)
        for o in report.outcomes:
            err(f"{'check' if dry_run else 'apply'}: {o.status.value:9} {o.kind.value:6} {o.ts}" + (f": {o.error}" if o.error else ""))
        return report.outcomes

    try:
        server = serve(plan_path, DEFAULT_PORT if port is None else port, run)
    except OSError as e:
        raise click.UsageError(f"can't listen on port {DEFAULT_PORT if port is None else port} ({e.strerror}); pass -p") from e
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    err(f"Reviewing {plan_path} at {url} (Ctrl-C to stop)")
    if not no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
