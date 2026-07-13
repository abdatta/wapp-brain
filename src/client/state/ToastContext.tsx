import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

// Cross-cutting notice/error state. The shell renders a single toast host from
// this; any page or the status provider pushes a message. Kept above the router
// so a toast survives navigation (e.g. a brain run that completes while the user
// is on another surface). Failures are never silent — errors surface here and
// are also logged to the console by their originating handler.
interface ToastContextValue {
  notice: string | null;
  error: string | null;
  setNotice: (message: string | null) => void;
  setError: (message: string | null) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [notice, setNoticeState] = useState<string | null>(null);
  const [error, setErrorState] = useState<string | null>(null);

  // Showing a notice clears any stale error and vice versa, matching the single
  // toast line the monolith rendered.
  const setNotice = useCallback((message: string | null) => {
    setNoticeState(message);
    if (message) setErrorState(null);
  }, []);
  const setError = useCallback((message: string | null) => {
    setErrorState(message);
    if (message) setNoticeState(null);
  }, []);
  const clear = useCallback(() => {
    setNoticeState(null);
    setErrorState(null);
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ notice, error, setNotice, setError, clear }),
    [notice, error, setNotice, setError, clear]
  );
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return value;
}
