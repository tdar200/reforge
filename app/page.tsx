"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client";
import { todayIso } from "@/lib/today";
import { dayTypeForDate, DAY_LABELS, sumDiet } from "@/lib/logic";
import { Ring } from "@/components/Ring";
import { QuickLog } from "@/components/QuickLog";

type Entry = { kcal: number; proteinG: number };
type Settings = { calorieTarget: number; proteinTarget: number };

export default function Today() {
  const date = todayIso();
  const dayType = dayTypeForDate(date);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [settings, setSettings] = useState<Settings>({ calorieTarget: 2000, proteinTarget: 170 });
  const load = useCallback(async () => {
    setEntries(await api<Entry[]>(`/api/diet?date=${date}`));
    setSettings(await api<Settings>(`/api/settings`));
  }, [date]);
  useEffect(() => { load(); }, [load]);
  const total = sumDiet(entries);
  return (
    <main className="p-4 space-y-6">
      <h1 className="text-2xl font-bold">Today</h1>
      <Link href="/workout" className="block rounded bg-neutral-900 p-4">
        <div className="text-sm text-neutral-400">Session</div>
        <div className="text-lg font-semibold text-green-400">{DAY_LABELS[dayType]}</div>
      </Link>
      <div className="flex justify-around">
        <Ring value={total.kcal} max={settings.calorieTarget} label="Calories" unit="kcal" />
        <Ring value={total.proteinG} max={settings.proteinTarget} label="Protein" unit="g" />
      </div>
      <QuickLog date={date} onSaved={load} />
      <div className="grid grid-cols-3 gap-2">
        <Link href="/workout" className="rounded bg-green-600 p-3 text-center">Workout</Link>
        <Link href="/diet" className="rounded bg-neutral-700 p-3 text-center">Add meal</Link>
        <Link href="/body" className="rounded bg-neutral-700 p-3 text-center">Log body</Link>
      </div>
    </main>
  );
}
