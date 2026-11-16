import { useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { Link, useQuery } from '../router';
import { Empty, Loading, StatusBadge } from '../ui';
import { formatDate, isFinished, isLive, statusLabel } from '../format';
import type { MatchSummary } from '../types';

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'LIVE', label: 'Live' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'SETUP', label: 'Not started' },
];

export function Matches(): ReactNode {
  const query = useQuery();
  const [status, setStatus] = useState(query.get('status') ?? '');
  const [search, setSearch] = useState('');

  const { data, loading, error } = useAsync(
    () => api.matches(status ? `?status=${status}` : '') as Promise<{ items: MatchSummary[]; total: number }>,
    [status],
  );

  const items = useMemo(() => {
    const list = data?.items ?? [];
    if (!search.trim()) return list;
    const q = search.trim().toLowerCase();
    return list.filter((m) => `${m.title} ${m.team_a_name} ${m.team_b_name} ${m.venue ?? ''}`.toLowerCase().includes(q));
  }, [data, search]);

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row wrap between">
        <div className="chips">
          {FILTERS.map((f) => (
            <button key={f.key} className={status === f.key ? 'chip active' : 'chip'} onClick={() => setStatus(f.key)}>{f.label}</button>
          ))}
        </div>
        <input className="input" style={{ maxWidth: 260 }} placeholder="Search matches…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {loading ? <Loading /> : error ? <Empty title="Could not load matches" hint={error} />
        : items.length === 0 ? <Empty title="No matches found" hint={status ? `Nothing with status ${statusLabel(status)}.` : 'Create a match to get started.'} action={<Link to="/matches/new" className="btn primary sm">Create match</Link>} />
          : (
            <div className="grid auto">
              {items.map((m) => (
                <Link key={m.id} to={isLive(m.status) ? `/matches/${m.id}/score` : `/matches/${m.id}`} className="card hover" style={{ display: 'block' }}>
                  <div className="row between" style={{ marginBottom: 8 }}>
                    <span className="pill">{m.format}</span>
                    <StatusBadge status={m.status} />
                  </div>
                  <div style={{ fontWeight: 650 }}>{m.title}</div>
                  <div className="muted" style={{ fontSize: '0.9rem', marginTop: 4 }}>{m.team_a_name} vs {m.team_b_name}</div>
                  {m.result_summary && <div className="em" style={{ fontSize: '0.84rem', marginTop: 6 }}>{m.result_summary}</div>}
                  <div className="row between dim" style={{ fontSize: '0.8rem', marginTop: 10 }}>
                    <span className="ellipsis">{m.venue || 'Venue TBC'}</span>
                    <span className="nowrap">{formatDate(m.match_date || m.created_at)}</span>
                  </div>
                  {isFinished(m.status) && m.innings_count !== undefined && (
                    <div className="dim" style={{ fontSize: '0.76rem', marginTop: 4 }}>{m.innings_count} innings recorded</div>
                  )}
                </Link>
              ))}
            </div>
          )}
    </div>
  );
}
