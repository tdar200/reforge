"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { Proposal, ParsedLog } from "@/lib/ai/schemas";

type Ex = { id: number; name: string };
type Status = "idle" | "parsing" | "saving";

const EXAMPLE = "bench 3x8 at 60, lateral raises 3x15 at 8, 20 min bike, oats + whey, weight 79.6";

export function QuickLog({ date, onSaved }: { date: string; onSaved: () => void }) {
  const [text, setText] = useState("");
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [exs, setExs] = useState<Ex[]>([]);
  const [configured, setConfigured] = useState(true);

  useEffect(() => { api<Ex[]>("/api/exercises").then(setExs).catch(() => {}); }, []);

  async function parse() {
    setStatus("parsing"); setError(null);
    try {
      const res = await fetch("/api/ai/parse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, date }) });
      if (res.status === 503) { setConfigured(false); return; }
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) { setError("Couldn't parse that — try a shorter line."); return; }
      const parsed = (await res.json()) as ParsedLog;
      setItems(parsed.items); setNote(parsed.note);
      if (parsed.items.length === 0) setError("Nothing loggable found in that text.");
    } catch { setError("Network error."); }
    finally { setStatus("idle"); }
  }

  async function save() {
    if (!items?.length) return;
    if (items.some((i) => i.kind === "set" && i.exerciseId === null)) { setError("Pick an exercise for every set before saving."); return; }
    setStatus("saving"); setError(null);
    try {
      await api("/api/ai/commit", { method: "POST", body: JSON.stringify({ date, items }) });
      setItems(null); setNote(null); setText("");
      onSaved();
    } catch { setError("Save failed — nothing was written."); }
    finally { setStatus("idle"); }
  }

  function update(idx: number, patch: Partial<Proposal>) {
    setItems((cur) => cur!.map((it, i) => (i === idx ? ({ ...it, ...patch } as Proposal) : it)));
  }
  function remove(idx: number) { setItems((cur) => cur!.filter((_, i) => i !== idx)); }

  if (!configured) return <section className="rounded bg-neutral-900 p-4 text-sm text-neutral-400">Quick log needs <code>ANTHROPIC_API_KEY</code> on the server.</section>;

  const num = (v: number, onChange: (n: number) => void, step = "any") => (
    <input className="w-16 rounded bg-neutral-800 p-1 text-right" inputMode="decimal" step={step} value={v}
      onChange={(e) => onChange(Number(e.target.value))} />
  );

  return (
    <section className="rounded bg-neutral-900 p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">Quick log</h2>
        <span className="text-xs text-neutral-500">AI · Claude</span>
      </div>
      <textarea className="w-full rounded bg-neutral-800 p-2 text-sm" rows={2} placeholder={EXAMPLE}
        value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
      <div className="flex gap-2">
        <button onClick={parse} disabled={!text.trim() || status !== "idle"} className="rounded bg-green-600 px-3 py-1 text-sm disabled:opacity-50">
          {status === "parsing" ? "Parsing…" : "Parse"}
        </button>
        {items && <button onClick={save} disabled={status !== "idle"} className="rounded bg-neutral-700 px-3 py-1 text-sm disabled:opacity-50">
          {status === "saving" ? "Saving…" : `Save ${items.length}`}
        </button>}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {note && <p className="text-xs text-amber-400">Not mapped: {note}</p>}
      {items && (
        <ul className="space-y-2">
          {items.map((it, idx) => (
            <li key={idx} className="flex items-center gap-2 rounded bg-neutral-800/60 p-2 text-sm">
              <span className="w-12 text-xs uppercase text-neutral-500">{it.kind}</span>
              {it.kind === "set" && (<>
                <select className="flex-1 rounded bg-neutral-800 p-1" value={it.exerciseId ?? ""} onChange={(e) => update(idx, { exerciseId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">{it.exerciseName} — pick exercise</option>
                  {exs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
                {num(it.sets, (n) => update(idx, { sets: n }), "1")}<span>×</span>
                {num(it.reps, (n) => update(idx, { reps: n }), "1")}<span>@</span>
                {num(it.weight, (n) => update(idx, { weight: n }))}<span>kg</span>
              </>)}
              {it.kind === "cardio" && (<>
                <span className="flex-1">{it.type}</span>{num(it.minutes, (n) => update(idx, { minutes: n }), "1")}<span>min</span>
              </>)}
              {it.kind === "meal" && (<>
                <span className="flex-1">{it.name}{it.estimated && <span className="ml-1 text-xs text-amber-400">est.</span>}</span>
                {num(it.kcal, (n) => update(idx, { kcal: n }), "1")}<span>kcal</span>
                {num(it.proteinG, (n) => update(idx, { proteinG: n }))}<span>g</span>
              </>)}
              {it.kind === "metric" && (<>
                <span className="flex-1">{it.field}</span>{num(it.value, (n) => update(idx, { value: n }))}<span>{it.field === "bodyweight" ? "kg" : "cm"}</span>
              </>)}
              <button onClick={() => remove(idx)} className="text-red-400">✕</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
