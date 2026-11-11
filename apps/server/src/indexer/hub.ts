type Listener = (event: string, data: unknown) => void;

export class Hub {
  private rooms = new Map<string, Set<Listener>>();

  add(account: string, listener: Listener) {
    const set = this.rooms.get(account) ?? new Set();
    set.add(listener);
    this.rooms.set(account, set);
  }

  remove(account: string, listener: Listener) {
    this.rooms.get(account)?.delete(listener);
  }

  publish(account: string, event: string, data: unknown) {
    for (const listener of this.rooms.get(account) ?? []) listener(event, data);
  }

  /** every connected client (host decisions, realm events) */
  broadcast(event: string, data: unknown) {
    for (const set of this.rooms.values()) for (const listener of set) listener(event, data);
  }
}
