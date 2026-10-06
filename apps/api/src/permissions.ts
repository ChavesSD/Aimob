export type Action = 'view' | 'create' | 'edit' | 'delete' | 'export' | 'admin';
export type Module = 'leads' | 'properties' | 'visits' | 'dashboard' | 'audit' | 'users';

const all: Action[] = ['view', 'create', 'edit', 'delete', 'export', 'admin'];
const rw: Action[] = ['view', 'create', 'edit'];

const ROLE_PERMS: Record<string, Partial<Record<Module, Action[]>>> = {
  owner: { leads: all, properties: all, visits: all, dashboard: all, audit: ['view'], users: all },
  manager: { leads: all, properties: all, visits: all, dashboard: ['view'], audit: ['view'], users: ['view'] },
  broker: { leads: rw, properties: rw, visits: rw, dashboard: ['view'] },
  marketing: { properties: rw, leads: ['view'], dashboard: ['view'] },
};

export function can(role: string, mod: Module, action: Action): boolean {
  return ROLE_PERMS[role]?.[mod]?.includes(action) ?? false;
}
