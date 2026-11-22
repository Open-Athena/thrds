import { describe, expect, it } from "vitest";
import { describeSender, lineDiff, parsePlan, planCounts, senderChanged, writes, type PlannedAction, type RewriteContent, type RewriteSender } from "../src/index";

const noSender: RewriteSender = { username: null, icon_url: null, icon_emoji: null };
const content = (text: string, sender = noSender): RewriteContent => ({ text, blocks: null, sender, files: [] });
const action = (ts: string, kind: PlannedAction["kind"], old: RewriteContent, next: RewriteContent | null, reason: string | null = null): PlannedAction => ({
  kind,
  channel: "C1",
  ts,
  thread_ts: null,
  hash: `h${ts}`,
  old,
  new: next,
  reason,
});

describe("rewrite plans", () => {
  it("parses a plan and counts its kinds", () => {
    const plan = parsePlan({
      thrds_rewrite_plan: 1,
      actions: [
        action("1.0", "edit", content(":old:"), content(":new:")),
        action("2.0", "blocked", content("x"), null, "another app's or a person's message"),
        action("3.0", "noop", content("y"), content("y")),
      ],
    });
    expect(planCounts(plan)).toEqual({ edit: 1, repost: 0, noop: 1, skip: 0, blocked: 1 });
    expect(plan.actions.map(writes)).toEqual([true, false, false]);
  });

  it("rejects what isn't a plan", () => {
    expect(() => parsePlan(null)).toThrow("not a thrds rewrite plan (not an object)");
    expect(() => parsePlan({ thrds_rewrite_plan: 2, actions: [] })).toThrow("not a thrds rewrite plan (version 2, expected 1)");
    expect(() => parsePlan({ thrds_rewrite_plan: 1 })).toThrow("not a thrds rewrite plan (no actions)");
    expect(() => parsePlan({ thrds_rewrite_plan: 1, actions: [{ ...action("1.0", "edit", content("a"), null) }] })).toThrow(
      "plan action 1.0: edit without new content",
    );
    expect(() => parsePlan({ thrds_rewrite_plan: 1, actions: [{ ...action("1.0", "edit", content("a"), null), kind: "move" }] })).toThrow(
      'plan action 1.0: unknown kind "move"',
    );
  });

  it("describes sender changes", () => {
    const digest = { username: "Digest", icon_url: null, icon_emoji: ":bar_chart:" };
    const a = action("1.0", "repost", content("x"), content("x", digest));
    expect(senderChanged(a)).toBe(true);
    expect([describeSender(a.old.sender), describeSender(digest)]).toEqual(["the app", '"Digest" :bar_chart:']);
    expect(senderChanged(action("1.0", "edit", content("x"), content("y")))).toBe(false);
  });

  it("diffs lines", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { op: " ", text: "a" },
      { op: "-", text: "b" },
      { op: "+", text: "B" },
      { op: " ", text: "c" },
      { op: "+", text: "d" },
    ]);
    expect(lineDiff("same", "same")).toEqual([{ op: " ", text: "same" }]);
  });
});
