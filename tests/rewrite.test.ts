import { describe, expect, it } from "vitest";
import {
  applyOrder,
  describeSender,
  lineDiff,
  parsePlan,
  planCounts,
  postedOf,
  senderChanged,
  writes,
  writesSummary,
  type PlannedAction,
  type RewriteContent,
  type RewriteSender,
} from "../src/index";

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
    expect(planCounts(plan)).toEqual({ edit: 1, repost: 0, post: 0, delete: 0, noop: 1, skip: 0, blocked: 1 });
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
    expect([describeSender(a.old!.sender), describeSender(digest)]).toEqual(["the app", '"Digest" :bar_chart:']);
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

describe("post and delete actions", () => {
  const post = { kind: "post", channel: "C1", ts: "wk-1", thread_ts: "1.0", hash: "h", old: null, new: content("Week 1"), reason: null };
  const del = { kind: "delete", channel: "C1", ts: "1.1", thread_ts: "1.0", hash: "h", old: content("Nov 1"), new: null, reason: null };
  const parse = (...actions: unknown[]) => parsePlan({ thrds_rewrite_plan: 1, actions });

  it("parses them, and refuses ones missing their content or sharing an id", () => {
    expect(parse(del, post).actions.map((a) => [a.ts, a.kind, writes(a)])).toEqual([["1.1", "delete", true], ["wk-1", "post", true]]);
    expect(() => parse({ ...post, old: content("x") })).toThrow(/^plan action wk-1: a post with old content$/);
    expect(() => parse({ ...post, new: null })).toThrow(/^plan action wk-1: neither old nor new content$/);
    expect(() => parse({ ...del, old: null, new: content("x") })).toThrow(/^plan action 1\.1: delete without old content$/);
    expect(() => parse(post, del, post)).toThrow(/^plan actions share ids: wk-1$/);
  });

  it("orders deletes last, reads posted ts from outcomes, and summarizes the writes", () => {
    const edit = { kind: "edit" as const, ts: "2.0" };
    expect(applyOrder([{ kind: "delete" as const, ts: "1.1" }, edit, { kind: "post" as const, ts: "wk-1" }]).map((a) => a.ts)).toEqual(["2.0", "wk-1", "1.1"]);
    expect(
      postedOf([
        { ts: "wk-1", kind: "post", status: "done", new_ts: "101.0" },
        { ts: "wk-2", kind: "post", status: "receipt", new_ts: "102.0" },
        { ts: "wk-3", kind: "post", status: "pending" },
        { ts: "1.0", kind: "repost", status: "done", new_ts: "103.0" },
      ]),
    ).toEqual({ "wk-1": "101.0", "wk-2": "102.0" });
    expect(writesSummary({ edit: 3, repost: 0, post: 5, delete: 27, noop: 9, skip: 1, blocked: 2 })).toBe("3 to edit · 5 to post · 27 to delete");
    expect(writesSummary({ edit: 0, repost: 0, post: 0, delete: 0, noop: 9, skip: 1, blocked: 2 })).toBe("");
  });
});
