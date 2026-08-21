"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { todayIso } from "@/lib/today";
import { sumDiet } from "@/lib/logic";
import type { NutritionPanel } from "@/lib/ai/nutrition";

type Panel = NutritionPanel;
type Entry = { id: number; name: string; kcal: number; proteinG: number; nutrition: Panel | null };
type Preset = { id: number; name: string; kcal: number; proteinG: number };
type Settings = { calorieTarget: number; proteinTarget: number };

const VERDICT_STYLE = { good: "bg-green-600/20 text-green-400", ok: "bg-amber-600/20 text-amber-400", poor: "bg-red-600/20 text-red-400" } as const;

const PANEL_ROWS: [string, (p: Panel) => number, string][] = [
  ["Carbs", (p) => p.macros.carbsG, "g"], ["Fat", (p) => p.macros.fatG, "g"],
  ["Sat fat", (p) => p.macros.saturatedFatG, "g"], ["Fibre", (p) => p.macros.fiberG, "g"],
  ["Sugar", (p) => p.macros.sugarG, "g"], ["Salt", (p) => p.macros.saltG, "g"],
  ["Vit A", (p) => p.micros.vitaminA_ug, "µg"], ["Vit C", (p) => p.micros.vitaminC_mg, "mg"],
  ["Vit D", (p) => p.micros.vitaminD_ug, "µg"], ["Vit E", (p) => p.micros.vitaminE_mg, "mg"],
  ["B12", (p) => p.micros.vitaminB12_ug, "µg"], ["Folate", (p) => p.micros.folate_ug, "µg"],
  ["Calcium", (p) => p.micros.calcium_mg, "mg"], ["Iron", (p) => p.micros.iron_mg, "mg"],
  ["Potassium", (p) => p.micros.potassium_mg, "mg"], ["Magnesium", (p) => p.micros.magnesium_mg, "mg"],
  ["Zinc", (p) => p.micros.zinc_mg, "mg"],
];

// The estimate calls a model, so it can take several seconds; one dropped request on a
// slow connection should not end the attempt. Bounded, retried once, then reported honestly.
async function postJson(url: string, body: unknown): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

type EstimateResponse = {
  kcal: number; proteinG: number;
  source?: "label" | "estimate";
  matchedName?: string | null;
  servingG?: number | null;
  servingSource?: "label" | "estimate" | null;
};

// Product names come from a public, world-writable database: strip control and
// direction-override characters and cap the length before showing them as app copy.
function safeName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
}

function noteFor(est: EstimateResponse): string {
  if (est.source !== "label" || !est.matchedName) return "Estimated by the coach — no matching product label found.";
  const portion = est.servingG
    ? ` for ${est.servingG}${est.servingSource === "label" ? "" : " (assumed)"} g/ml`
    : "";
  return `From the “${safeName(est.matchedName)}” label${portion} — delete and re-add with your own numbers if that is the wrong product.`;
}

