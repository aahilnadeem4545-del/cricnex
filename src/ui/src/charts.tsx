import type { ReactNode } from 'react';
import { num } from './format';

/** Manhattan chart: runs scored in each over, with wickets marked. */
export function ManhattanChart({ data, height = 200 }: {
  data: Array<Record<string, unknown>>; height?: number;
}): ReactNode {
  const points = data.map((d) => ({ over: num(d.over_number), runs: num(d.runs), wickets: num(d.wickets) }));
  if (points.length === 0) return <div className="empty">No overs bowled yet.</div>;
  const W = Math.max(340, points.length * 34 + 40);
  const H = height;
  const padL = 34, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxRuns = Math.max(6, ...points.map((p) => p.runs));
  const step = plotW / points.length;
  const barW = Math.min(step * 0.62, 26);
  const y = (v: number) => padT + plotH - (v / maxRuns) * plotH;
  const gridVals = [0, Math.round(maxRuns / 2), maxRuns];

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Runs per over">
      {gridVals.map((g) => (
        <g key={g}>
          <line className="gridline" x1={padL} x2={W - padR} y1={y(g)} y2={y(g)} />
          <text className="lbl" x={padL - 6} y={y(g) + 3} textAnchor="end">{g}</text>
        </g>
      ))}
      {points.map((p, i) => {
        const cx = padL + i * step + step / 2;
        const h = plotH - (y(p.runs) - padT);
        const isBig = p.runs >= 10;
        return (
          <g key={p.over}>
            <rect
              x={cx - barW / 2} y={y(p.runs)} width={barW} height={Math.max(h, 1)} rx={3}
              fill={isBig ? 'var(--emerald-bright)' : 'var(--emerald)'} opacity={0.82}
            />
            {p.wickets > 0 && (
              <circle cx={cx} cy={y(p.runs) - 6} r={5} fill="var(--red)" stroke="#0b0f0e" strokeWidth={1.5} />
            )}
            <text className="lbl" x={cx} y={H - 8} textAnchor="middle">{p.over}</text>
          </g>
        );
      })}
      <line className="axis" x1={padL} x2={W - padR} y1={padT + plotH} y2={padT + plotH} />
    </svg>
  );
}

