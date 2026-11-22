import { defineConfig } from "tsup";

export default defineConfig({
  // One entry per subpath export: posting-only consumers never load the receiver, D1, KV or avatar code.
  entry: {
    index: "src/index.ts",
    avatar: "src/avatar.ts",
    d1: "src/d1.ts",
    kv: "src/kv.ts",
    receiver: "src/receiver.ts",
    testing: "src/testing.ts",
    "plan-view": "src/plan-view/index.tsx",
  },
  // React is an optional peer (only `./plan-view` uses it): never bundle it.
  external: ["react", "react/jsx-runtime", "react-dom"],
  format: ["esm"],
  // `./plan-view` is DOM code (`tsconfig.plan-view.json`); the main tsconfig leaves DOM out so `fetch` keeps Node's types.
  dts: { compilerOptions: { lib: ["ES2022", "DOM", "DOM.Iterable"] } },
  sourcemap: true,
  clean: true,
  target: "node22",
  // The D1 schema ships in dist/ (the dist branch carries only dist/), exported as `./schema/thrds.sql`.
  onSuccess: "cp schema/thrds.sql dist/thrds.sql",
});
