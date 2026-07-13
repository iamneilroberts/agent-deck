import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api/client";
import { useUiStore } from "./store/uiStore";
import { Login } from "./components/Login";
import { SessionsList } from "./components/SessionsList";
import { SessionScreen } from "./components/SessionScreen";

export function App() {
  const queryClient = useQueryClient();
  const authenticated = useUiStore((s) => s.authenticated);
  const setAuthenticated = useUiStore((s) => s.setAuthenticated);
  const activeSessionId = useUiStore((s) => s.activeSessionId);

  // Bootstrap: probe an authenticated route once. A 401 means "show the login screen"; any
  // other outcome (including a network error) is treated as "already authenticated" so the
  // real error surfaces inside the app instead of bouncing to login on every hiccup.
  const bootstrap = useQuery({
    queryKey: ["bootstrap"],
    queryFn: async () => {
      try {
        await api.listSessions();
        setAuthenticated(true);
      } catch (err) {
        if (err instanceof Error && "status" in err && (err as { status: number }).status === 401) {
          setAuthenticated(false);
        } else {
          setAuthenticated(true);
        }
      }
      return true;
    },
    retry: false,
    staleTime: Infinity,
  });

  if (bootstrap.isLoading) {
    return <div className="flex h-dvh items-center justify-center text-sm text-ink-dim">Loading…</div>;
  }

  if (!authenticated) {
    return (
      <Login
        onLoggedIn={() => {
          setAuthenticated(true);
          void queryClient.invalidateQueries();
        }}
      />
    );
  }

  return activeSessionId ? (
    <SessionScreen sessionId={activeSessionId} />
  ) : (
    <SessionsList />
  );
}
