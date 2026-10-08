export type Action = 'view' | 'create' | 'edit' | 'delete' | 'export' | 'admin';
export type Module = 'leads' | 'properties' | 'visits' | 'dashboard' | 'audit' | 'users' | 'rentals' | 'finance' | 'portal' | 'renter_portal';

const all: Action[] = ['view', 'create', 'edit', 'delete', 'export', 'admin'];
const rw: Action[] = ['view', 'create', 'edit'];

const ROLE_PERMS: Record<string, Partial<Record<Module, Action[]>>> = {
  owner: { leads: all, properties: all, visits: all, dashboard: all, audit: ['view'], users: all, rentals: all, finance: all },
  manager: { leads: all, properties: all, visits: all, dashboard: ['view'], audit: ['view'], users: ['view'], rentals: all, finance: all },
  finance: { dashboard: ['view'], properties: ['view'], rentals: rw, finance: all },
  broker: { leads: rw, properties: rw, visits: rw, dashboard: ['view'], rentals: ['view'] },
  marketing: { properties: rw, leads: ['view'], dashboard: ['view'] },
  // Proprietário do imóvel (usuário externo): só o portal, e mesmo nele só o que é dele (ver routes/portal.ts).
  landlord: { portal: ['view'] },
  // Inquilino (usuário externo): só o portal do inquilino, e só o contrato dele.
  renter: { renter_portal: ['view', 'create'] },
};

export function can(role: string, mod: Module, action: Action): boolean {
  return ROLE_PERMS[role]?.[mod]?.includes(action) ?? false;
}
