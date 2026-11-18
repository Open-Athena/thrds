import { defineConfig } from "tsup";

export default defineConfig({
  // One entry per subpath export: posting-only consumers never load the receiver, D1, KV or avatar code.
  entry: {
    index: "src/index.ts",
    avatar: "src/avatar.ts",
    d1: "src/d1.ts",
    kv: "src/kv.ts",
    receiver: "src/receiver.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
});
