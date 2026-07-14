// A route error boundary is normally reset whenever the route changes. Import
// wizard sub-routes are one continuous setup flow, though, so they deliberately
// share a boundary (and therefore preserve the wizard's in-memory setup state).
export function routeStateKey(pathname: string): string {
  const [firstSegment] = pathname.split("/").filter(Boolean);
  return firstSegment === "import" ? "/import" : pathname;
}
