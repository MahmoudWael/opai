export type TicketAction = 'implement' | 'fix';
export type TicketType = 'Bug' | 'User Story' | 'Unsupported';
export interface TicketPriority { id: string; name: string }
export interface Ticket { id: string; provider: string; title: string; type: TicketType; typeLabel: string; status: string; priority?: TicketPriority; url?: string }
export interface SavedQuery { id: string; name: string }
export interface TicketProvider { readonly identity: string; listAssigned(): Promise<Ticket[]>; listSavedQueries(): Promise<SavedQuery[]>; listQueryTickets(queryId: string): Promise<Ticket[]>; get(id: string): Promise<Ticket>; prompt(ticket: Ticket, action: TicketAction): string }
export function ticketKey(ticket: Ticket): string { return `${ticket.provider}:${ticket.id}`; }
