import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { Link } from '../router';
import { useAuth } from '../auth';
import { Empty, Loading, Modal, errorMessage, useToast } from '../ui';
import { formatDate } from '../format';
import type { Tournament } from '../types';

export function Tournaments(): ReactNode {
  const { can } = useAuth();
  const toast = useToast();
  const state = useAsync(() => api.tournaments() as Promise<{ tournaments: Tournament[] }>);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [format, setFormat] = useState('T20');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await api.createTournament({ name: name.trim(), format });
      toast.push('Tournament created.', 'success');
      setOpen(false); setName('');
      state.reload();
    } catch (error) { toast.push(errorMessage(error), 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row between wrap">
        <span className="muted">{state.data?.tournaments.length ?? 0} tournaments</span>
        {can('admin', 'scorer') && <button className="btn primary sm" onClick={() => setOpen(true)}>New tournament</button>}
      </div>

      {state.loading ? <Loading /> : state.error ? <Empty title="Could not load tournaments" hint={state.error} />
        : (state.data?.tournaments.length ?? 0) === 0 ? <Empty title="No tournaments yet" hint="Create a tournament to generate fixtures and track a points table." />
          : (
            <div className="grid auto">
              {state.data!.tournaments.map((t) => (
                <Link key={t.id} to={`/tournaments/${t.id}`} className="card hover" style={{ display: 'block' }}>
                  <div className="row between" style={{ marginBottom: 8 }}>
                    <span className="pill">{t.format}</span>
                    <span className={`badge ${t.status === 'active' ? 'ok' : 'muted'}`}>{t.status}</span>
                  </div>
                  <div style={{ fontWeight: 650 }}>{t.name}</div>
                  <div className="dim" style={{ fontSize: '0.84rem', marginTop: 6 }}>
                    {t.team_count ?? 0} teams · {t.fixture_count ?? 0} fixtures
                  </div>
                  {(t.start_date || t.end_date) && (
                    <div className="dim" style={{ fontSize: '0.8rem', marginTop: 4 }}>
                      {formatDate(t.start_date)} – {formatDate(t.end_date)}
                    </div>
                  )}
                </Link>
              ))}
            </div>
          )}

      {open && (
        <Modal title="New tournament" onClose={() => setOpen(false)} footer={
          <>
            <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn primary" onClick={() => void create()} disabled={busy || !name.trim()}>Create</button>
          </>
        }>
          <div className="col" style={{ gap: 14 }}>
            <div className="field"><label>Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
            <div className="field">
              <label>Format</label>
              <select className="select" value={format} onChange={(e) => setFormat(e.target.value)}>
                {['TEST', 'ODI', 'T20', 'T10', 'CUSTOM', 'TENNIS_BALL', 'TAPE_BALL', 'LOCAL'].map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
