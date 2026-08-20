"use client";
import { useEffect, useState } from "react";

type Review = { id: number; createdAt: string; periodStart: string; periodEnd: string; markdown: string };

/** Minimal markdown: ## headings, - bullets, paragraphs. Enough for the coach's fixed format. */
function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { blocks.push(<ul key={blocks.length} className="list-disc pl-5 space-y-1">{list.map((l, i) => <li key={i}>{l}</li>)}</ul>); list = []; } };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line.startsWith("#")) { flush(); blocks.push(<h3 key={blocks.length} className="mt-3 font-semibold text-green-400">{line.replace(/^#+\s*/, "")}</h3>); }
    else if (/^[-*]\s/.test(line)) list.push(line.replace(/^[-*]\s/, ""));
    else { flush(); blocks.push(<p key={blocks.length}>{line}</p>); }
  }
  flush();
  return <div className="space-y-2 text-sm text-neutral-200">{blocks}</div>;
}

export function CoachReview() {
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);

  useEffect(() => {
    fetch("/api/ai/review").then(async (r) => {
      if (r.status === 401) { window.location.href = "/login"; return; }
      if (r.ok) setReview(await r.json());
    }).catch(() => {});
  }, []);

  async function generate() {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/ai/review", { method: "POST" });
      if (r.status === 503) { setConfigured(false); return; }
      if (r.status === 401) { window.location.href = "/login"; return; }
      if (!r.ok) { setError("Review failed — previous one kept."); return; }
      setReview(await r.json());
    } catch { setError("Network error."); }
    finally { setBusy(false); }
  }

  if (!configured) return <section className="rounded bg-neutral-900 p-4 text-sm text-neutral-400">Weekly review needs <code>ANTHROPIC_API_KEY</code> on the server.</section>;

  return (
    <section className="rounded bg-neutral-900 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Coach review</h2>
        <button onClick={generate} disabled={busy} className="rounded bg-neutral-700 px-3 py-1 text-sm disabled:opacity-50">
          {busy ? "Reviewing…" : review ? "Review again" : "Review my week"}
        </button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {review ? (
        <>
          <p className="text-xs text-neutral-500">{review.periodStart} → {review.periodEnd} · generated {new Date(review.createdAt).toLocaleDateString()}</p>
          <Markdown text={review.markdown} />
        </>
      ) : (
        <p className="text-sm text-neutral-400">No review yet. The coach reads your last 14 days of sets, meals, cardio and weight.</p>
      )}
    </section>
  );
}
