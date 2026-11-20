import {
  SlackClient
} from "./chunk-33PDEAXS.js";
import "./chunk-OY4HFIJO.js";
import "./chunk-3ZH5IQC7.js";

// src/testing.ts
function fakeSlack(routes) {
  const calls = [];
  const queues = /* @__PURE__ */ new Map();
  const fetchImpl = (async (input, init = {}) => {
    const url = new URL(String(input));
    const method = url.pathname.startsWith("/api/") ? url.pathname.slice("/api/".length) : "upload_url";
    const http = init.method ?? "GET";
    const form = new Headers(init.headers).get("Content-Type")?.startsWith("application/x-www-form-urlencoded");
    const body = typeof init.body === "string" ? form ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body) : Object.fromEntries(url.searchParams);
    const call = { method, http, body };
    if (init.body instanceof Uint8Array) call.bytes = init.body;
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
  const files = /* @__PURE__ */ new Map();
  const infoReads = /* @__PURE__ */ new Map();
  let n = 100;
  let f = 100;
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
      if (body["file_ids"] !== void 0) {
        const ids = body["file_ids"];
        const missing = ids.find((id) => !files.has(id));
        if (missing !== void 0) return err("file_not_found");
        if (ids.length > 0) m.files = ids.map((id) => ({ id, name: files.get(id).name }));
        else delete m.files;
      }
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
    "files.getUploadURLExternal": ({ body }) => {
      const id = `F${++f}`;
      const name = body["filename"];
      files.set(id, { id, name, title: name, mimetype: "" });
      return { body: { ok: true, file_id: id, upload_url: `https://files.slack.com/upload/v1/fake?file=${id}` } };
    },
    upload_url: ({ body, bytes }) => {
      const file = files.get(body["file"]);
      if (!file) return { status: 404, body: "" };
      if (bytes !== void 0) file.bytes = bytes;
      return { body: "OK - " + String(bytes?.byteLength ?? 0) };
    },
    "files.completeUploadExternal": ({ body }) => {
      const done = body["files"];
      for (const { id, title } of done) {
        const file = files.get(id);
        if (!file || file.bytes === void 0) return err("file_not_found");
        if (title !== void 0) file.title = title;
      }
      const channel = body["channel_id"];
      if (channel !== void 0) {
        const ts = `${++n}.000000`;
        const m = {
          ts,
          text: body["initial_comment"] ?? "",
          bot_id: "B_BOT",
          files: done.map(({ id }) => ({ id, name: files.get(id).name }))
        };
        if (body["thread_ts"]) m.thread_ts = body["thread_ts"];
        for (const { id } of done) files.get(id).channel = channel;
        messages.push(m);
        writes.push(["share", m.text]);
      }
      return { body: { ok: true, files: done.map(({ id }) => ({ id })) } };
    },
    "files.info": ({ body }) => {
      const file = files.get(body["file"]);
      if (!file) return err("file_not_found");
      const reads = (infoReads.get(file.id) ?? 0) + 1;
      infoReads.set(file.id, reads);
      if (reads > (options.processedAfter ?? 0)) file.mimetype = file.name.endsWith(".png") ? "image/png" : "application/octet-stream";
      const info = { id: file.id, name: file.name, title: file.title, mimetype: file.mimetype };
      if (file.mimetype.startsWith("image/")) info["thumb_64"] = `https://files.slack.com/thumb/${file.id}_64.png`;
      return { body: { ok: true, file: info } };
    },
    "files.delete": ({ body }) => {
      const id = body["file"];
      if (!files.delete(id)) return err("file_not_found");
      writes.push(["delete_file", id]);
      return { body: { ok: true } };
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
  return { client: c, calls, messages, files, writes, routes };
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