import { describe, expect, it } from "vitest";
import {
  bound,
  button,
  context,
  date,
  encodePrivateMetadata,
  escape,
  image,
  link,
  mention,
  section,
} from "../src/mrkdwn";
import { buildPermalink, parsePermalink } from "../src/permalink";

describe("mrkdwn", () => {
  it("escapes only Slack's control characters", () => {
    expect(escape("a & b <c> *d*")).toBe("a &amp; b &lt;c&gt; *d*");
  });

  it("links escape labels and keep `|` / `>` out of both parts", () => {
    expect([link("https://x.org/a?b=1|2"), link("https://x.org/>", "A <b> | c")]).toEqual([
      "<https://x.org/a?b=1%7C2>",
      "<https://x.org/%3E|A &lt;b&gt; ¦ c>",
    ]);
  });

  it("mentions and dates", () => {
    expect([mention.user("U1"), mention.channel("C1"), mention.group("S1"), date(1794940661.9, "{date_short} {time}", "Nov 17 <x>")]).toEqual([
      "<@U1>",
      "<#C1>",
      "<!subteam^S1>",
      "<!date^1794940661^{date_short} {time}|Nov 17 &lt;x&gt;>",
    ]);
  });

  it("bound cuts by code point, so an emoji is never split", () => {
    expect([bound("short", 10), bound("abcdef", 4), bound("ab😀cd", 4)]).toEqual(["short", "abc…", "ab😀…"]);
  });
});

describe("blocks", () => {
  it("section, context, image, button", () => {
    expect([
      section("*hi*", { fields: ["a"], blockId: "b1" }),
      context("by <@U1>", { type: "image", image_url: "https://i", alt_text: "x" }),
      image({ slackFile: "F1" }, "plot", "Week"),
      button({ text: "Run", actionId: "run", value: "42", style: "danger", confirm: { title: "Sure?", text: "*really*", confirm: "Yes", deny: "No" } }),
    ]).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "*hi*" }, fields: [{ type: "mrkdwn", text: "a" }], block_id: "b1" },
      { type: "context", elements: [{ type: "mrkdwn", text: "by <@U1>" }, { type: "image", image_url: "https://i", alt_text: "x" }] },
      { type: "image", alt_text: "plot", slack_file: { id: "F1" }, title: { type: "plain_text", text: "Week", emoji: true } },
      {
        type: "button",
        text: { type: "plain_text", text: "Run", emoji: true },
        action_id: "run",
        value: "42",
        style: "danger",
        confirm: {
          title: { type: "plain_text", text: "Sure?", emoji: true },
          text: { type: "mrkdwn", text: "*really*" },
          confirm: { type: "plain_text", text: "Yes", emoji: true },
          deny: { type: "plain_text", text: "No", emoji: true },
        },
      },
    ]);
  });

  it("private_metadata refuses what Slack would reject", () => {
    expect(encodePrivateMetadata({ week: "2026-11-13" })).toBe('{"week":"2026-11-13"}');
    expect(() => encodePrivateMetadata("x".repeat(3000))).toThrow("private_metadata is 3002 chars; Slack's limit is 3000");
  });
});

describe("permalinks", () => {
  it("parse top-level and reply links; reject others", () => {
    expect([
      parsePermalink("https://openathena.slack.com/archives/D09GR7XV10X/p1794940661977049"),
      parsePermalink("https://openathena.slack.com/archives/C1/p1794940661977049?thread_ts=1794940600.000100&cid=C1"),
      parsePermalink("https://example.org/archives/C1/p1794940661977049"),
      parsePermalink("not a url"),
    ]).toEqual([
      { channel: "D09GR7XV10X", ts: "1794940661.977049" },
      { channel: "C1", ts: "1794940661.977049", threadTs: "1794940600.000100" },
      null,
      null,
    ]);
  });

  it("build round-trips with parse", () => {
    const ref = { channel: "C1", ts: "1794940661.977049", threadTs: "1794940600.000100" };
    const url = buildPermalink("openathena", ref);
    expect([url, parsePermalink(url)]).toEqual([
      "https://openathena.slack.com/archives/C1/p1794940661977049?thread_ts=1794940600.000100&cid=C1",
      ref,
    ]);
  });
});