export default function Diet() {
  const date = todayIso();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [settings, setSettings] = useState<Settings>({ calorieTarget: 2000, proteinTarget: 170 });
  const [form, setForm] = useState({ name: "", kcal: "", proteinG: "" });
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [rowErr, setRowErr] = useState<Record<number, string>>({});
  const [estimating, setEstimating] = useState(false);
  const [formErr, setFormErr] = useState("");
  const [formNote, setFormNote] = useState("");

  // Generation guard: overlapping loads can resolve out of order and an older
  // response would otherwise wipe a freshly analyzed panel out of client state.
  const loadSeq = useRef(0);
  async function load() {
    const seq = ++loadSeq.current;
    const [e, p, st] = await Promise.all([
      api<Entry[]>(`/api/diet?date=${date}`),
      api<Preset[]>(`/api/presets`),
      api<Settings>(`/api/settings`),
    ]);
    if (seq !== loadSeq.current) return;
    setEntries(e); setPresets(p); setSettings(st);
  }
  useEffect(() => { load(); }, []);

  const total = sumDiet(entries);

  async function add(name: string, kcal: number, proteinG: number) {
    await api(`/api/diet`, { method: "POST", body: JSON.stringify({ date, name, kcal, proteinG }) });
    load();
  }
  async function addFromForm(e: React.FormEvent) {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) return;
    let kcal = Number(form.kcal);
    let proteinG = Number(form.proteinG);
    setFormErr(""); setFormNote("");
    if (!form.kcal.trim() || !form.proteinG.trim()) {
      setEstimating(true);
      try {
        const res = await postJson("/api/ai/estimate", { name });
        if (res.status === 401) { window.location.href = "/login"; return; }
        if (res.status === 503) { setFormErr("Estimating needs OPENAI_API_KEY — type the numbers instead."); return; }
        if (!res.ok) { setFormErr("Couldn't estimate that — type the numbers instead."); return; }
        const est = (await res.json()) as EstimateResponse;
        if (!form.kcal.trim()) kcal = est.kcal;
        if (!form.proteinG.trim()) proteinG = est.proteinG;
        setFormNote(noteFor(est));
      } catch { setFormErr("Couldn't reach the coach — check your connection, or type the numbers in."); return; }
      finally { setEstimating(false); }
    }
    try {
      await add(name, kcal, proteinG);
    } catch {
      setFormErr("Couldn't save that — check the numbers.");
      return;
    }
    setForm({ name: "", kcal: "", proteinG: "" });
  }
  async function savePreset() {
    if (!form.name) return;
    await api(`/api/presets`, { method: "POST", body: JSON.stringify({ name: form.name, kcal: Number(form.kcal), proteinG: Number(form.proteinG) }) });
    load();
  }
  async function del(id: number) {
    await api(`/api/diet/${id}`, { method: "DELETE" });
    setOpen(({ [id]: _o, ...rest }) => rest);
    setRowErr(({ [id]: _e, ...rest }) => rest);
    load();
  }

  async function analyze(en: Entry) {
    setRowErr((r) => ({ ...r, [en.id]: "" }));
    if (en.nutrition) { setOpen((o) => ({ ...o, [en.id]: !o[en.id] })); return; }
    setBusy(en.id);
    try {
      const res = await postJson("/api/ai/nutrition", { entryId: en.id });
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (res.status === 503) { setRowErr((r) => ({ ...r, [en.id]: "Needs OPENAI_API_KEY on the server." })); return; }
      if (!res.ok) { setRowErr((r) => ({ ...r, [en.id]: "Analysis failed — try again." })); return; }
      const { nutrition } = (await res.json()) as { nutrition: Panel };
      setEntries((cur) => cur.map((e) => (e.id === en.id ? { ...e, nutrition, kcal: nutrition.macros.kcal, proteinG: nutrition.macros.proteinG } : e)));
      setOpen((o) => ({ ...o, [en.id]: true }));
    } catch { setRowErr((r) => ({ ...r, [en.id]: "Couldn't reach the coach — check your connection." })); }
    finally { setBusy(null); }
  }

  return (
    <main className="p-4 space-y-4">
      <h1 className="text-xl font-bold">Diet · {date}</h1>
      <div className="flex gap-4 rounded bg-neutral-900 p-4">
        <div>{total.kcal} / {settings.calorieTarget} kcal</div>
        <div>{Math.round(total.proteinG)} / {settings.proteinTarget} g protein</div>
      </div>

      <form onSubmit={addFromForm} className="grid grid-cols-4 gap-2">
        <input className="col-span-4 rounded bg-neutral-800 p-2" placeholder="Food" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className="rounded bg-neutral-800 p-2" inputMode="numeric" placeholder="kcal" value={form.kcal} onChange={(e) => setForm({ ...form, kcal: e.target.value })} />
        <input className="rounded bg-neutral-800 p-2" inputMode="numeric" placeholder="protein" value={form.proteinG} onChange={(e) => setForm({ ...form, proteinG: e.target.value })} />
        <button disabled={estimating} className="rounded bg-green-600 p-2 disabled:opacity-50">{estimating ? "Estimating…" : "Add"}</button>
        <button type="button" onClick={savePreset} className="rounded bg-neutral-700 p-2">Save preset</button>
      </form>
      <p className="-mt-2 text-xs text-neutral-500">Leave kcal or protein blank and the coach estimates them from the name.</p>
      {formErr && <p className="-mt-2 text-sm text-red-400">{formErr}</p>}
      {formNote && <p className="-mt-2 text-xs text-neutral-400">{formNote}</p>}

      {presets.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button key={p.id} onClick={() => add(p.name, p.kcal, p.proteinG)} className="rounded-full bg-neutral-800 px-3 py-1 text-sm">
              {p.name} · {p.kcal}kcal
            </button>
          ))}
        </div>
      )}

      <ul className="space-y-2">
        {entries.map((en) => (
          <li key={en.id} className="rounded bg-neutral-900 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="flex-1">{en.name}</span>
              <span className="text-neutral-400">{en.kcal}kcal · {Math.round(en.proteinG)}g</span>
              <button onClick={() => analyze(en)} disabled={busy !== null} className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300 disabled:opacity-50">
                {busy === en.id ? "Analyzing…" : en.nutrition ? "Info" : "Analyze"}
              </button>
              <button onClick={() => del(en.id)} disabled={busy === en.id} className="text-red-400 disabled:opacity-50">✕</button>
            </div>
            {rowErr[en.id] && <p className="text-sm text-red-400">{rowErr[en.id]}</p>}
            {en.nutrition && open[en.id] && (
              <div className="space-y-2 rounded bg-neutral-800/60 p-2 text-sm">
                <div className="flex items-start gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs uppercase ${VERDICT_STYLE[en.nutrition.advice.verdict]}`}>{en.nutrition.advice.verdict}</span>
                  <p className="flex-1 text-neutral-300">{en.nutrition.advice.summary}</p>
                </div>
                {en.nutrition.advice.swap && <p className="text-xs text-amber-400">Swap: {en.nutrition.advice.swap}</p>}
                <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs text-neutral-400">
                  {PANEL_ROWS.map(([label, get, unit]) => (
                    <div key={label} className="flex justify-between"><span>{label}</span><span className="text-neutral-300">{Math.round(get(en.nutrition!) * 10) / 10}{unit}</span></div>
                  ))}
                </div>
                <p className="text-[10px] text-neutral-500">AI estimate, anchored to your logged kcal/protein — not label values.</p>
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
