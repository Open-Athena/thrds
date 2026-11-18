import {
  SlackClient
} from "./chunk-LITWYH3J.js";
import "./chunk-ZJWW4GA7.js";
import "./chunk-YSTFV535.js";

// src/testing.ts
function fakeSlack(routes) {
  const calls = [];
  const queues = /* @__PURE__ */ new Map();
  const fetchImpl = (async (input, init = {}) => {
    const url = new URL(String(input));
    const method = url.pathname.replace(/^\/api\//, "");
    const http = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : Object.fromEntries(url.searchParams);
    const call = { method, http, body };
    calls.push(call);
    const route = routes[method];
    if (route === void 0) throw new Error(`unexpected Slack method: ${method}`);
    let reply;
    if (typeof route === "function") reply = route(call);
    else if (Array.isArray(route)) {
      const i = queues.get(method) ?? 0;
      queues.set(method, i + 1);
      reply = route[Math.min(i, route.length - 1)];
    } else reply = route;
    return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: reply.headers
    });
  });
  return { fetch: fetchImpl, calls };
}
function fakeSleep() {
  const waits = [];
  return { sleep: async (ms) => void waits.push(ms), waits };
}
var AUTH = { body: { ok: true, user_id: "U_BOT", bot_id: "B_BOT" } };
function fakeClient(routes, options = {}) {
  const { fetch, calls } = fakeSlack(routes);
  const { sleep, waits } = fakeSleep();
  return { client: new SlackClient({ token: "xoxb-t", channel: "C1", fetch, sleep, ...options }), calls, waits };
}
function fakeChannel(options = {}) {
  const messages = [...options.messages ?? []];
  let n = 100;
  const writes = [];
  const err = (error) => ({ body: { ok: false, error } });
  const routes = {
    "auth.test": AUTH,
    "chat.postMessage": ({ body }) => {
      if (body["thread_ts"] && !messages.some((x) => x.ts === body["thread_ts"])) return err("thread_not_found");
      const ts = `${++n}.000000`;
      const m = { ts, text: body["text"], bot_id: "B_BOT" };
      if (body["thread_ts"]) m.thread_ts = body["thread_ts"];
      if (body["username"]) m.username = body["username"];
      if (body["blocks"]) m.blocks = body["blocks"];
      if (body["metadata"]) m.metadata = body["metadata"];
      messages.push(m);
      writes.push(["post", m.text]);
      return { body: { ok: true, ts } };
    },
    "chat.update": ({ body }) => {
      const m = messages.find((x) => x.ts === body["ts"]);
      if (!m) return err("message_not_found");
      m.text = body["text"];
      if (body["blocks"]) m.blocks = body["blocks"];
      if (body["metadata"]) m.metadata = body["metadata"];
      writes.push(["edit", m.text]);
      return { body: { ok: true, ts: m.ts } };
    },
    "chat.delete": ({ body }) => {
      const i = messages.findIndex((x) => x.ts === body["ts"]);
      if (i < 0) return err("message_not_found");
      writes.push(["delete", messages[i].text]);
      messages.splice(i, 1);
      return { body: { ok: true } };
    },
    "conversations.replies": ({ body }) => {
      const ts = body["ts"];
      const parent = messages.find((x) => x.ts === ts);
      if (!parent) return err("thread_not_found");
      return { body: { ok: true, messages: [parent, ...messages.filter((x) => x.thread_ts === ts && x.ts !== ts)] } };
    },
    "conversations.history": ({ body }) => {
      const oldest = Number(body["oldest"] ?? 0);
      const top = messages.filter((x) => !x.thread_ts && Number(x.ts) >= oldest).reverse();
      return { body: { ok: true, messages: top } };
    }
  };
  const intercepted = {};
  for (const [method, route] of Object.entries(routes)) {
    intercepted[method] = (call) => {
      const hit = options.intercept?.(call, messages);
      if (hit !== void 0) return hit;
      return typeof route === "function" ? route(call) : route;
    };
  }
  const { client: c, calls } = fakeClient(intercepted, options.clientOptions);
  return { client: c, calls, messages, writes, routes };
}
var timeoutError = () => Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
export {
  AUTH,
  fakeChannel,
  fakeClient,
  fakeSlack,
  fakeSleep,
  timeoutError
};
//# sourceMappingURL=testing.js.map