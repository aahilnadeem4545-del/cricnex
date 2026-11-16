import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { initials, statusLabel, statusTone } from './format';

export function Spinner({ large }: { large?: boolean }): ReactNode {
  return <div className={large ? 'spinner lg' : 'spinner'} aria-label="Loading" role="status" />;
}

export function Loading({ label = 'Loading…' }: { label?: string }): ReactNode {
  return <div className="loading-wrap"><Spinner large /><div className="muted">{label}</div></div>;
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }): ReactNode {
  return (
    <div className="empty">
      <div style={{ fontWeight: 650, color: 'var(--text)', marginBottom: 4 }}>{title}</div>
      {hint && <div className="muted" style={{ fontSize: '0.9rem' }}>{hint}</div>}
      {action && <div style={{ marginTop: 14, display: 'flex', justifyContent: 'center' }}>{action}</div>}
    </div>
  );
}

export function StatusBadge({ status }: { status?: string | null }): ReactNode {
  const tone = statusTone(status);
  return (
    <span className={`badge ${tone}`}>
      {tone === 'live' && <span className="dot" />}
      {statusLabel(status)}
    </span>
  );
}

export function Avatar({ name, large }: { name: string; large?: boolean }): ReactNode {
  return <div className={large ? 'avatar lg' : 'avatar'}>{initials(name)}</div>;
}

export function StatCard({ value, label, accent, hint }: { value: ReactNode; label: string; accent?: boolean; hint?: string }): ReactNode {
  return (
    <div className="card">
      <div className="stat">
        <div className="value" style={accent ? { color: 'var(--emerald-bright)' } : undefined}>{value}</div>
        <div className="label">{label}</div>
        {hint && <div className="dim" style={{ fontSize: '0.8rem' }}>{hint}</div>}
      </div>
    </div>
  );
}

export function Modal({ title, children, onClose, wide, footer }: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean; footer?: ReactNode;
}): ReactNode {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={wide ? 'modal wide' : 'modal'} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between" style={{ marginBottom: 14 }}>
          <h3>{title}</h3>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
        {footer && <div className="btn-row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>{footer}</div>}
      </div>
    </div>
  );
}

/* --------------------------------- toasts --------------------------------- */

interface Toast { id: number; message: string; kind: 'info' | 'error' | 'success'; }
interface ToastValue { push: (message: string, kind?: Toast['kind']) => void; }
const ToastContext = createContext<ToastValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === 'error' ? 6500 : 3600);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

/** Surface an error from any thrown value as a readable toast message. */
export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}
