// Activity-bar view "ReejFastOrg": connected org, packages of the catalog (with their status in that org),
// authenticated orgs, last install run and the environment — same style as ReejDataImport.
import * as vscode from 'vscode';
import { AuthOrg } from './orgs';
import { kindLabel } from './orgs';
import { Catalog, CatalogPackage, ConnectedOrg, PackageResult } from './types';

export interface SidebarDeps {
  org(): ConnectedOrg | undefined;
  /** Catalog without any prompt: a catalog, an error message, or undefined when there is no file. */
  catalog(): { catalog?: Catalog; error?: string; path?: string; builtIn?: boolean };
  orgs(): Promise<AuthOrg[]>;
  installedVersionIds(org: ConnectedOrg): Promise<Set<string>>;
  sfVersion(): Promise<string | undefined>;
  lastRun(): { when: string; org: string; results: PackageResult[] } | undefined;
  /** Package ids ticked in the tree. */
  checked(): Set<string>;
  sfCommand(): string;
}

type Section = 'org' | 'packages' | 'orgs' | 'lastRun' | 'environment';

export class Item extends vscode.TreeItem {
  section?: Section;
  pkg?: CatalogPackage;
  authOrg?: AuthOrg;
  constructor(label: string, state = vscode.TreeItemCollapsibleState.None) {
    super(label, state);
  }
}

const cmd = (command: string, title: string, ...args: any[]): vscode.Command => ({ command, title, arguments: args });
const icon = (id: string, color?: string) => new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);

