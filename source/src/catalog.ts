import * as fs from 'fs';
import * as path from 'path';
import { Catalog, CatalogPackage, PostInstallStep } from './types';

const VERSION_ID = /^04t[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;
const STEP_TYPES = ['permset', 'apex', 'dataTree', 'deploy', 'sf'];

export function readCatalog(file: string): Catalog {
  const raw = fs.readFileSync(file, 'utf8');
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`Catalog ${file} is not valid JSON: ${e.message}`);
  }
  const packages: CatalogPackage[] = Array.isArray(json) ? json : json.packages;
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error(`Catalog ${file} must contain a non-empty "packages" array.`);
  }
  validate(packages);
  return { packages, baseDir: path.dirname(file), source: file };
}

export function validate(packages: CatalogPackage[]): void {
  const errors: string[] = [];
  const ids = new Set<string>();
  packages.forEach((p, i) => {
    const where = `packages[${i}]${p?.id ? ` (${p.id})` : ''}`;
    if (!p.id) errors.push(`${where}: "id" is required`);
    else if (ids.has(p.id)) errors.push(`${where}: duplicate id`);
    else ids.add(p.id);
    if (!p.name) errors.push(`${where}: "name" is required`);
    if (p.source !== undefined && typeof p.source !== 'string') errors.push(`${where}: "source" must be a text`);
    if (p.kind !== undefined && p.kind !== 'package' && p.kind !== 'demoBranding') errors.push(`${where}: "kind" must be "package" or "demoBranding"`);
    if (p.kind === 'demoBranding') {
      p.versionId = p.versionId ?? '';
      (p.branding?.apps ?? []).forEach((a, j) => {
        if (!a?.name || !a?.label) errors.push(`${where}.branding.apps[${j}]: "name" and "label" are required`);
      });
      (p.branding?.profiles ?? []).forEach((a, j) => {
        if (!a?.name || !a?.label) errors.push(`${where}.branding.profiles[${j}]: "name" and "label" are required`);
        else if (!a.label.includes('{company}')) errors.push(`${where}.branding.profiles[${j}]: "label" must contain {company}`);
      });
    } else if (!p.versionId || !VERSION_ID.test(p.versionId)) errors.push(`${where}: "versionId" must be a 04t… package version Id`);
    (p.postInstall ?? []).forEach((s: PostInstallStep, j) => {
      const sw = `${where}.postInstall[${j}]`;
      if (!STEP_TYPES.includes((s as any).type)) errors.push(`${sw}: unknown type "${(s as any).type}" (expected ${STEP_TYPES.join(', ')})`);
      if (s.type === 'permset' && !s.name) errors.push(`${sw}: "name" is required`);
      if (s.type === 'apex' && !s.file) errors.push(`${sw}: "file" is required`);
      if (s.type === 'dataTree' && !s.plan) errors.push(`${sw}: "plan" is required`);
      if (s.type === 'deploy' && !s.path) errors.push(`${sw}: "path" is required`);
      if (s.type === 'sf' && !Array.isArray(s.args)) errors.push(`${sw}: "args" must be an array`);
    });
  });
  packages.forEach(p => (p.dependsOn ?? []).forEach(d => {
    if (!ids.has(d)) errors.push(`${p.id}: dependsOn "${d}" is not in the catalog`);
  }));
  if (errors.length) throw new Error('Invalid catalog:\n- ' + errors.join('\n- '));
}

/**
 * Adds missing dependencies and returns the packages in install order:
 * dependencies first, then by `order`, then by catalog position.
 */
export function resolveInstallPlan(all: CatalogPackage[], selectedIds: string[]): { ordered: CatalogPackage[]; addedDeps: CatalogPackage[] } {
  const byId = new Map(all.map(p => [p.id, p]));
  const position = new Map(all.map((p, i) => [p.id, i]));

  const wanted = new Set<string>();
  const visit = (id: string) => {
    if (wanted.has(id)) return;
    wanted.add(id);
    (byId.get(id)?.dependsOn ?? []).forEach(visit);
  };
  selectedIds.forEach(visit);

  const addedDeps = [...wanted].filter(id => !selectedIds.includes(id)).map(id => byId.get(id)!);

  // Kahn topological sort with a priority on (order, catalog position).
  const indeg = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of wanted) {
    const deps = (byId.get(id)!.dependsOn ?? []).filter(d => wanted.has(d));
    indeg.set(id, deps.length);
    deps.forEach(d => children.set(d, [...(children.get(d) ?? []), id]));
  }
  const prio = (id: string) => [byId.get(id)!.order ?? Number.MAX_SAFE_INTEGER, position.get(id)!];
  const cmp = (a: string, b: string) => {
    const [oa, pa] = prio(a);
    const [ob, pb] = prio(b);
    return oa - ob || pa - pb;
  };

  const ready = [...wanted].filter(id => indeg.get(id) === 0).sort(cmp);
  const ordered: CatalogPackage[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    ordered.push(byId.get(id)!);
    for (const c of children.get(id) ?? []) {
      indeg.set(c, indeg.get(c)! - 1);
      if (indeg.get(c) === 0) {
        ready.push(c);
        ready.sort(cmp);
      }
    }
  }
  if (ordered.length !== wanted.size) {
    const stuck = [...wanted].filter(id => !ordered.some(p => p.id === id));
    throw new Error(`Circular dependency between: ${stuck.join(', ')}`);
  }
  return { ordered, addedDeps };
}

/** Accepts a 04t Id or any install link (…installPackage.apexp?p0=04t…, …/packaging/installPackage.apexp?p0=…). */
export function parseVersionId(input: string): string | undefined {
  const m = input.trim().match(/04t[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?/);
  return m && VERSION_ID.test(m[0]) ? m[0] : undefined;
}

/** Slug used as package id. */
export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'package';
}

/** Reads the raw catalog JSON (or an empty one), adds/replaces a package and writes it back, keeping other keys. */
export function upsertPackage(file: string, pkg: CatalogPackage): void {
  let json: any = { packages: [] };
  if (fs.existsSync(file)) {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(json)) json = { packages: json };
    json.packages ??= [];
  }
  const i = json.packages.findIndex((p: CatalogPackage) => p.id === pkg.id);
  if (i >= 0) json.packages[i] = { ...json.packages[i], ...pkg };
  else json.packages.push(pkg);
  validate(json.packages);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
}
