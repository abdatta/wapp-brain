import { AlertTriangle, ArrowLeft, CheckCircle2, FilePlus2, Loader2, Play, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type {
  BrainClaimGradeValue,
  BrainEvalGateVerdict,
  BrainEvalRunRecord,
  BrainGoldenSetInfo,
  BrainGradingSample,
  BrainGradingSampleClaim,
  BrainModelQualityAggregate
} from "../../../shared/types";
import {
  getBrainEvalGate,
  getBrainEvalGolden,
  getBrainGradingSample,
  getBrainModelQuality,
  gradeBrainClaim,
  listBrainEvalRuns,
  runBrainEval,
  scaffoldBrainEvalGolden
} from "../../api";
import { useToast } from "../../state/ToastContext";

// The eval & grading work surface (design E8): golden-set identity, recall
// runs with baseline deltas, the one-claim-at-a-time grading strip, and the
// per-model quality table. Everything here is zero-LLM; grades are the user's
// ground truth and survive every brain wipe.

const GRADE_DEFINITIONS: Array<{ grade: BrainClaimGradeValue; label: string; hint: string }> = [
  { grade: "supported", label: "Supported", hint: "The cited messages establish the claim." },
  { grade: "partial", label: "Partial", hint: "Grounded but imprecise or overstated." },
  { grade: "unsupported", label: "Unsupported", hint: "The citations do not establish it." },
  { grade: "unclear", label: "Can't judge", hint: "Not enough context to grade (excluded from precision)." }
];

const percent = (value: number | null | undefined, digits = 1): string =>
  value == null ? "—" : `${(value * 100).toFixed(digits)}%`;

// Always carry the year: graders verify claims' absolute dates against these
// lines, and archive messages span a decade.
const formatWhen = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

type GoldenState = { path: string; exists: boolean; info: BrainGoldenSetInfo | null; error?: string };
type GateBundle = { run: BrainEvalRunRecord; baseline: BrainEvalRunRecord | null; gate: BrainEvalGateVerdict };

export function BrainEvalPage() {
  const { setNotice, setError } = useToast();
  const [golden, setGolden] = useState<GoldenState | null>(null);
  const [runs, setRuns] = useState<BrainEvalRunRecord[]>([]);
  const [gateBundle, setGateBundle] = useState<GateBundle | null>(null);
  const [sample, setSample] = useState<BrainGradingSample | null>(null);
  const [queue, setQueue] = useState<BrainGradingSampleClaim[]>([]);
  const [gradedDelta, setGradedDelta] = useState<Record<string, number>>({});
  const [aggregates, setAggregates] = useState<BrainModelQualityAggregate[]>([]);
  const [includeGraded, setIncludeGraded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [grading, setGrading] = useState(false);

  const loadSample = useCallback(
    async (withGraded: boolean) => {
      const nextSample = await getBrainGradingSample({ perModel: 20, includeGraded: withGraded });
      setSample(nextSample);
      setQueue(nextSample.models.flatMap((model) => model.claims));
      setGradedDelta({});
    },
    []
  );

  const refreshAll = useCallback(async () => {
    setBusy("loading");
    try {
      const [goldenState, runList, quality] = await Promise.all([getBrainEvalGolden(), listBrainEvalRuns({ limit: 10 }), getBrainModelQuality()]);
      setGolden(goldenState);
      setRuns(runList);
      setAggregates(quality);
      await loadSample(includeGraded);
      if (runList.length > 0) {
        setGateBundle(await getBrainEvalGate({ runId: runList[0].id }));
      } else {
        setGateBundle(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the eval surface.");
    } finally {
      setBusy(null);
    }
  }, [includeGraded, loadSample, setError]);

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleScaffold() {
    setBusy("scaffold");
    setError(null);
    try {
      const result = await scaffoldBrainEvalGolden();
      setNotice(`Golden set scaffolded at ${result.info.path} — replace the example with real queries, then run the eval.`);
      setGolden(await getBrainEvalGolden());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not scaffold the golden set.");
    } finally {
      setBusy(null);
    }
  }

  async function handleRunEval() {
    setBusy("run");
    setError(null);
    try {
      const result = await runBrainEval();
      setRuns((current) => [result.run, ...current].slice(0, 10));
      setGateBundle(result);
      const overall = result.run.totals.recallAtK["10"] ?? result.run.totals.recallAtK[String(result.run.kValues[0])];
      setNotice(
        `Eval complete — overall r@10 ${percent(overall)} across ${result.run.totals.queries} queries` +
          (result.gate.verdict === "pass" ? " · meets the baseline." : result.gate.verdict === "fail" ? " · REGRESSED below the baseline." : " · first run with this golden set (new baseline).")
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "The eval run failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleGrade(claim: BrainGradingSampleClaim, grade: BrainClaimGradeValue) {
    setGrading(true);
    setError(null);
    try {
      await gradeBrainClaim(claim.claimId, grade);
      setQueue((current) => current.filter((entry) => entry.claimId !== claim.claimId));
      const model = claim.model ?? "unknown";
      setGradedDelta((current) => ({ ...current, [model]: (current[model] ?? 0) + 1 }));
      // Aggregates are cheap; keep the precision table live as grades land.
      setAggregates(await getBrainModelQuality());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the grade.");
    } finally {
      setGrading(false);
    }
  }

  async function handleToggleIncludeGraded() {
    const next = !includeGraded;
    setIncludeGraded(next);
    setBusy("sample");
    try {
      await loadSample(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reload the grading sample.");
    } finally {
      setBusy(null);
    }
  }

  const currentClaim = queue[0] ?? null;
  const latestRun = gateBundle?.run ?? runs[0] ?? null;
  const baselineByClass = useMemo(() => {
    if (!gateBundle?.baseline || gateBundle.baseline.goldenHash !== gateBundle.run.goldenHash) {
      return null;
    }
    return new Map(gateBundle.baseline.perClass.map((stat) => [stat.class, stat]));
  }, [gateBundle]);

  return (
    <div className="evalPage">
      <header className="evalHeader">
        <Link className="evalBackLink" to="/brain">
          <ArrowLeft size={14} /> Brain
        </Link>
        <h2>Eval &amp; grading</h2>
        <p className="brainHint">
          Golden-set retrieval recall and manual claim grading — the measurements that gate retrieval changes and pick the backfill
          model. Zero model calls; grades survive every brain reset.
        </p>
      </header>

      <section className="evalCard">
        <h3>Golden query set</h3>
        {!golden ? (
          <p className="brainHint">Loading…</p>
        ) : golden.info ? (
          <>
            <div className="evalGoldenLine">
              <strong>v{golden.info.version}</strong>
              <span className="evalHash">{golden.info.hash}</span>
              <span>{golden.info.queryCount} queries</span>
              <span>classes: {golden.info.classes.join(", ")}</span>
            </div>
            <p className="brainHint">
              Lives at <code>{golden.path}</code> (outside git — real queries quote your archive). Edit the file, bump{" "}
              <code>version</code>, and re-run; runs record the content hash so results only compare within identical golden content.
            </p>
          </>
        ) : golden.exists ? (
          <div className="brainDueAlert">
            <AlertTriangle size={14} />
            <span>The golden set exists but does not validate: {golden.error}</span>
          </div>
        ) : (
          <>
            <p className="brainHint">
              No golden set yet. Scaffold one at <code>{golden.path}</code>, then fill it with real queries (each with the message
              keys the search should surface).
            </p>
            <button type="button" className="evalButton" onClick={() => void handleScaffold()} disabled={busy === "scaffold"}>
              {busy === "scaffold" ? <Loader2 className="spin" size={14} /> : <FilePlus2 size={14} />} Scaffold golden set
            </button>
          </>
        )}
      </section>

      <section className="evalCard">
        <div className="evalCardHeader">
          <h3>Recall runs</h3>
          <button
            type="button"
            className="evalButton"
            onClick={() => void handleRunEval()}
            disabled={busy === "run" || !golden?.info}
            title={golden?.info ? "Run every golden query through the real search path (no model calls)." : "Add a golden set first."}
          >
            {busy === "run" ? <Loader2 className="spin" size={14} /> : <Play size={14} />} Run eval
          </button>
        </div>
        {latestRun ? (
          <>
            <div className="evalGoldenLine">
              {gateBundle?.gate.verdict === "pass" && (
                <span className="evalVerdict pass">
                  <CheckCircle2 size={13} /> meets baseline
                </span>
              )}
              {gateBundle?.gate.verdict === "fail" && (
                <span className="evalVerdict fail">
                  <AlertTriangle size={13} /> regressed vs baseline
                </span>
              )}
              {gateBundle?.gate.verdict === "no-baseline" && <span className="evalVerdict">first run at this golden version</span>}
              <span>
                latest: {formatWhen(latestRun.ranAtMs)} · golden v{latestRun.goldenVersion} ({latestRun.goldenHash}) ·{" "}
                {latestRun.totals.queries}/{latestRun.queryCount} scored
              </span>
            </div>
            <div className="evalTableWrap">
              <table className="evalTable">
                <thead>
                  <tr>
                    <th>class</th>
                    <th>n</th>
                    {latestRun.kValues.map((k) => (
                      <th key={k}>r@{k}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {latestRun.perClass.map((stat) => {
                    const baselineStat = baselineByClass?.get(stat.class);
                    return (
                      <tr key={stat.class}>
                        <td>{stat.class}</td>
                        <td>{stat.queries}</td>
                        {latestRun.kValues.map((k) => {
                          const value = stat.recallAtK[String(k)];
                          const baseValue = baselineStat?.recallAtK[String(k)];
                          const delta = value != null && baseValue != null ? value - baseValue : null;
                          return (
                            <td key={k}>
                              {percent(value)}
                              {delta != null && delta !== 0 && (
                                <span className={`evalDelta ${delta > 0 ? "up" : "down"}`}>
                                  {" "}
                                  {delta > 0 ? "+" : ""}
                                  {(delta * 100).toFixed(1)}
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  <tr className="evalTotalsRow">
                    <td>overall</td>
                    <td>{latestRun.totals.queries}</td>
                    {latestRun.kValues.map((k) => (
                      <td key={k}>{percent(latestRun.totals.recallAtK[String(k)])}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            {latestRun.skippedQueryIds.length > 0 && (
              <p className="brainHint">
                Skipped (expected message no longer exists — fix the golden set): {latestRun.skippedQueryIds.join(", ")}
              </p>
            )}
            {runs.length > 1 && (
              <div className="evalTableWrap">
                <table className="evalTable evalHistory">
                  <thead>
                    <tr>
                      <th>ran</th>
                      <th>golden</th>
                      {(runs[0]?.kValues ?? []).map((k) => (
                        <th key={k}>r@{k}</th>
                      ))}
                      <th>notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr key={run.id}>
                        <td>{formatWhen(run.ranAtMs)}</td>
                        <td>
                          v{run.goldenVersion} · {run.goldenHash.slice(0, 8)}
                        </td>
                        {(runs[0]?.kValues ?? []).map((k) => (
                          <td key={k}>{percent(run.totals.recallAtK[String(k)])}</td>
                        ))}
                        <td>{run.notes ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <p className="brainHint">
            No runs yet. {golden?.info ? "Run the eval to record the first baseline." : "Add a golden set, then run the eval."}
          </p>
        )}
      </section>

      <section className="evalCard">
        <div className="evalCardHeader">
          <h3>Claim grading</h3>
          <div className="evalCardActions">
            <label className="evalToggle" title="Also load already-graded claims, e.g. to revise a grade.">
              <input type="checkbox" checked={includeGraded} onChange={() => void handleToggleIncludeGraded()} />
              include graded
            </label>
            <button type="button" className="evalButton" onClick={() => void refreshAll()} disabled={busy != null}>
              {busy === "loading" || busy === "sample" ? <Loader2 className="spin" size={14} /> : <RefreshCcw size={14} />} Refresh
            </button>
          </div>
        </div>
        {sample && sample.models.length > 0 && (
          <div className="evalGoldenLine">
            {sample.models.map((model) => {
              const graded = model.gradedClaims + (gradedDelta[model.model] ?? 0);
              return (
                <span key={model.model} className="evalModelProgress">
                  {graded}/{model.eligibleClaims} graded · {model.model}
                </span>
              );
            })}
          </div>
        )}
        {!sample || sample.models.length === 0 ? (
          <p className="brainHint">
            Nothing to grade yet — grading samples come from current model-generated episodes. Assimilate chats with a model first
            (extractive placeholders are not gradeable).
          </p>
        ) : currentClaim ? (
          <div className="evalGradeCard">
            <div className="evalGoldenLine">
              <span className="evalChip">{currentClaim.kind}</span>
              <span className="evalChip">{currentClaim.confidence}</span>
              <span className="evalChip">
                {currentClaim.model ?? "unknown"} · v{currentClaim.extractionVersion}
              </span>
              {currentClaim.chatDisplayName && <span>{currentClaim.chatDisplayName}</span>}
              {currentClaim.grade && <span className="evalChip graded">previously: {currentClaim.grade}</span>}
            </div>
            <p className="evalClaimText">{currentClaim.text}</p>
            <div className="evalCitations">
              {currentClaim.citations.map((citation) => (
                <div key={citation.sourceMessageKey} className="evalCitation">
                  <span className="evalCitationMeta">
                    {citation.timestampMs ? formatWhen(citation.timestampMs) : "unknown time"}
                    {citation.senderSourceJid ? ` · ${citation.senderSourceJid}` : ""}
                  </span>
                  {citation.present ? (
                    <span className={citation.deleted ? "evalCitationDeleted" : undefined}>
                      {citation.text ?? "[no text]"}
                      {citation.deleted ? " (deleted later)" : ""}
                    </span>
                  ) : (
                    <span className="evalCitationDeleted">[cited message no longer exists in the archive]</span>
                  )}
                </div>
              ))}
            </div>
            <div className="evalGradeButtons">
              {GRADE_DEFINITIONS.map((definition) => (
                <button
                  key={definition.grade}
                  type="button"
                  className={`evalGradeButton ${definition.grade}`}
                  onClick={() => void handleGrade(currentClaim, definition.grade)}
                  disabled={grading}
                  title={definition.hint}
                >
                  {definition.label}
                  <small>{definition.hint}</small>
                </button>
              ))}
            </div>
            <p className="brainHint">{queue.length - 1} more in this sample.</p>
          </div>
        ) : (
          <p className="brainHint">
            Every sampled claim is graded. Refresh for a new sample, or tick "include graded" to revise earlier grades.
          </p>
        )}
      </section>

      <section className="evalCard">
        <h3>Model quality</h3>
        {aggregates.length === 0 ? (
          <p className="brainHint">No model episodes yet — quality aggregates appear after the first model-backed assimilation.</p>
        ) : (
          <div className="evalTableWrap">
            <table className="evalTable">
              <thead>
                <tr>
                  <th>model</th>
                  <th>v</th>
                  <th title="Model episodes committed / attempts that fell back to extractive">episodes</th>
                  <th title="Fallbacks over attempts">fallback</th>
                  <th title="supported / (supported + partial + unsupported)">precision</th>
                  <th title="supported · partial · unsupported · can't-judge">grades</th>
                  <th title="Anchoring-lint warnings over committed claims">unanchored</th>
                  <th title="Validation errors recorded for this model's attempts">errors</th>
                </tr>
              </thead>
              <tbody>
                {aggregates.map((aggregate) => (
                  <tr key={`${aggregate.model}|${aggregate.extractionVersion}`}>
                    <td>{aggregate.model}</td>
                    <td>{aggregate.extractionVersion}</td>
                    <td>
                      {aggregate.modelEpisodes}
                      {aggregate.fallbackEpisodes > 0 ? ` (+${aggregate.fallbackEpisodes} fell back)` : ""}
                    </td>
                    <td>{aggregate.attempted > 0 ? `${percent(aggregate.fallbackRate)} of ${aggregate.attempted}` : "—"}</td>
                    <td>{aggregate.strictPrecision == null ? "— (no grades)" : `${percent(aggregate.strictPrecision)} of ${aggregate.grades.supported + aggregate.grades.partial + aggregate.grades.unsupported}`}</td>
                    <td>
                      {aggregate.grades.supported} · {aggregate.grades.partial} · {aggregate.grades.unsupported} ·{" "}
                      {aggregate.grades.unclear}
                    </td>
                    <td>{aggregate.claims > 0 ? `${aggregate.unanchoredWarnings}/${aggregate.claims}` : "—"}</td>
                    <td>{aggregate.validationErrors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="brainHint">
          The backfill model decision reads from this table: precision and fallback per model on <em>this</em> archive, not external
          benchmarks. Sample sizes are shown beside every rate — thin data looks thin on purpose.
        </p>
      </section>
    </div>
  );
}
