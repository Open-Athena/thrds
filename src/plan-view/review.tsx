/**
 * The standalone review page `slck rewrite review PLAN` serves: `PlanView` over the server's `/plan`, with `Check`
 * and `Apply` posting the selected ts to `/check` and `/apply` (`postRewrite`, in batches). Bundled with React into
 * `dist/review/` (`pnpm build:review`) and vendored into the Python package.
 */
import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { parsePlan, postRewrite, type PlannedAction, type RewriteOutcome, type RewritePlan } from "../rewrite.js";
import { PLAN_VIEW_CSS, PlanView } from "./index.js";

interface Loaded {
  path: string;
  plan: RewritePlan;
}

function App(): ReactNode {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, RewriteOutcome>>({});

  useEffect(() => {
    fetch("/plan")
      .then((r) => r.json())
      .then((d: { path: string; plan: unknown }) => {
        setLoaded({ path: d.path, plan: parsePlan(d.plan) });
        document.title = `Rewrite: ${d.path}`;
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const record = (os: RewriteOutcome[]) => setOutcomes((prev) => ({ ...prev, ...Object.fromEntries(os.map((o) => [o.ts, o])) }));
  // In batches, each batch's outcomes shown as it lands.
  const send = async (op: "check" | "apply", sel: PlannedAction[]) => {
    await postRewrite(`/${op}`, sel.map((a) => a.ts), { onOutcomes: record });
  };

  return (
    <div className="tpv tpv-page">
      <style>{PLAN_VIEW_CSS}</style>
      {error !== null ? (
        <div className="tpv-error">{error}</div>
      ) : loaded === null ? (
        <div className="tpv-muted">Loading the plan…</div>
      ) : (
        <>
          <h1 className="tpv-title">
            Rewrite plan <code>{loaded.path}</code>
          </h1>
          <PlanView
            unstyled
            plan={loaded.plan}
        outcomes={outcomes}
            onCheck={(sel) => send("check", sel)}
            onApply={(sel) => send("apply", sel)}
          />
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
