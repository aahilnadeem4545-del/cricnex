import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { Link } from '../router';
import { useAuth } from '../auth';
import { Empty, Loading, Modal, errorMessage, useToast } from '../ui';
import { Avatar } from '../ui';
import type { Team } from '../types';

export function Teams(): ReactNode {
  const { can } = useAuth();
  const toast = useToast();
  const state = useAsync(() => api.teams() as Promise<{ teams: Team[] }>);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [coach, setCoach] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await api.createTeam({ name: name.trim(), shortName: shortName.trim() || null, coach: coach.trim() || null });
      toast.push('Team created.', 'success');
      setOpen(false); setName(''); setShortName(''); setCoach('');
      state.reload();
    } catch (error) { toast.push(errorMessage(error), 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row between wrap">
        <span className="muted">{state.data?.teams.length ?? 0} teams</span>
        {can('admin', 'scorer') && <button className="btn primary sm" onClick={() => setOpen(true)}>New team</button>}
      </div>

      {state.loading ? <Loading /> : state.error ? <Empty title="Could not load teams" hint={state.error} />
        : (state.data?.teams.length ?? 0) === 0 ? <Empty title="No teams yet" hint="Create your first team to start building squads." action={can('admin', 'scorer') ? <button className="btn primary sm" onClick={() => setOpen(true)}>New team</button> : undefined} />
          : (
            <div className="grid auto">
              {state.data!.teams.map((team) => (
                <Link key={team.id} to={`/teams/${team.id}`} className="card hover" style={{ display: 'block' }}>
                  <div className="row" style={{ gap: 12 }}>
                    <Avatar name={team.name} large />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 650 }} className="ellipsis">{team.name}</div>
                      <div className="dim" style={{ fontSize: '0.84rem' }}>{team.short_name || '—'} · {team.player_count ?? 0} players</div>
                    </div>
                  </div>
                  {team.coach && <div className="muted" style={{ fontSize: '0.84rem', marginTop: 10 }}>Coach: {team.coach}</div>}
                </Link>
              ))}
            </div>
          )}

      {open && (
        <Modal title="New team" onClose={() => setOpen(false)} footer={
          <>
            <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn primary" onClick={() => void create()} disabled={busy || !name.trim()}>Create team</button>
          </>
        }>
          <div className="col" style={{ gap: 14 }}>
            <div className="field"><label>Team name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
            <div className="field"><label>Short name</label><input className="input" value={shortName} maxLength={10} onChange={(e) => setShortName(e.target.value)} placeholder="e.g. LDN" /></div>
            <div className="field"><label>Coach</label><input className="input" value={coach} onChange={(e) => setCoach(e.target.value)} /></div>
          </div>
        </Modal>
      )}
    </div>
  );
}
