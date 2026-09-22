import { ticketKey, type Ticket, type TicketProvider } from '../providers/types.js';
import { SessionStore } from './store.js';

export async function syncSessionTickets(store: SessionStore, provider: Pick<TicketProvider, 'identity' | 'get'>, tickets: Ticket[], includeMissing = false): Promise<{ updated: number; unavailable: string[] }> {
  let updated = await store.syncTickets(tickets);
  const unavailable: string[] = [];
  if (!includeMissing) return { updated, unavailable };
  const listed = new Set(tickets.map(ticketKey));
  const registry = await store.all();
  for (const [key, sessions] of Object.entries(registry)) {
    if (!sessions.length || !key.startsWith(`${provider.identity}:`) || listed.has(key)) continue;
    const id = key.slice(provider.identity.length + 1);
    try {
      const ticket = await provider.get(id);
      if (ticketKey(ticket) !== key) throw new Error('Ticket identity changed.');
      updated += await store.syncTickets([ticket]);
    } catch { unavailable.push(id); }
  }
  return { updated, unavailable };
}
