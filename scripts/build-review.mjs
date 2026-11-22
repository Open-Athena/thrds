// Bundles the standalone review page (`src/plan-view/review.tsx`, React included) into `dist/review/`, with its HTML
// shell. The Python package vendors that directory for `slck rewrite review` (`thrds/rewrite_review/`). Not part of
// `build`: npm consumers get `./plan-view` and bring their own React.
import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const out = "dist/review";
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["src/plan-view/review.tsx"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: `${out}/review.js`,
  legalComments: "none",
});
await copyFile("src/plan-view/review.html", `${out}/index.html`);
