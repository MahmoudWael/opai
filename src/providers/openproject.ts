import type { Config } from '../config.js';
import type { Ticket, TicketAction, TicketProvider, SavedQuery, PromptKind } from './types.js';
type Link = { href?: string | null; title?: string };
type WorkPackage = { id: number; subject: string; _links: { type?: Link; status?: Link; priority?: Link; self?: Link } };
type Collection = { total: number; count: number; offset: number; _embedded?: { elements?: WorkPackage[] } };
type Query = { id: number; name: string; _embedded?: { results?: Collection } };
type QueryCollection = { total: number; _embedded?: { elements?: Query[] } };
function linkId(link?: Link): number | undefined { const match = link?.href?.match(/\/(\d+)$/); return match ? Number(match[1]) : undefined; }
export class OpenProjectProvider implements TicketProvider {
  readonly identity: string;
  private readonly base: string;
  constructor(private readonly config: Config['openproject'], private readonly token: string, private readonly request: typeof fetch = fetch) {
    this.identity = `openproject@${config.instanceId}`;
    this.base = config.url.replace(/\/+$/, '');
  }
  normalize(wp: WorkPackage): Ticket {
    if (!Number.isInteger(wp.id) || !wp.subject || !wp._links) throw new Error('Invalid OpenProject work package response.');
    const typeId = linkId(wp._links.type);
    const type = typeId === this.config.bugTypeId ? 'Bug' : typeId === this.config.userStoryTypeId ? 'User Story' : 'Unsupported';
    const typeLabel = wp._links.type?.title ?? 'Unknown';
    const priorityId = linkId(wp._links.priority);
    const priority = priorityId !== undefined || wp._links.priority?.title
      ? { id: priorityId === undefined ? 'unknown' : String(priorityId), name: wp._links.priority?.title ?? 'Unknown' }
      : undefined;
    return { id: String(wp.id), provider: this.identity, title: wp.subject, type, typeLabel, status: wp._links.status?.title ?? 'Unknown', priority, url: `${this.base}/work_packages/${wp.id}` };
  }
  promptTemplate(kind: PromptKind): string {
    const configured = this.config.promptTemplates?.[kind];
    const template = configured ?? (kind === 'bug' ? 'fix openproject bug {{id}}' : 'implement openproject user story {{id}}');
    if (typeof template !== 'string' || !template.includes('{{id}}')) throw new Error(`OpenProject ${kind} prompt template must contain {{id}}.`);
    return template;
  }
  prompt(ticket: Ticket, action: TicketAction, override?: string): string {
    if (ticket.provider !== this.identity) throw new Error('Ticket belongs to another provider.');
    const kind = action === 'fix' && ticket.type === 'Bug' ? 'bug' : action === 'implement' && ticket.type === 'User Story' ? 'userStory' : undefined;
    if (!kind) throw new Error(`No ${action} action for ${ticket.type} tickets.`);
    const template = override ?? this.promptTemplate(kind);
    if (typeof template !== 'string' || !template.includes('{{id}}')) throw new Error(`OpenProject ${kind} prompt template must contain {{id}}.`);
    return template.replaceAll('{{id}}', ticket.id);
  }
  private async getJson<T>(path: string): Promise<T> {
    let response: Response;
    const timeoutSeconds = this.config.requestTimeoutSeconds ?? 15;
    const signal = AbortSignal.timeout(timeoutSeconds * 1000);
    try { response = await this.request(`${this.base}${path}`, { method: 'GET', signal, headers: { Authorization: `Basic ${Buffer.from(`apikey:${this.token}`).toString('base64')}`, Accept: 'application/hal+json' } }); }
    catch (error) {
      if (signal.aborted) throw new Error(`OpenProject request timed out after ${timeoutSeconds}s at ${this.base}.`, { cause: error });
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      throw new Error(`Could not connect to OpenProject at ${this.base}${cause ? ` (${cause})` : ''}. Check openproject.url, DNS, VPN, and TLS.`, { cause: error });
    }
    if (!response.ok) throw new Error(`OpenProject API returned HTTP ${response.status}${response.status === 401 ? ' (check API token)' : ''}.`);
    try { return await response.json() as T; } catch { throw new Error('OpenProject returned invalid JSON.'); }
  }
  async listAssigned(): Promise<Ticket[]> {
    const user = await this.getJson<{ id: number }>('/api/v3/users/me');
    if (!Number.isInteger(user.id)) throw new Error('OpenProject did not return a user ID.');
    const filters = JSON.stringify([{ assignee: { operator: '=', values: [String(user.id)] } }, { status: { operator: 'o', values: [] } }]);
    const sortBy = JSON.stringify([['updatedAt', 'desc']]);
    const result: Ticket[] = [];
    for (let offset = 1; ; ) {
      const query = new URLSearchParams({ filters, sortBy, offset: String(offset), pageSize: '100' });
      const page = await this.getJson<Collection>(`/api/v3/work_packages?${query}`);
      const elements = page._embedded?.elements;
      if (!Array.isArray(elements) || !Number.isInteger(page.total)) throw new Error('Invalid OpenProject work package collection.');
      result.push(...elements.map(wp => this.normalize(wp)));
      if (!elements.length || result.length >= page.total) break;
      offset += 1;
    }
    return result;
  }
  async listSavedQueries(): Promise<SavedQuery[]> {
    const queries: SavedQuery[] = [];
    for (let offset = 1; ; offset++) {
      const params = new URLSearchParams({ offset: String(offset), pageSize: '100' });
      const page = await this.getJson<QueryCollection>(`/api/v3/queries?${params}`);
      const elements = page._embedded?.elements;
      if (!Array.isArray(elements) || !Number.isInteger(page.total)) throw new Error('Invalid OpenProject query collection.');
      for (const query of elements) {
        if (!Number.isInteger(query.id) || typeof query.name !== 'string') throw new Error('Invalid OpenProject saved query.');
        queries.push({ id: String(query.id), name: query.name });
      }
      if (!elements.length || queries.length >= page.total) return queries;
    }
  }
  async listQueryTickets(queryId: string): Promise<Ticket[]> {
    if (!/^\d+$/.test(queryId)) throw new Error('OpenProject query ID must be numeric.');
    const tickets: Ticket[] = [];
    for (let offset = 1; ; offset++) {
      const params = new URLSearchParams({ offset: String(offset), pageSize: '100' });
      const query = await this.getJson<Query>(`/api/v3/queries/${queryId}?${params}`);
      const results = query._embedded?.results;
      const elements = results?._embedded?.elements;
      if (!results || !Array.isArray(elements) || !Number.isInteger(results.total)) throw new Error('Invalid OpenProject query results.');
      tickets.push(...elements.map(wp => this.normalize(wp)));
      if (!elements.length || tickets.length >= results.total) return tickets;
    }
  }
  async get(id: string): Promise<Ticket> {
    if (!/^\d+$/.test(id)) throw new Error('OpenProject ticket ID must be numeric.');
    return this.normalize(await this.getJson<WorkPackage>(`/api/v3/work_packages/${id}`));
  }
}
