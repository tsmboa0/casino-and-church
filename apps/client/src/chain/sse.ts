/** Waits for one bet's settlement (opened per bet, closed when it lands). */
export function subscribe(api: string, account: string, onBet: (betId: number) => void): () => void {
  const source = new EventSource(`${api}/events/${account}`);
  source.addEventListener('bet_settled', (event) => {
    try { onBet(Number(JSON.parse((event as MessageEvent).data).bet_id)); } catch { /* ignore a bad frame */ }
  });
  return () => source.close();
}

/**
 * The long-lived stream for the whole session: the hosts' decisions and realm events are broadcast to every
 * connected client. EventSource reconnects on its own after a drop.
 */
export function listen(api: string, account: string, on: Record<string, (data: any) => void>): () => void {
  const source = new EventSource(`${api}/events/${account}`);
  for (const [name, fn] of Object.entries(on)) {
    source.addEventListener(name, (event) => {
      try { fn(JSON.parse((event as MessageEvent).data)); } catch { /* ignore a bad frame */ }
    });
  }
  return () => source.close();
}
