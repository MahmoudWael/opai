export type TicketAction = 'implement' | 'fix';
export type TicketType = 'Bug' | 'User Story' | 'Unsupported';
export type PromptKind = 'bug' | 'userStory';
export interface TicketPriority { id: string; name: string }
export interface Ticket { id: string; provider: string; title: string; type: TicketType; typeLabel: string; status: string; priority?: TicketPriority; url?: string }
export interface SavedQuery { id: string; name: string }
export interface TicketProvider {
  readonly identity: string;
  /** Lists open tickets assigned to the authenticated user. */
  listAssigned(): Promise<Ticket[]>;
  /** Lists saved queries visible to the authenticated user. */
  listSavedQueries(): Promise<SavedQuery[]>;
  /** Lists normalized tickets returned by one saved query. */
  listQueryTickets(queryId: string): Promise<Ticket[]>;
  /** Retrieves one normalized ticket by provider-specific ID. */
  get(id: string): Promise<Ticket>;
  /** Returns the configured prompt template for a supported ticket kind. */
  promptTemplate(kind: PromptKind): string;
  /** Builds the exact initial prompt for a supported ticket action. */
  prompt(ticket: Ticket, action: TicketAction, template?: string): string;
}
/** Builds the stable provider-qualified key used by session storage. */
export function ticketKey(ticket: Ticket): string { return `${ticket.provider}:${ticket.id}`; }
