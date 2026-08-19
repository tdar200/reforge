type Row = { exerciseId: number; sessionDate: string; weight: number; reps: number; setNumber: number };

export function lastSetsByExercise(rows: Row[], currentDate: string) {
  const out: Record<number, { weight: number; reps: number; setNumber: number }[]> = {};
  const prior = rows.filter((r) => r.sessionDate < currentDate);
  const byEx = new Map<number, Row[]>();
  for (const r of prior) {
    const arr = byEx.get(r.exerciseId) ?? [];
    arr.push(r); byEx.set(r.exerciseId, arr);
  }
  for (const [exId, exRows] of byEx) {
    const latestDate = exRows.reduce((m, r) => (r.sessionDate > m ? r.sessionDate : m), "");
    out[exId] = exRows
      .filter((r) => r.sessionDate === latestDate)
      .sort((a, b) => a.setNumber - b.setNumber)
      .map((r) => ({ weight: r.weight, reps: r.reps, setNumber: r.setNumber }));
  }
  return out;
}
