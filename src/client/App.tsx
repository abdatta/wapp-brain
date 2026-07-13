import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "./routes";
import { StatusProvider } from "./state/StatusContext";
import { ToastProvider } from "./state/ToastContext";

// The client shell: cross-cutting providers (toast, then status — status raises
// toasts) wrap the router, whose layout route (AppShell) renders the persistent
// chrome and a lazily-loaded page outlet. All surface logic lives in pages under
// src/client/pages/; App holds no page state.
export function App() {
  return (
    <ToastProvider>
      <StatusProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </StatusProvider>
    </ToastProvider>
  );
}
