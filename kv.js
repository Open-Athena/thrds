import {
  base64,
  unbase64
} from "./chunk-VQVZ7N35.js";
import "./chunk-3ZH5IQC7.js";

// src/kv.ts
var JSON_CODEC = { decode: (raw) => JSON.parse(raw), encode: (state) => JSON.stringify(state) };
function kvStore(kv, options = {}) {
  const prefix = options.prefix ?? "thrds:slots:";
  const codec = options.codec ?? JSON_CODEC;
  return {
    async get(key) {
      const s = await kv.get(prefix + key);
      return s === null ? void 0 : codec.decode(s);
    },
    async put(key, state, lease) {
      if (lease !== void 0) throw new TypeError("kvStore has no leases (KV can't compare-and-swap); use d1Store");
      await kv.put(prefix + key, codec.encode(state));
      return true;
    }
  };
}
function durableObjectStore(storage, options = {}) {
  const prefix = options.prefix ?? "slots/";
  return {
    async get(key) {
      return storage.get(prefix + key);
    },
    async put(key, state, lease) {
      if (lease !== void 0) throw new TypeError("durableObjectStore has no leases: the object already runs one request at a time");
      await storage.put(prefix + key, state);
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
  JSON_CODEC,
  durableObjectStore,
  kvAvatarStore,
  kvStore
};
//# sourceMappingURL=kv.js.map