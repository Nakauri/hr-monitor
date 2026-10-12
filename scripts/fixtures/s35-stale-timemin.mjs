// Synthetic fixture for scripts/session-time.mjs (S35, AUDIT-NOTES item 31). Generated, not recorded: no real data.
// Shape of the bad file: 189 rows at 1 Hz, HR around 85, time_min counted from a start 4235.45 min earlier,
// epoch_ms correct for 2026-10-05 09:46:43 America/Edmonton (15:46:43 UTC). Kept as code because *.csv is gitignored.
export const S35_FIXTURE_NAME = 'hrv_session_2026-10-05T15-49-52.csv';
export function staleTimeMinCsv() {
  const H = 'time_min,epoch_ms,hr_bpm,rmssd_ms,sdnn_match_ms,sdnn_5min_ms,sdnn_full_ms,palpitation,event,warning,connection,posture';
  const E0 = Date.UTC(2026, 9, 5, 15, 46, 43);
  const L = [H];
  for (let i = 0; i < 189; i++) {
    const hr = Math.round(85 + 3 * Math.sin(i / 9) + ((i * 7) % 3 - 1));
    const rm = (32 + 4 * Math.cos(i / 13)).toFixed(2);
    L.push([(4235.45 + i / 60).toFixed(4), E0 + i * 1000, hr, rm, '', '', '', '', '', '', i === 0 ? 'connect' : '', ''].join(','));
  }
  return L.join('\n') + '\n';
}
