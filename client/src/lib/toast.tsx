// Toast notification system. Used for the "applied!" / "draft saved"
// feedback so the user sees confirmation on every Apply action.

import { createContext, useContext, useState, useCallback, useEffect } from "react";

type Toast = {
  id: number;
  kind: "success" | "error" | "info";
  title: string;
  message?: string;
  actions?: { label: string; href?: string; onClick?: () => void }[];
  duration?: number;
};

const ToastCtx = createContext<{
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => number;
  dismiss: (id: number) => void;
} | null>(null);

export function ToastProvider({ children }: { children: any }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all, { id, duration: 6000, ...t }]);
    if (t.duration !== 0) {
      setTimeout(() => dismiss(id), t.duration ?? 6000);
    }
    return id;
  }, [dismiss]);

  return (
    <ToastCtx.Provider value={{ toasts, push, dismiss }}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be inside <ToastProvider>");
  return ctx;
}

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <div className="toast-title">{t.title}</div>
          {t.message ? <div className="toast-msg">{t.message}</div> : null}
          {t.actions && t.actions.length > 0 ? (
            <div className="toast-actions">
              {t.actions.map((a, i) => (
                a.href
                  ? <a key={i} className="btn btn-sm btn-primary" href={a.href} style={{ textDecoration: "none" }}>{a.label}</a>
                  : <button key={i} className="btn btn-sm" onClick={() => { a.onClick?.(); onDismiss(t.id); }}>{a.label}</button>
              ))}
            </div>
          ) : null}
          <button className="btn btn-ghost btn-sm" style={{ position: "absolute", top: 4, right: 4, padding: "2px 6px", fontSize: 10 }} onClick={() => onDismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
