import {
  base64,
  unbase64
} from "./chunk-UJ6N63EC.js";
import "./chunk-YSTFV535.js";

// src/kv.ts
function kvStore(kv, options = {}) {
  const prefix = options.prefix ?? "thrds:slots:";
  return {
    async get(key) {
      const s = await kv.get(prefix + key);
      return s === null ? void 0 : JSON.parse(s);
    },
    async put(key, state, lease) {
      if (lease !== void 0) throw new TypeError("kvStore has no leases (KV can't compare-and-swap); use d1Store");
      await kv.put(prefix + key, JSON.stringify(state));
      return true;
    }
  };
}
function kvAvatarStore(kv, options = {}) {
  const prefix = options.prefix ?? "thrds:avatar:";
  return {
    async put(sha, img) {
      if (await kv.get(prefix + sha) !== null) return;
      await kv.put(prefix + sha, JSON.stringify({ type: img.type, data: base64(img.bytes) }));
    },
    async get(sha) {
      const s = await kv.get(prefix + sha);
      if (s === null) return null;
      const { type, data } = JSON.parse(s);
      return { type, bytes: unbase64(data) };
    }
  };
}
export {
  kvAvatarStore,
  kvStore
};
//# sourceMappingURL=kv.js.map