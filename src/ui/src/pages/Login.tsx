import { useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../auth';
import { errorMessage, useToast } from '../ui';

export function Login(): ReactNode {
  const { login } = useAuth();
  const toast = useToast();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (error) {
      toast.push(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div className="row" style={{ justifyContent: 'center', marginBottom: 22, gap: 13 }}>
          <div className="brand-mark" style={{ width: 50, height: 50, fontSize: 26, borderRadius: 15 }}>C</div>
          <div>
            <div className="brand-name" style={{ fontSize: '1.7rem' }}>CRICNEX</div>
            <div className="brand-sub">Cricket management &amp; scoring</div>
          </div>
        </div>
        <form className="card pad-lg" onSubmit={submit}>
          <h2 style={{ marginBottom: 4 }}>Sign in</h2>
          <p className="muted" style={{ fontSize: '0.9rem' }}>Use your scorer or admin account to continue.</p>
          <div className="col" style={{ marginTop: 16, gap: 14 }}>
            <div className="field">
              <label htmlFor="username">Username</label>
              <input id="username" className="input" autoComplete="username" value={username}
                onChange={(e) => setUsername(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" className="input" type="password" autoComplete="current-password" value={password}
                onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <button className="btn primary block" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
          <p className="dim" style={{ fontSize: '0.8rem', marginTop: 16, marginBottom: 0 }}>
            First run creates the administrator <span className="mono">admin</span> with the password{' '}
            <span className="mono">cricnex-admin</span>. Change it in Settings after you sign in.
          </p>
        </form>
      </div>
    </div>
  );
}
