import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Failures are never silent: a render error must show a readable explanation
// instead of unmounting the app into a blank page. The full error also goes to
// the browser console for deeper inspection.
class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ui] render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="appCrash">
          <h1>The interface hit an error</h1>
          <p>Your archive and server are unaffected — this is a display error.</p>
          <pre>{this.state.error.message}</pre>
          <p>The full details are in the browser console (F12).</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload the app
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
