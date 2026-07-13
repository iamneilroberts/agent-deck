import { useState } from "react";
import { api } from "../api/client";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.login(password);
      onLoggedIn();
    } catch {
      setError("Wrong password.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-dvh items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-xs flex-col gap-3 rounded-lg border border-border bg-surface p-5"
      >
        <h1 className="text-center text-lg font-semibold">AgentDeck</h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          className="rounded-md border border-border bg-surface-raised px-3 py-2 text-sm"
        />
        {error && <div className="text-xs text-danger">{error}</div>}
        <button
          type="submit"
          disabled={submitting || !password}
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
