import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { useAuth } from '../auth';
import { Empty, Loading, Modal, errorMessage, useToast } from '../ui';
import { formatDateTime, num } from '../format';
import type { User } from '../types';

export function Settings(): ReactNode {
  const { user, can } = useAuth();
  const toast = useToast();
  const health = useAsync(() => api.health() as Promise<Record<string, unknown>>);
  const backups = useAsync(() => api.backups() as Promise<{ backups: Array<Record<string, unknown>>; health: Record<string, unknown> }>);
  const sync = useAsync(() => api.syncStatus() as Promise<Record<string, unknown>>);
  const users = useAsync(() => (can('admin') ? api.users() as Promise<{ users: User[] }> : Promise.resolve({ users: [] as User[] })), [user?.id]);
  const [busy, setBusy] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: 'scorer' });

  const doBackup = async () => {
    setBusy(true);
    try { await api.createBackup(); toast.push('Backup created.', 'success'); backups.reload(); }
    catch (error) { toast.push(errorMessage(error), 'error'); } finally { setBusy(false); }
  };
  const doSync = async () => {
    setBusy(true);
    try { const r = await api.syncRun() as Record<string, unknown>; toast.push(`Sync run complete (${num(r.pushed)} pushed).`, 'success'); sync.reload(); }
    catch (error) { toast.push(errorMessage(error), 'error'); } finally { setBusy(false); }
  };
  const createUser = async () => {
    setBusy(true);
    try {
      await api.createUser({ username: form.username.trim(), displayName: form.displayName.trim(), password: form.password, role: form.role });
      toast.push('User created.', 'success'); setUserOpen(false);
      setForm({ username: '', displayName: '', password: '', role: 'scorer' });
      users.reload();
    } catch (error) { toast.push(errorMessage(error), 'error'); } finally { setBusy(false); }
  };
  const changeRole = async (id: string, role: string) => {
    try { await api.updateUserRole(id, role); toast.push('Role updated.', 'success'); users.reload(); }
    catch (error) { toast.push(errorMessage(error), 'error'); }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid cols-2">
        <section className="card">
          <div className="card-head"><span className="card-title">System health</span></div>
          {health.loading ? <Loading /> : health.error ? <Empty title="Health unavailable" hint={health.error} /> : (
            <div className="kv">
              <span className="k">Database integrity</span><span className="v">{String(health.data?.integrity ?? '—')}</span>
              <span className="k">Pending sync</span><span className="v">{num(health.data?.pendingSync)}</span>
              <span className="k">Device</span><span className="v mono">{String(health.data?.device ?? '—').slice(0, 12)}…</span>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head"><span className="card-title">Offline sync</span><button className="btn ghost sm" onClick={() => void doSync()} disabled={busy}>Run now</button></div>
          {sync.loading ? <Loading /> : sync.error ? <Empty title="Sync unavailable" hint={sync.error} /> : (
            <div className="kv">
              <span className="k">Remote URL</span><span className="v mono">{String(sync.data?.remoteUrl ?? 'not configured')}</span>
              <span className="k">Outbox pending</span><span className="v">{num(sync.data?.pending)}</span>
              <span className="k">Applied events</span><span className="v">{num(sync.data?.applied)}</span>
            </div>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <span className="card-title">Backups</span>
          {can('admin') && <button className="btn sm" onClick={() => void doBackup()} disabled={busy}>Create backup</button>}
        </div>
        {backups.loading ? <Loading /> : backups.error ? <Empty title="Backups unavailable" hint={backups.error} /> : (
          (backups.data?.backups.length ?? 0) === 0 ? <Empty title="No backups yet" hint="A backup is taken automatically at startup." /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>File</th><th className="num">Size</th><th>Created</th></tr></thead>
                <tbody>
                  {backups.data!.backups.map((b, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ fontSize: '0.82rem' }}>{String(b.name ?? b.file ?? '—')}</td>
                      <td className="num">{b.size != null ? `${(num(b.size) / 1024).toFixed(1)} KB` : '—'}</td>
                      <td className="muted">{formatDateTime(String(b.createdAt ?? b.mtime ?? ''))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </section>

      {can('admin') && (
        <section className="card">
          <div className="card-head"><span className="card-title">Users &amp; roles</span><button className="btn sm" onClick={() => setUserOpen(true)}>New user</button></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Name</th><th>Username</th><th>Role</th><th /></tr></thead>
              <tbody>
                {(users.data?.users ?? []).map((u) => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 600 }}>{u.displayName}{u.id === user?.id && <span className="dim"> (you)</span>}</td>
                    <td className="mono muted">{u.username}</td>
                    <td>
                      <select className="select" style={{ padding: '5px 10px', width: 'auto' }} value={u.role} disabled={u.id === user?.id}
                        onChange={(e) => void changeRole(u.id, e.target.value)}>
                        <option value="admin">admin</option>
                        <option value="scorer">scorer</option>
                        <option value="viewer">viewer</option>
                      </select>
                    </td>
                    <td className="right"><span className="badge muted">{u.role}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {userOpen && (
        <Modal title="New user" onClose={() => setUserOpen(false)} footer={
          <>
            <button className="btn ghost" onClick={() => setUserOpen(false)}>Cancel</button>
            <button className="btn primary" onClick={() => void createUser()} disabled={busy || !form.username.trim() || form.password.length < 8}>Create user</button>
          </>
        }>
          <div className="form-grid">
            <div className="field"><label>Username</label><input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoFocus /></div>
            <div className="field"><label>Display name</label><input className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></div>
            <div className="field"><label>Password (min 8)</label><input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
            <div className="field">
              <label>Role</label>
              <select className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="admin">Admin</option>
                <option value="scorer">Scorer</option>
                <option value="viewer">Viewer</option>
              </select>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
