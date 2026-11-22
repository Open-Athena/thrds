/**
 * The standalone review page `slck rewrite review PLAN` serves: `PlanView` over the server's `/plan`, with `Check`
 * and `Apply` posting the selected ts to `/check` and `/apply`. Bundled with React into `dist/review/` (`pnpm
 * build:review`) and vendored into the Python package.
 */
import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { parsePlan, type PlannedAction, type RewriteOutcome, type RewritePlan } from "../rewrite.js";
import { PLAN_VIEW_CSS, PlanView } from "./index.js";

interface Loaded {
  path: string;
  plan: RewritePlan;
}

async function post(endpoint: string, actions: PlannedAction[]): Promise<RewriteOutcome[]> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: actions.map((a) => a.ts) }),
  });
  const body = (await res.json()) as { outcomes?: RewriteOutcome[]; error?: string };
  if (!res.ok || body.outcomes === undefined) throw new Error(body.error ?? `${endpoint}: HTTP ${res.status}`);
  return body.outcomes;
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
            onCheck={async (sel) => record(await post("/check", sel))}
            onApply={async (sel) => record(await post("/apply", sel))}
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
