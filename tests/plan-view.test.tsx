import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Diff, Mrkdwn, PlanView, SlackMessage, BlockView } from "../src/plan-view/index";
import type { PlannedAction, RewriteContent, RewritePlan } from "../src/rewrite";

const noSender = { username: null, icon_url: null, icon_emoji: null };
const content = (text: string, extra: Partial<RewriteContent> = {}): RewriteContent => ({ text, blocks: null, sender: noSender, files: [], ...extra });
const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

describe("Slack rendering", () => {
  it("renders mrkdwn inline styles, links, mentions and emoji", () => {
    expect(html(<Mrkdwn text={"*bold* _it_ ~gone~ `a<b` :white_check_mark: :custom: <https://x.dev/?a=1&amp;b=2|site> <@U1> <!here> a &amp; b"} />)).toBe(
      '<div class="tpv-mrkdwn"><span><span class="tpv-line"><b>bold</b> <i>it</i> <s>gone</s> <code>a&lt;b</code> ' +
        '<span class="tpv-emoji" title=":white_check_mark:">✅</span> <span class="tpv-emoji-code">:custom:</span> ' +
        '<a href="https://x.dev/?a=1&amp;b=2" target="_blank" rel="noreferrer">site</a> <span class="tpv-mention">@U1</span> ' +
        '<span class="tpv-mention">@here</span> a &amp; b</span></span></div>',
    );
  });

  it("renders fences and quotes", () => {
    expect(html(<Mrkdwn text={"intro\n&gt; quoted\n```\ncode *not bold*\n```"} />)).toBe(
      '<div class="tpv-mrkdwn"><span><span class="tpv-line">intro</span></span><blockquote><span class="tpv-line">quoted</span></blockquote>' +
        '<span><span class="tpv-line"></span></span><pre>code *not bold*\n</pre></div>',
    );
  });

  it("uses the app's emoji map, including image URLs", () => {
    expect(html(<Mrkdwn text=":party: :x:" emoji={{ party: "https://e.dev/party.png", x: "✖" }} />)).toBe(
      '<link rel="preload" as="image" href="https://e.dev/party.png"/>' +
        '<div class="tpv-mrkdwn"><span><span class="tpv-line"><img class="tpv-emoji" src="https://e.dev/party.png" alt=":party:" title=":party:"/> ' +
        '<span class="tpv-emoji" title=":x:">✖</span></span></span></div>',
    );
  });

  it("renders blocks over text, and rich_text elements", () => {
    const blocks = [
      { type: "header", text: { type: "plain_text", text: "Fleet" } },
      { type: "section", text: { type: "mrkdwn", text: "*3* hosts" }, fields: [{ type: "plain_text", text: "a" }] },
      { type: "divider" },
      { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "emoji", name: "fire" }, { type: "text", text: " hot", style: { bold: true } }] }] },
      { type: "mystery" },
    ];
    expect(html(<SlackMessage content={content("fallback", { blocks, files: ["F1"] })} />)).toBe(
      '<div class="tpv-message"><div class="tpv-header">Fleet</div>' +
        '<div class="tpv-section"><div class="tpv-section-body"><div class="tpv-mrkdwn"><span><span class="tpv-line"><b>3</b> hosts</span></span></div>' +
        '<div class="tpv-fields"><span>a</span></div></div></div>' +
        '<hr class="tpv-divider"/>' +
        '<div class="tpv-mrkdwn"><span class="tpv-pre-wrap"><span class="tpv-emoji" title=":fire:">🔥</span><b> hot</b></span></div>' +
        '<div class="tpv-unknown">[mystery block]</div>' +
        '<div class="tpv-files"><span class="tpv-file">📎 F1</span></div></div>',
    );
  });

  it("shows a slack_file image without a URL as its id", () => {
    expect(html(<BlockView block={{ type: "image", slack_file: { id: "F9" }, alt_text: "chart" }} />)).toBe('<span class="tpv-file">🖼 F9</span>');
  });
});

describe("PlanView", () => {
  const action = (ts: string, kind: PlannedAction["kind"], old: RewriteContent, next: RewriteContent | null, reason: string | null = null): PlannedAction => ({
    kind,
    channel: "C1",
    ts,
    thread_ts: kind === "skip" ? "1.0" : null,
    hash: `h${ts}`,
    old,
    new: next,
    reason,
  });
  const plan: RewritePlan = {
    thrds_rewrite_plan: 1,
    actions: [
      action("1.0", "edit", content(":large_green_circle: ok"), content(":white_check_mark: ok")),
      action("2.0", "noop", content("same"), content("same")),
      action("3.0", "skip", content("x"), null, "not a digest"),
      action("4.0", "repost", content("card"), content("card", { sender: { username: "Digest", icon_url: null, icon_emoji: ":bar_chart:" } })),
    ],
  };

  const rows = (markup: string) => [...markup.matchAll(/<li class="tpv-action tpv-action-(\w+)">/g)].map((m) => m[1]);

  it("lists all but noops by default, with counts and selection for writes", () => {
    const markup = html(<PlanView plan={plan} unstyled onApply={() => {}} />);
    expect(rows(markup)).toEqual(["edit", "skip", "repost"]);
    expect([...markup.matchAll(/tpv-kind-(\w+)" aria-pressed="(\w+)">\1 <span class="tpv-count">(\d+)/g)].map((m) => [m[1], m[2], m[3]])).toEqual([
      ["edit", "true", "1"],
      ["repost", "true", "1"],
      ["noop", "false", "1"],
      ["skip", "true", "1"],
      ["blocked", "true", "0"],
    ]);
    expect([...markup.matchAll(/aria-label="Select ([\d.]+)"/g)].map((m) => m[1])).toEqual(["1.0", "4.0"]);
    expect(markup.match(/<span>(\d+) of (\d+) selected<\/span>/)?.slice(1)).toEqual(["2", "2"]);
    expect(markup.match(/Sender: [^<]+ → [^<]+/g)).toEqual(["Sender: the app → &quot;Digest&quot; :bar_chart:"]);
  });

  it("is read-only without handlers, and shows outcomes", () => {
    const markup = html(<PlanView plan={plan} unstyled initialKinds={["edit"]} outcomes={{ "1.0": { ts: "1.0", kind: "edit", status: "stale", error: "changed since planning" } }} />);
    expect(rows(markup)).toEqual(["edit"]);
    expect(markup.includes('type="checkbox"')).toBe(false);
    expect(markup.match(/<span class="tpv-status tpv-status-stale" title="changed since planning">.*?<\/span>/)?.[0]).toBe(
      '<span class="tpv-status tpv-status-stale" title="changed since planning">stale: changed since planning</span>',
    );
  });

  it("uses the app's renderer when it returns one", () => {
    const markup = html(<PlanView plan={plan} unstyled initialKinds={["edit"]} renderContent={(c, side) => (side === "new" ? <em>{c.text}</em> : undefined)} />);
    expect(markup.match(/<div class="tpv-side-label">Planned<\/div>(.*?)<\/div><\/div>/)?.[1]).toBe("<em>:white_check_mark: ok</em>");
  });

  it("diffs text", () => {
    expect(html(<Diff from={"a\nb"} to={"a\nc"} />)).toBe(
      '<pre class="tpv-diff"><span> a\n</span><span class="tpv-del">-b\n</span><span class="tpv-add">+c\n</span></pre>',
    );
    expect(html(<Diff from="a" to="a" />)).toBe('<div class="tpv-muted tpv-diff-none">Text unchanged (blocks or sender change).</div>');
  });
});
