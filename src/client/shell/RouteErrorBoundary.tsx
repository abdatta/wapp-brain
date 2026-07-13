import React from "react";

// Per-route error boundary: a render error on one surface shows a readable
// explanation for that surface while the shell (nav, status) stays usable,
// instead of unmounting the whole app. Reset it by keying on the route path.
export class RouteErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ui] route render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="routeCrash">
          <h2>This surface hit an error</h2>
          <p>Your archive and server are unaffected — this is a display error. The rest of the app still works.</p>
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
