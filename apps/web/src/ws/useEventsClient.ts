// React binding for AgentEventsClient: one client per mounted session screen, torn down on
// unmount or session switch, state surfaced via useSyncExternalStore.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AgentEventsClient } from "./eventsClient";
import { initialEventsState, type EventsState } from "./reducer";

export function useEventsClient(sessionId: string | null, initialLastSeq = 0): EventsState {
  const client = useMemo(() => new AgentEventsClient(), []);

  useEffect(() => {
    if (!sessionId) return;
    client.start(sessionId, initialLastSeq);
    return () => client.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialLastSeq is a one-time seed
  }, [client, sessionId]);

  return useSyncExternalStore(
    (onStoreChange) => client.subscribe(onStoreChange),
    () => client.getState(),
    () => (sessionId ? client.getState() : initialEventsState()),
  );
}
