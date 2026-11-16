import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAsync, useDebounced } from '../hooks';
import { Link } from '../router';
import { useAuth } from '../auth';
import { Avatar, Empty, Loading, Modal, errorMessage, useToast } from '../ui';
import type { Player, Team } from '../types';

export function Players(): ReactNode {
  const { can } = useAuth();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [teamId, setTeamId] = useState('');
  const debounced = useDebounced(search, 250);
  const teams = useAsync(() => api.teams() as Promise<{ teams: Team[] }>);
  const state = useAsync(
    () => api.players(`?search=${encodeURIComponent(debounced)}${teamId ? `&teamId=${teamId}` : ''}&limit=100`) as Promise<{ items: Player[]; total: number }>,
    [debounced, teamId],
  );

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ fullName: '', playingRole: '', battingStyle: '', bowlingStyle: '', jerseyNumber: '', primaryTeamId: '' });
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await api.createPlayer({
        fullName: form.fullName.trim(),
        playingRole: form.playingRole || null,
        battingStyle: form.battingStyle || null,
        bowlingStyle: form.bowlingStyle || null,
        jerseyNumber: form.jerseyNumber ? Number(form.jerseyNumber) : null,
        primaryTeamId: form.primaryTeamId || null,
      });
      toast.push('Player created.', 'success');
      setOpen(false);
      setForm({ fullName: '', playingRole: '', battingStyle: '', bowlingStyle: '', jerseyNumber: '', primaryTeamId: '' });
      state.reload();
    } catch (error) { toast.push(errorMessage(error), 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row between wrap">
        <div className="row wrap">
          <input className="input" style={{ maxWidth: 260 }} placeholder="Search players…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="select" style={{ maxWidth: 200 }} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">All teams</option>
            {(teams.data?.teams ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        {can('admin', 'scorer') && <button className="btn primary sm" onClick={() => setOpen(true)}>New player</button>}
      </div>

      {state.loading ? <Loading /> : state.error ? <Empty title="Could not load players" hint={state.error} />
        : (state.data?.items.length ?? 0) === 0 ? <Empty title="No players found" hint="Adjust your search or create a new player." />
          : (
            <div className="grid auto-sm">
              {state.data!.items.map((p) => (
                <Link key={p.id} to={`/players/${p.id}`} className="card hover" style={{ display: 'block' }}>
                  <div className="row" style={{ gap: 11 }}>
                    <Avatar name={p.full_name} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="ellipsis" style={{ fontWeight: 600 }}>{p.full_name}</div>
                      <div className="dim ellipsis" style={{ fontSize: '0.8rem' }}>{p.playing_role || 'Player'}</div>
                    </div>
                    {p.jersey_number != null && <span className="mono dim">#{p.jersey_number}</span>}
                  </div>
                  {p.team_name && <div className="muted ellipsis" style={{ fontSize: '0.82rem', marginTop: 8 }}>{p.team_name}</div>}
                </Link>
              ))}
            </div>
          )}

      {open && (
        <Modal title="New player" onClose={() => setOpen(false)} footer={
          <>
            <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn primary" onClick={() => void create()} disabled={busy || !form.fullName.trim()}>Create player</button>
          </>
        }>
          <div className="form-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}><label>Full name</label><input className="input" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} autoFocus /></div>
            <div className="field"><label>Playing role</label><input className="input" value={form.playingRole} onChange={(e) => setForm({ ...form, playingRole: e.target.value })} placeholder="Batter / Bowler / All-rounder / Keeper" /></div>
            <div className="field"><label>Jersey number</label><input className="input" type="number" value={form.jerseyNumber} onChange={(e) => setForm({ ...form, jerseyNumber: e.target.value })} /></div>
            <div className="field"><label>Batting style</label><input className="input" value={form.battingStyle} onChange={(e) => setForm({ ...form, battingStyle: e.target.value })} placeholder="Right-hand bat" /></div>
            <div className="field"><label>Bowling style</label><input className="input" value={form.bowlingStyle} onChange={(e) => setForm({ ...form, bowlingStyle: e.target.value })} placeholder="Right-arm medium" /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Primary team</label>
              <select className="select" value={form.primaryTeamId} onChange={(e) => setForm({ ...form, primaryTeamId: e.target.value })}>
                <option value="">None</option>
                {(teams.data?.teams ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
