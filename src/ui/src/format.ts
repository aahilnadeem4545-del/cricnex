export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function formatDate(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function relativeTime(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value).getTime();
  if (Number.isNaN(d)) return '—';
  const diff = Date.now() - d;
  const abs = Math.abs(diff);
  const units: Array<[number, string]> = [
    [60_000, 'min'], [3_600_000, 'hr'], [86_400_000, 'day'], [604_800_000, 'wk'], [2_592_000_000, 'mo'],
  ];
  if (abs < 60_000) return 'just now';
  for (let i = 0; i < units.length; i++) {
    const [ms, label] = units[i];
    if (abs < ms * (i + 1 === units.length ? Infinity : units[i + 1][0] / ms)) {
      const n = Math.round(abs / ms);
      return `${n} ${label}${n === 1 ? '' : 's'} ago`;
    }
  }
  return formatDate(value);
}

export function oversFromBalls(balls: number, perOver = 6): string {
  if (!Number.isFinite(balls) || balls < 0) return '0.0';
  return `${Math.floor(balls / perOver)}.${balls % perOver}`;
}

export function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function statusLabel(status?: string | null): string {
  switch (status) {
    case 'SETUP': return 'Setup';
    case 'TOSS': return 'Toss done';
    case 'LIVE': return 'Live';
    case 'INNINGS_BREAK': return 'Innings break';
    case 'SUPER_OVER': return 'Super over';
    case 'COMPLETED': return 'Completed';
    case 'DRAWN': return 'Drawn';
    case 'NO_RESULT': return 'No result';
    case 'ABANDONED': return 'Abandoned';
    default: return status ?? 'Unknown';
  }
}

export type Tone = 'live' | 'ok' | 'warn' | 'info' | 'muted';

export function statusTone(status?: string | null): Tone {
  switch (status) {
    case 'LIVE':
    case 'SUPER_OVER': return 'live';
    case 'COMPLETED': return 'ok';
    case 'INNINGS_BREAK':
    case 'TOSS': return 'info';
    case 'DRAWN':
    case 'NO_RESULT':
    case 'ABANDONED': return 'warn';
    default: return 'muted';
  }
}

export function isLive(status?: string | null): boolean {
  return status === 'LIVE' || status === 'SUPER_OVER' || status === 'INNINGS_BREAK' || status === 'TOSS';
}

export function isFinished(status?: string | null): boolean {
  return status === 'COMPLETED' || status === 'DRAWN' || status === 'NO_RESULT' || status === 'ABANDONED';
}

export function titleCase(value?: string | null): string {
  if (!value) return '—';
  return value.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
