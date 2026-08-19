"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { todayIso } from "@/lib/today";
import { dayTypeForDate, DAY_LABELS } from "@/lib/logic";

type Ex = { id: number; name: string; targetSets: number; repLow: number; repHigh: number; supersetGroup: string | null };
type Last = Record<number, { weight: number; reps: number; setNumber: number }[]>;

export default function Workout() {
  const date = todayIso();
  const dayType = dayTypeForDate(date);
  const [exs, setExs] = useState<Ex[]>([]);
  const [last, setLast] = useState<Last>({});
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [inputs, setInputs] = useState<Record<string, { weight: string; reps: string }>>({});

  useEffect(() => {
    if (dayType === "rest") return;
    (async () => {
      setExs(await api<Ex[]>(`/api/exercises?dayType=${dayType}`));
      setLast(await api<Last>(`/api/overload?dayType=${dayType}&date=${date}`));
    })();
  }, [dayType, date]);

  async function ensureSession(): Promise<number> {
    if (sessionId) return sessionId;
    const s = await api<{ id: number }>(`/api/sessions`, { method: "POST", body: JSON.stringify({ date, dayType }) });
    setSessionId(s.id); return s.id;
  }
  async function logSet(ex: Ex, setNumber: number) {
    const key = `${ex.id}-${setNumber}`;
    const inp = inputs[key]; if (!inp?.weight || !inp?.reps) return;
    const sid = await ensureSession();
    await api(`/api/sets`, { method: "POST", body: JSON.stringify({ sessionId: sid, exerciseId: ex.id, setNumber, weight: Number(inp.weight), reps: Number(inp.reps) }) });
    setInputs((s) => ({ ...s, [key]: { weight: "", reps: "" } }));
  }

  if (dayType === "rest") return <main className="p-6"><h1 className="text-xl font-bold">Rest day</h1><p className="text-neutral-400">Optional walk / cardio.</p></main>;

  return (
    <main className="p-4 space-y-4">
      <h1 className="text-xl font-bold">{DAY_LABELS[dayType]} · {date}</h1>
      {exs.map((ex) => (
        <div key={ex.id} className="rounded bg-neutral-900 p-3 space-y-2">
          <div className="flex justify-between">
            <span className="font-semibold">{ex.supersetGroup ? `[${ex.supersetGroup}] ` : ""}{ex.name}</span>
            <span className="text-xs text-neutral-400">{ex.targetSets}×{ex.repLow}-{ex.repHigh}</span>
          </div>
          {last[ex.id]?.length ? (
            <div className="text-xs text-green-400">Last: {last[ex.id].map((s) => `${s.weight}×${s.reps}`).join(", ")}</div>
          ) : <div className="text-xs text-neutral-500">No history yet</div>}
          <div className="space-y-1">
            {Array.from({ length: ex.targetSets }).map((_, i) => {
              const key = `${ex.id}-${i + 1}`;
              return (
                <div key={key} className="flex gap-2 items-center">
                  <span className="w-6 text-neutral-500">{i + 1}</span>
                  <input className="w-20 rounded bg-neutral-800 p-1" inputMode="decimal" placeholder="kg"
                    value={inputs[key]?.weight ?? ""} onChange={(e) => setInputs((s) => ({ ...s, [key]: { ...s[key], weight: e.target.value } }))} />
                  <input className="w-20 rounded bg-neutral-800 p-1" inputMode="numeric" placeholder="reps"
                    value={inputs[key]?.reps ?? ""} onChange={(e) => setInputs((s) => ({ ...s, [key]: { ...s[key], reps: e.target.value } }))} />
                  <button onClick={() => logSet(ex, i + 1)} className="rounded bg-green-600 px-3 py-1 text-sm">✓</button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </main>
  );
}