/** Cumulative run-rate line chart across an innings. */
export function RunRateChart({ data, height = 200 }: {
  data: Array<Record<string, unknown>>; height?: number;
}): ReactNode {
  const points = data.map((d) => ({ over: num(d.over), runRate: num(d.runRate) }));
  if (points.length < 2) return <div className="empty">Not enough overs for a run-rate graph.</div>;
  const W = Math.max(340, points.length * 40 + 40);
  const H = height;
  const padL = 34, padR = 14, padT = 14, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxRR = Math.max(6, ...points.map((p) => p.runRate)) * 1.1;
  const x = (i: number) => padL + (i / (points.length - 1)) * plotW;
  const y = (v: number) => padT + plotH - (v / maxRR) * plotH;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.runRate).toFixed(1)}`).join(' ');
  const area = `${path} L ${x(points.length - 1).toFixed(1)} ${padT + plotH} L ${padL} ${padT + plotH} Z`;

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Run rate by over">
      <defs>
        <linearGradient id="rrfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--emerald)" stopOpacity="0.34" />
          <stop offset="100%" stopColor="var(--emerald)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, maxRR / 2, maxRR].map((g) => (
        <g key={g}>
          <line className="gridline" x1={padL} x2={W - padR} y1={y(g)} y2={y(g)} />
          <text className="lbl" x={padL - 6} y={y(g) + 3} textAnchor="end">{g.toFixed(0)}</text>
        </g>
      ))}
      <path d={area} fill="url(#rrfill)" />
      <path d={path} fill="none" stroke="var(--emerald-bright)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <g key={p.over}>
          <circle cx={x(i)} cy={y(p.runRate)} r={3} fill="var(--emerald-bright)" />
          {(i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 8) === 0) && (
            <text className="lbl" x={x(i)} y={H - 8} textAnchor="middle">{p.over}</text>
          )}
        </g>
      ))}
      <line className="axis" x1={padL} x2={W - padR} y1={padT + plotH} y2={padT + plotH} />
    </svg>
  );
}

/** Wagon wheel: where runs were scored, from recorded shot angles. */
export function WagonWheel({ shots, size = 300 }: {
  shots: Array<Record<string, unknown>>; size?: number;
}): ReactNode {
  const valid = shots.filter((s) => s.shot_angle !== null && s.shot_angle !== undefined);
  if (valid.length === 0) {
    return <div className="empty">No shot data recorded. Shot angles are captured when a scorer taps the field.</div>;
  }
  const c = size / 2;
  const r = c - 26;
  const maxDist = Math.max(60, ...valid.map((s) => num(s.shot_distance, 60)));
  const colour = (runs: number) => (runs >= 6 ? 'var(--purple)' : runs >= 4 ? 'var(--blue)' : runs === 0 ? 'var(--muted-2)' : 'var(--emerald)');
  return (
    <svg className="chart" viewBox={`0 0 ${size} ${size}`} style={{ maxWidth: size, margin: '0 auto' }} role="img" aria-label="Wagon wheel">
      <circle cx={c} cy={c} r={r} fill="rgba(16,185,129,0.04)" stroke="var(--border)" />
      <circle cx={c} cy={c} r={r * 0.66} fill="none" stroke="var(--border-soft)" strokeDasharray="3 5" />
      <circle cx={c} cy={c} r={r * 0.33} fill="none" stroke="var(--border-soft)" strokeDasharray="3 5" />
      {[0, 45, 90, 135].map((a) => {
        const rad = (a * Math.PI) / 180;
        return <line key={a} x1={c - Math.sin(rad) * r} y1={c - Math.cos(rad) * r} x2={c + Math.sin(rad) * r} y2={c + Math.cos(rad) * r} stroke="var(--border-soft)" />;
      })}
      {valid.map((s, i) => {
        const angle = num(s.shot_angle) * Math.PI / 180;
        const len = (num(s.shot_distance, 60) / maxDist) * r;
        const x2 = c + Math.sin(angle) * len;
        const y2 = c - Math.cos(angle) * len;
        return <line key={i} x1={c} y1={c} x2={x2} y2={y2} stroke={colour(num(s.batter_runs))} strokeWidth={num(s.batter_runs) >= 4 ? 2.6 : 1.6} strokeLinecap="round" opacity={0.85} />;
      })}
      <circle cx={c} cy={c} r={4} fill="var(--emerald-bright)" />
    </svg>
  );
}

/** Simple horizontal bar list for leaderboards inside a compact chart. */
export function BarList({ items, max, labelKey, valueKey, unit }: {
  items: Array<Record<string, unknown>>; max?: number; labelKey: string; valueKey: string; unit?: string;
}): ReactNode {
  if (items.length === 0) return <div className="empty">No data yet.</div>;
  const top = max ?? Math.max(1, ...items.map((i) => num(i[valueKey])));
  return (
    <div className="col" style={{ gap: 9 }}>
      {items.map((item, index) => {
        const value = num(item[valueKey]);
        return (
          <div key={index} className="row" style={{ gap: 10 }}>
            <div className="dim mono" style={{ width: 20, fontSize: '0.78rem' }}>{index + 1}</div>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row between" style={{ marginBottom: 3 }}>
                <span className="ellipsis" style={{ fontSize: '0.88rem' }}>{String(item[labelKey] ?? '—')}</span>
                <span className="mono" style={{ fontSize: '0.85rem', fontWeight: 650 }}>{value}{unit ?? ''}</span>
              </div>
              <div style={{ height: 5, borderRadius: 4, background: 'var(--surface-3)', overflow: 'hidden' }}>
                <div style={{ width: `${(value / top) * 100}%`, height: '100%', background: 'linear-gradient(90deg, var(--emerald), var(--emerald-bright))' }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