function section(label: string, s: Section, iconId: string, expanded = true): Item {
  const it = new Item(label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
  it.section = s;
  it.iconPath = icon(iconId);
  it.contextValue = `fastSection.${s}`;
  return it;
}

function info(label: string, iconId = 'info', command?: vscode.Command, tooltip?: string): Item {
  const it = new Item(label);
  it.iconPath = icon(iconId);
  it.command = command;
  it.tooltip = tooltip;
  it.contextValue = 'fastInfo';
  return it;
}

export class FastOrgSidebar implements vscode.TreeDataProvider<Item> {
  private emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private cache: { orgs?: AuthOrg[]; orgsError?: string; installed?: Map<string, Set<string>>; sf?: string | null; sfError?: string } = {};

  constructor(private deps: SidebarDeps) {}

  /** Redraw; force = also re-ask the sf CLI (orgs, installed packages, version). */
  refresh(force = false) {
    if (force) this.cache = {};
    this.emitter.fire(undefined);
  }

  /** Forget the installed-package status of one org (after an install). */
  invalidateInstalled(target?: string) {
    if (target) this.cache.installed?.delete(target);
    else delete this.cache.installed;
    this.emitter.fire(undefined);
  }

  getTreeItem(e: Item) {
    return e;
  }

  async getChildren(e?: Item): Promise<Item[]> {
    if (!e) {
      const org = this.deps.org();
      const last = this.deps.lastRun();
      return [
        section('Connected org', 'org', 'cloud'),
        this.packagesSection(),
        section('Authenticated orgs', 'orgs', 'organization', false),
        ...(last ? [section('Last run', 'lastRun', 'history', !!org)] : []),
        section('Environment', 'environment', 'tools', false)
      ];
    }
    switch (e.section) {
      case 'org': return this.orgItems();
      case 'packages': return this.packageItems();
      case 'orgs': return this.authOrgItems();
      case 'lastRun': return this.lastRunItems();
      case 'environment': return this.envItems();
    }
    return [];
  }

  private packagesSection(): Item {
    const it = section('Packages', 'packages', 'package');
    it.command = cmd('reejFastOrg.openPackages', 'Open packages');
    it.tooltip = 'Click to open the package screen';
    const { catalog } = this.deps.catalog();
    if (catalog) {
      const ids = new Set(catalog.packages.map(p => p.id));
      const n = [...this.deps.checked()].filter(id => ids.has(id)).length;
      it.description = n ? `${n} selected` : 'tick the packages to install';
      it.contextValue = n ? 'fastSection.packages.selected' : 'fastSection.packages';
    }
    return it;
  }

  private orgItems(): Item[] {
    const org = this.deps.org();
    if (!org) {
      return [info('No org connected — click to connect', 'plug', cmd('reejFastOrg.connectOrg', 'Connect'))];
    }
    const it = new Item(org.alias ?? org.username);
    it.description = `${kindLabel(org.kind)}${org.orgName ? ` · ${org.orgName}` : ''}`;
    it.tooltip = new vscode.MarkdownString(
      `**${org.orgName ?? org.target}** — ${kindLabel(org.kind)}\n\n${org.username}\n\n${org.instanceUrl ?? ''}`
    );
    it.iconPath = org.kind === 'prod' ? icon('warning', 'list.warningForeground') : icon('cloud', 'charts.blue');
    it.contextValue = 'fastCurrentOrg';
    return [
      it,
      info('Choose packages to install…', 'rocket', cmd('reejFastOrg.openPackages', 'Open packages'))
    ];
  }

  private async packageItems(): Promise<Item[]> {
    const { catalog, error, path } = this.deps.catalog();
    if (error) return [info(error, 'error', cmd('reejFastOrg.openCatalog', 'Open catalog'))];
    if (!catalog) {
      return [info(path ? 'No catalog yet — click to create one' : 'Open a folder to use a catalog', 'new-file', cmd('reejFastOrg.openCatalog', 'Open catalog'))];
    }

    const org = this.deps.org();
    let installed: Set<string> | undefined;
    if (org) {
      this.cache.installed ??= new Map();
      installed = this.cache.installed.get(org.target);
      if (!installed) {
        installed = await this.deps.installedVersionIds(org).catch(() => new Set<string>());
        this.cache.installed.set(org.target, installed);
      }
    }

    const checked = this.deps.checked();
    const sorted = [...catalog.packages].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
    return sorted.map(p => {
      const it = new Item(p.name);
      it.pkg = p;
      const allowed = !org || !p.orgTypes?.length || p.orgTypes.includes(org.kind);
      const isInstalled = !!installed?.has(p.versionId);
      const flags = [p.requiresKey ? 'key' : '', p.postInstall?.length ? `${p.postInstall.length} post-install` : '', !allowed ? `not for ${org ? kindLabel(org.kind) : ''}` : '']
        .filter(Boolean).join(' · ');
      it.description = isInstalled ? `installed${flags ? ' · ' + flags : ''}` : flags || (p.kind === 'demoBranding' ? 'customer customization' : p.versionId);
      it.iconPath = !allowed
        ? icon('circle-slash', 'disabledForeground')
        : isInstalled
          ? icon('pass-filled', 'testing.iconPassed')
          : icon('package');
      const md = new vscode.MarkdownString(
        `**${p.name}**  \n${p.description ?? ''}\n\n` +
        `Version Id: \`${p.versionId}\`  \n` +
        (p.dependsOn?.length ? `Requires: ${p.dependsOn.join(', ')}  \n` : '') +
        (p.orgTypes?.length ? `Org types: ${p.orgTypes.join(', ')}  \n` : '') +
        (p.postInstall?.length ? `Post-install: ${p.postInstall.map(s => s.label ?? s.type).join(', ')}` : '')
      );
      it.tooltip = md;
      it.contextValue = allowed ? (isInstalled ? 'fastPackage.installed' : 'fastPackage') : 'fastPackage.blocked';
      if (allowed && !isInstalled) {
        it.checkboxState = checked.has(p.id) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      }
      return it;
    });
  }

  private async authOrgItems(): Promise<Item[]> {
    if (!this.cache.orgs && !this.cache.orgsError) {
      try {
        this.cache.orgs = await this.deps.orgs();
      } catch (e: any) {
        this.cache.orgsError = e.message;
      }
    }
    if (this.cache.orgsError) return [info(this.cache.orgsError, 'error')];
    const current = this.deps.org();
    const list = this.cache.orgs ?? [];
    if (!list.length) return [info('No authenticated org — log in to one', 'sign-in', cmd('reejFastOrg.connectOrg', 'Connect'))];
    return list.map(o => {
      const it = new Item(o.alias ?? o.username);
      it.authOrg = o;
      const isCurrent = !!current && current.username === o.username;
      it.description = [o.alias ? o.username : '', o.isScratch ? 'scratch' : '', isCurrent ? '● connected' : ''].filter(Boolean).join(' · ');
      it.tooltip = `${o.username}\n${o.instanceUrl ?? ''}${o.connectedStatus ? `\n${o.connectedStatus}` : ''}`;
      const broken = o.connectedStatus && !/connected|active/i.test(o.connectedStatus);
      it.iconPath = broken ? icon('debug-disconnect', 'list.errorForeground') : icon(isCurrent ? 'circle-filled' : 'circle-outline', isCurrent ? 'charts.green' : undefined);
      it.contextValue = isCurrent ? 'fastAuthOrg.current' : 'fastAuthOrg';
      return it;
    });
  }

  private lastRunItems(): Item[] {
    const last = this.deps.lastRun();
    if (!last) return [];
    const head = info(`${last.org} · ${new Date(last.when).toLocaleString()}`, 'calendar', cmd('reejFastOrg.showLog', 'Show log'), 'Click to open the log');
    const iconFor = { installed: icon('pass-filled', 'testing.iconPassed'), skipped: icon('debug-step-over'), failed: icon('error', 'testing.iconFailed'), 'not run': icon('circle-outline') };
    return [
      head,
      ...last.results.map(r => {
        const it = new Item(r.pkg.name);
        it.description = r.status;
        it.iconPath = iconFor[r.status];
        it.tooltip = [r.error, ...r.steps.map(s => `${s.status === 'ok' ? '✔' : '✖'} ${s.label}${s.error ? ': ' + s.error : ''}`)].filter(Boolean).join('\n') || r.status;
        it.contextValue = 'fastRunResult';
        it.command = cmd('reejFastOrg.showLog', 'Show log');
        return it;
      })
    ];
  }

  private async envItems(): Promise<Item[]> {
    if (this.cache.sf === undefined) {
      try {
        this.cache.sf = (await this.deps.sfVersion()) ?? null;
      } catch (e: any) {
        this.cache.sf = null;
        this.cache.sfError = e.message;
      }
    }
    const { path, builtIn } = this.deps.catalog();
    return [
      this.cache.sf
        ? info(`Salesforce CLI ${this.cache.sf}`, 'terminal', undefined, `Using: ${this.deps.sfCommand()}`)
        : info('Salesforce CLI not found — click to set its path', 'warning', cmd('workbench.action.openSettings', 'Settings', 'reejFastOrg.sfPath'), this.cache.sfError),
      info(builtIn ? 'Catalog: built-in Reej list' : path ? `Catalog: ${vscode.workspace.asRelativePath(path, false)}` : 'No catalog path', 'json', cmd('reejFastOrg.openCatalog', 'Open catalog'), builtIn ? 'Read-only list shipped with the extension. Adding a package saves an editable copy.' : path),
      info('Choose another catalog…', 'folder-opened', cmd('reejFastOrg.chooseCatalog', 'Choose catalog')),
      info('Settings', 'gear', cmd('workbench.action.openSettings', 'Settings', 'reejFastOrg'))
    ];
  }
}
