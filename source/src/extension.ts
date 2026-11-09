import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BRAND_IMAGE_SIZE, BrandingInput, BrandingResult, ICON_TYPES, imageSize, MAX_ICON_BYTES, normalizeColor, THEMES_SETUP_PATH } from './branding';
import { parseVersionId, readCatalog, resolveInstallPlan, slugify, upsertPackage } from './catalog';
import { getInstalledVersionIds, InstallSettings, runInstallPlan, summarize } from './installer';
import { describeOrg, kindLabel, listAuthenticatedOrgs, pickOrConnectOrg } from './orgs';
import { CancelledError, resetSfResolution, sf, sfCommandInUse, sfVersion } from './sfCli';
import { PackagesPanel } from './packagesPanel';
import { FastOrgSidebar, Item } from './sidebar';
import { Catalog, CatalogPackage, ConnectedOrg, PackageResult } from './types';

const ORG_STATE_KEY = 'reejFastOrg.connectedOrg';
const LAST_RUN_KEY = 'reejFastOrg.lastRun';
const CHECKED_KEY = 'reejFastOrg.checked';
const BRANDING_KEY = 'reejFastOrg.lastBranding';

interface LastRun { when: string; org: string; results: PackageResult[] }

let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let context: vscode.ExtensionContext;
let sidebar: FastOrgSidebar;

const log = (line: string) => output.appendLine(line);

/** Redraw the sidebar and the package screen. */
function refreshAll(force = false) {
  sidebar?.refresh(force);
  PackagesPanel.current?.refresh(force);
}

export function activate(ctx: vscode.ExtensionContext) {
  context = ctx;
  output = vscode.window.createOutputChannel('ReejFastOrg Setup');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'reejFastOrg.runSetup';
  refreshStatusBar();
  statusBar.show();

  sidebar = new FastOrgSidebar({
    org: getOrg,
    catalog: catalogQuiet,
    orgs: () => listAuthenticatedOrgs({ cwd: workspaceDir() }),
    installedVersionIds: org => getInstalledVersionIds(org, { cwd: workspaceDir() }),
    sfVersion: () => sfVersion({ cwd: workspaceDir() }),
    sfCommand: sfCommandInUse,
    checked: getChecked,
    lastRun: () => context.workspaceState.get<LastRun>(LAST_RUN_KEY)
  });
  const view = vscode.window.createTreeView('reejFastOrg.home', { treeDataProvider: sidebar, showCollapseAll: true, manageCheckboxStateManually: true });
  view.onDidChangeCheckboxState(e => guard(() => onCheckboxes(e.items as readonly [Item, vscode.TreeItemCheckboxState][])));

  // Redraw when the catalog file changes or the catalog setting moves.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.json');
  const onJson = (u: vscode.Uri) => { if (u.fsPath === catalogPath()) refreshAll(); };
  watcher.onDidChange(onJson);
  watcher.onDidCreate(onJson);
  watcher.onDidDelete(onJson);

  const r = (id: string, fn: (...args: any[]) => Promise<unknown>) =>
    vscode.commands.registerCommand(id, (...args: any[]) => guard(() => fn(...args)));

  ctx.subscriptions.push(
    output,
    statusBar,
    view,
    watcher,
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('reejFastOrg.sfPath')) {
        resetSfResolution();
        refreshAll(true);
      } else if (e.affectsConfiguration('reejFastOrg')) refreshAll();
    }),
    r('reejFastOrg.runSetup', runSetup),
    r('reejFastOrg.openPackages', async () => openPackages()),
    r('reejFastOrg.connectOrg', connectOrg),
    r('reejFastOrg.installPackages', installPackages),
    r('reejFastOrg.installPackage', installOnePackage),
    r('reejFastOrg.installChecked', installChecked),
    r('reejFastOrg.selectAll', async () => setChecked(new Set((catalogQuiet().catalog?.packages ?? []).filter(isAllowedNow).map(p => p.id)))),
    r('reejFastOrg.selectNone', async () => setChecked(new Set())),
    r('reejFastOrg.addPackage', addPackage),
    r('reejFastOrg.removePackage', removePackage),
    r('reejFastOrg.chooseCatalog', chooseCatalog),
    r('reejFastOrg.useOrg', useOrg),
    r('reejFastOrg.openOrg', openOrg),
    r('reejFastOrg.openInstalledPackages', (item?: Item) => openOrg(item, 'lightning/setup/ImportedPackage/home')),
    r('reejFastOrg.disconnectOrg', disconnectOrg),
    r('reejFastOrg.openCatalog', openCatalog),
    r('reejFastOrg.refresh', async () => refreshAll(true)),
    r('reejFastOrg.copyVersionId', async (item?: Item) => {
      if (!item?.pkg) return;
      await vscode.env.clipboard.writeText(item.pkg.versionId);
      vscode.window.showInformationMessage(`ReejFastOrg: copied ${item.pkg.versionId}`);
    }),
    vscode.commands.registerCommand('reejFastOrg.showLog', () => output.show())
  );
}

export function deactivate() {}

/* ---------- helpers ---------- */

async function guard(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e: any) {
    if (e instanceof CancelledError) {
      log('Cancelled.');
      vscode.window.showWarningMessage('ReejFastOrg: cancelled.');
      return;
    }
    log(`ERROR: ${e.message}`);
    const pick = await vscode.window.showErrorMessage(`ReejFastOrg: ${e.message}`, 'Show Log');
    if (pick) output.show();
  }
}

function getOrg(): ConnectedOrg | undefined {
  return context.workspaceState.get<ConnectedOrg>(ORG_STATE_KEY);
}

async function setOrg(org: ConnectedOrg | undefined) {
  await context.workspaceState.update(ORG_STATE_KEY, org);
  refreshStatusBar();
  refreshAll();
}

function refreshStatusBar() {
  const org = getOrg();
  if (org) {
    statusBar.text = `$(cloud) ${org.alias ?? org.username}${org.kind === 'prod' ? ' $(warning)' : ''}`;
    statusBar.tooltip = `ReejFastOrg: ${org.orgName ?? ''} (${kindLabel(org.kind)})\n${org.username}\nClick to run setup`;
    statusBar.backgroundColor = org.kind === 'prod' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  } else {
    statusBar.text = '$(cloud) ReejFastOrg: no org';
    statusBar.tooltip = 'Click to connect an org and install packages';
    statusBar.backgroundColor = undefined;
  }
}

function settings(): InstallSettings {
  const c = vscode.workspace.getConfiguration('reejFastOrg');
  return {
    waitMinutes: c.get('waitMinutes', 30),
    securityType: c.get('securityType', 'AdminsOnly'),
    skipAlreadyInstalled: c.get('skipAlreadyInstalled', true),
    stopOnError: c.get('stopOnError', true)
  };
}

function workspaceDir(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** The Reej package list shipped inside the extension (read-only). */
function builtInCatalog(): string {
  return context.asAbsolutePath(path.join('resources', 'reej-packages.json'));
}

function isBuiltIn(file?: string): boolean {
  return !!file && path.resolve(file) === path.resolve(builtInCatalog());
}

/**
 * Catalog in use: the reejFastOrg.catalogPath file when it exists (or when the user set it explicitly),
 * otherwise the built-in Reej list.
 */
function catalogPath(): string | undefined {
  const conf = vscode.workspace.getConfiguration('reejFastOrg');
  const p = conf.get<string>('catalogPath', '.reejfastorg/packages.json');
  const ws = workspaceDir();
  const resolved = path.isAbsolute(p) ? p : ws ? path.join(ws, p) : undefined;
  if (resolved && fs.existsSync(resolved)) return resolved;
  const i = conf.inspect<string>('catalogPath');
  const explicit = i?.globalValue ?? i?.workspaceValue ?? i?.workspaceFolderValue;
  if (explicit && resolved) return resolved; // set on purpose but missing: let the user see it
  return builtInCatalog();
}

/** For the sidebar: never prompts. */
function catalogQuiet(): { catalog?: Catalog; error?: string; path?: string; builtIn?: boolean } {
  const file = catalogPath();
  const builtIn = isBuiltIn(file);
  if (!file || !fs.existsSync(file)) return { path: file, builtIn };
  try {
    return { catalog: readCatalog(file), path: file, builtIn };
  } catch (e: any) {
    return { error: e.message.split('\n')[0], path: file, builtIn };
  }
}

async function loadCatalogInteractive(explicitFile?: string): Promise<Catalog | undefined> {
  let file = explicitFile ?? catalogPath();
  if (!file || !fs.existsSync(file)) {
    const choice = await vscode.window.showWarningMessage(
      file
        ? `No package catalog found at ${path.relative(workspaceDir() ?? '', file)}.`
        : 'Open a folder (or set reejFastOrg.catalogPath to an absolute path) to use a package catalog.',
      { modal: true },
      ...(file ? ['Create sample catalog'] : []),
      'Browse for catalog…'
    );
    if (choice === 'Create sample catalog' && file) {
      createSampleCatalog(file);
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      vscode.window.showInformationMessage('ReejFastOrg: sample catalog created — replace the 04t Ids with your packages, then run the command again.');
      return undefined;
    }
    if (choice === 'Browse for catalog…') {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Package catalog': ['json'] } });
      if (!picked?.[0]) return undefined;
      file = picked[0].fsPath;
    } else {
      return undefined;
    }
  }
  const catalog = readCatalog(file);
  log(`Catalog: ${file} (${catalog.packages.length} package(s))`);
  return catalog;
}

function createSampleCatalog(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(builtInCatalog(), file);
}

/** The built-in list is read-only: save an editable copy and make it the catalog for every workspace. */
async function saveEditableCopy(): Promise<string | undefined> {
  const go = await vscode.window.showInformationMessage(
    'ReejFastOrg: the built-in Reej package list is read-only. Save an editable copy (used by all your workspaces)?',
    { modal: true },
    'Save a Copy…'
  );
  if (!go) return undefined;
  const ws = workspaceDir();
  const uri = await vscode.window.showSaveDialog({
    filters: { 'Package catalog': ['json'] },
    saveLabel: 'Save catalog',
    defaultUri: vscode.Uri.file(path.join(ws ?? require('os').homedir(), 'reej-packages.json'))
  });
  if (!uri) return undefined;
  fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
  fs.copyFileSync(builtInCatalog(), uri.fsPath);
  await vscode.workspace.getConfiguration('reejFastOrg').update('catalogPath', uri.fsPath, vscode.ConfigurationTarget.Global);
  refreshAll(true);
  vscode.window.showInformationMessage(`ReejFastOrg: your catalog is now ${uri.fsPath}`);
  return uri.fsPath;
}

/* ---------- selection (tree checkboxes) ---------- */

function getChecked(): Set<string> {
  const stored = context.workspaceState.get<string[]>(CHECKED_KEY);
  if (stored) return new Set(stored);
  // First time: start from the packages flagged "default": true in the catalog.
  return new Set((catalogQuiet().catalog?.packages ?? []).filter(p => p.default).map(p => p.id));
}

async function setChecked(ids: Set<string>) {
  await context.workspaceState.update(CHECKED_KEY, [...ids]);
  refreshAll();
}

function isAllowedNow(p: CatalogPackage): boolean {
  const org = getOrg();
  return !org || !p.orgTypes?.length || p.orgTypes.includes(org.kind);
}

/** Ticking a package also ticks what it needs; unticking it also unticks what needs it. */
async function toggleSelection(id: string, on: boolean): Promise<{ added: string[]; removed: string[] }> {
  const catalog = catalogQuiet().catalog;
  const added: string[] = [];
  const removed: string[] = [];
  if (!catalog) return { added, removed };
  const ids = getChecked();
  if (on) {
    for (const p of resolveInstallPlan(catalog.packages, [id]).ordered) {
      if (!ids.has(p.id)) {
        ids.add(p.id);
        if (p.id !== id) added.push(p.name);
      }
    }
  } else {
    ids.delete(id);
    for (const p of catalog.packages) {
      if (ids.has(p.id) && resolveInstallPlan(catalog.packages, [p.id]).ordered.some(d => d.id === id)) {
        ids.delete(p.id);
        removed.push(p.name);
      }
    }
  }
  await setChecked(ids);
  return { added, removed };
}

async function onCheckboxes(items: readonly [Item, vscode.TreeItemCheckboxState][]) {
  const added: string[] = [];
  const removed: string[] = [];
  for (const [item, state] of items) {
    if (!item.pkg) continue;
    const r = await toggleSelection(item.pkg.id, state === vscode.TreeItemCheckboxState.Checked);
    added.push(...r.added);
    removed.push(...r.removed);
  }
  if (added.length) vscode.window.showInformationMessage(`ReejFastOrg: also selected the required package(s): ${added.join(', ')}.`);
  if (removed.length) vscode.window.showInformationMessage(`ReejFastOrg: also unselected the package(s) that need it: ${removed.join(', ')}.`);
}

async function installChecked() {
  const catalog = catalogQuiet().catalog;
  const ids = [...getChecked()].filter(id => catalog?.packages.some(p => p.id === id));
  if (!ids.length) {
    openPackages();
    vscode.window.showInformationMessage('ReejFastOrg: click the package tiles to choose what to install.');
    return;
  }
  await installPackages(undefined, ids);
}

/* ---------- catalog editing ---------- */

/** Catalog file to write to; offers to create the default one. */
async function catalogFileForWrite(): Promise<string | undefined> {
  const file = catalogPath();
  if (isBuiltIn(file)) return saveEditableCopy();
  if (file) return file;
  const pick = await vscode.window.showWarningMessage('ReejFastOrg: no catalog yet. Choose or create one first.', 'Choose Catalog…');
  if (pick) await chooseCatalog();
  return catalogPath();
}

async function addPackage() {
  const file = await catalogFileForWrite();
  if (!file) return;
  const existing = catalogQuiet().catalog?.packages ?? [];

  const link = await vscode.window.showInputBox({
    title: 'Add a package — 1/5 Install link or version Id',
    prompt: 'Paste the install link (…installPackage.apexp?p0=04t…) or the 04t package version Id',
    placeHolder: 'https://login.salesforce.com/packaging/installPackage.apexp?p0=04t…',
    ignoreFocusOut: true,
    validateInput: v => (parseVersionId(v) ? undefined : 'No 04t… version Id (15 or 18 characters) found in this text')
  });
  if (!link) return;
  const versionId = parseVersionId(link)!;
  const already = existing.find(p => p.versionId === versionId);
  if (already) {
    vscode.window.showWarningMessage(`ReejFastOrg: ${versionId} is already in the catalog as "${already.name}".`);
    return;
  }

  const name = await vscode.window.showInputBox({
    title: 'Add a package — 2/5 Name',
    prompt: 'Name shown in the list (e.g. "Datatable 4.3.7")',
    ignoreFocusOut: true,
    validateInput: v => (v.trim() ? undefined : 'Required')
  });
  if (!name) return;

  // Source = the tile group (Reej, UnofficialSF, …).
  const sources = [...new Set(existing.map(p => p.source?.trim()).filter((x): x is string => !!x))];
  const NEW = '$(add) New source…';
  const srcPick = await vscode.window.showQuickPick(
    [...sources.map(x => ({ label: x })), { label: NEW }],
    { title: 'Add a package — 3/5 Source (tiles are grouped by source)', placeHolder: 'Who publishes it?', ignoreFocusOut: true }
  );
  if (!srcPick) return;
  let source = srcPick.label;
  if (source === NEW) {
    const typed = await vscode.window.showInputBox({ title: 'New source', prompt: 'e.g. Reej, UnofficialSF, Salesforce Labs, AppExchange', ignoreFocusOut: true, validateInput: v => (v.trim() ? undefined : 'Required') });
    if (!typed) return;
    source = typed.trim();
  }

  let dependsOn: string[] = [];
  if (existing.length) {
    const deps = await vscode.window.showQuickPick(
      existing.map(p => ({ label: p.name, description: p.versionId, id: p.id })),
      { title: 'Add a package — 4/5 Packages that must be installed BEFORE it (leave empty if none)', canPickMany: true, ignoreFocusOut: true }
    );
    if (!deps) return;
    dependsOn = deps.map(d => d.id);
  }

  const key = await vscode.window.showQuickPick(
    [{ label: 'No installation key', requiresKey: false }, { label: 'Protected by an installation key (asked at install time)', requiresKey: true }],
    { title: 'Add a package — 5/5 Installation key', ignoreFocusOut: true }
  );
  if (!key) return;

  let id = slugify(name);
  while (existing.some(p => p.id === id)) id += '-2';
  const order = Math.max(0, ...existing.map(p => p.order ?? 0)) + 10;
  const pkg: CatalogPackage = { id, name: name.trim(), source, versionId, order, ...(dependsOn.length ? { dependsOn } : {}), ...(key.requiresKey ? { requiresKey: true } : {}) };
  upsertPackage(file, pkg);
  refreshAll();
  log(`Catalog: added ${pkg.name} (${versionId})${dependsOn.length ? ` after ${dependsOn.join(', ')}` : ''}`);
  const open = await vscode.window.showInformationMessage(
    `ReejFastOrg: "${pkg.name}" added to the catalog.`,
    'Open Catalog'
  );
  if (open) await vscode.window.showTextDocument(vscode.Uri.file(file));
}

async function removePackage(item?: Item) {
  const file = item?.pkg ? await catalogFileForWrite() : undefined;
  const catalog = catalogQuiet().catalog;
  if (!item?.pkg || !file || !catalog) return;
  const users = catalog.packages.filter(p => p.dependsOn?.includes(item.pkg!.id));
  if (users.length) {
    vscode.window.showWarningMessage(`ReejFastOrg: "${item.pkg.name}" is required by ${users.map(u => u.name).join(', ')}. Remove those first.`);
    return;
  }
  const ok = await vscode.window.showWarningMessage(`Remove "${item.pkg.name}" from the catalog? (Nothing is uninstalled from any org.)`, { modal: true }, 'Remove');
  if (!ok) return;
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(json) ? json : json.packages;
  const kept = list.filter((p: CatalogPackage) => p.id !== item.pkg!.id);
  fs.writeFileSync(file, JSON.stringify(Array.isArray(json) ? kept : { ...json, packages: kept }, null, 2) + '\n', 'utf8');
  const ids = getChecked();
  ids.delete(item.pkg.id);
  await setChecked(ids);
}

/** Pick (or create) the catalog file and remember it in the settings. */
async function chooseCatalog() {
  const how = await vscode.window.showQuickPick(
    [
      { label: '$(folder-opened) Use an existing catalog file…', create: false },
      { label: '$(new-file) Create a new catalog file…', create: true }
    ],
    { title: 'ReejFastOrg — Package catalog', ignoreFocusOut: true }
  );
  if (!how) return;
  let file: string | undefined;
  if (how.create) {
    const uri = await vscode.window.showSaveDialog({ filters: { 'Package catalog': ['json'] }, saveLabel: 'Create catalog' });
    if (!uri) return;
    file = uri.fsPath;
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ packages: [] }, null, 2) + '\n', 'utf8');
  } else {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Package catalog': ['json'] }, openLabel: 'Use this catalog' });
    if (!picked?.[0]) return;
    file = picked[0].fsPath;
    readCatalog(file); // validates, throws a readable error if it isn't a catalog
  }
  const scope = await vscode.window.showQuickPick(
    [
      { label: 'For all my workspaces', description: 'User settings', target: vscode.ConfigurationTarget.Global },
      { label: 'For this workspace only', description: 'Workspace settings', target: vscode.ConfigurationTarget.Workspace }
    ],
    { title: 'Remember this catalog…', ignoreFocusOut: true }
  );
  if (!scope) return;
  if (scope.target === vscode.ConfigurationTarget.Workspace && !workspaceDir()) {
    throw new Error('No folder is open: choose "For all my workspaces".');
  }
  await vscode.workspace.getConfiguration('reejFastOrg').update('catalogPath', file, scope.target);
  await context.workspaceState.update(CHECKED_KEY, undefined);
  refreshAll(true);
  vscode.window.showInformationMessage(`ReejFastOrg: using catalog ${file}`);
}

/* ---------- commands ---------- */

async function openCatalog() {
  const file = catalogPath();
  if (!file) {
    vscode.window.showWarningMessage('ReejFastOrg: open a folder first, or set reejFastOrg.catalogPath to an absolute path.');
    return;
  }
  if (!fs.existsSync(file)) {
    createSampleCatalog(file);
    refreshAll();
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  if (isBuiltIn(file)) {
    const copy = await vscode.window.showInformationMessage('ReejFastOrg: this is the built-in package list (read-only).', 'Save an Editable Copy…');
    if (copy) {
      const f = await saveEditableCopy();
      if (f) await vscode.window.showTextDocument(vscode.Uri.file(f));
    }
  }
}

async function connectOrg(): Promise<ConnectedOrg | undefined> {
  output.show(true);
  log('\n--- Connect to an org ---');
  const org = await pickOrConnectOrg({ cwd: workspaceDir(), log });
  if (!org) return undefined;
  await setOrg(org);
  refreshAll(true); // a new login changes the authenticated org list
  log(`Connected: ${org.target} — ${org.orgName ?? '?'} (${kindLabel(org.kind)}) ${org.instanceUrl ?? ''}`);
  vscode.window.showInformationMessage(`ReejFastOrg: using ${org.alias ?? org.username} (${kindLabel(org.kind)}).`);
  return org;
}

/** Sidebar: make an authenticated org the connected one. */
async function useOrg(item?: Item) {
  const o = item?.authOrg;
  if (!o) return connectOrg();
  const target = o.alias ?? o.username;
  const info = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `ReejFastOrg: checking ${target}…` },
    () => describeOrg(target, o.isScratch, { cwd: workspaceDir(), log })
  );
  const org: ConnectedOrg = { target, username: o.username, alias: o.alias, instanceUrl: info.instanceUrl ?? o.instanceUrl, orgName: info.orgName, kind: info.kind };
  await setOrg(org);
  log(`Connected: ${org.target} — ${org.orgName ?? '?'} (${kindLabel(org.kind)})`);
}

async function disconnectOrg() {
  await setOrg(undefined);
}

/** Opens the org (or one of its pages) in the browser. */
async function openOrg(item?: Item, pagePath?: string) {
  const target = item?.authOrg ? item.authOrg.alias ?? item.authOrg.username : getOrg()?.target;
  if (!target) return connectOrg();
  const args = ['org', 'open', '--target-org', target, '--url-only'];
  if (pagePath) args.push('--path', pagePath);
  const r = await sf<any>(args, { cwd: workspaceDir() });
  if (r?.url) await vscode.env.openExternal(vscode.Uri.parse(r.url));
}

/** Run setup: the package screen for the connected org (asks for an org only when none is connected). */
async function runSetup() {
  if (!getOrg() && !(await connectOrg())) return;
  openPackages();
}

function openPackages() {
  PackagesPanel.show({
    org: getOrg,
    catalog: catalogQuiet,
    checked: getChecked,
    toggle: async (id, on) => { await toggleSelection(id, on); },
    setChecked,
    installedVersionIds: org => getInstalledVersionIds(org, { cwd: workspaceDir() }),
    extensionUri: context.extensionUri
  });
}

/** Sidebar: install one package (plus its missing dependencies). */
async function installOnePackage(item?: Item) {
  if (!item?.pkg) return installPackages();
  await installPackages(undefined, [item.pkg.id]);
}

/**
 * Steps 2 and 3. `arg` is the catalog Uri when called from the explorer / editor menus.
 * `preselected` skips the picker (sidebar single-package install).
 */
async function installPackages(arg?: unknown, preselected?: string[]) {
  let org = getOrg();
  if (!org) {
    org = await connectOrg();
    if (!org) return;
  }

  const explicitFile = arg instanceof vscode.Uri ? arg.fsPath : undefined;
  const catalog = await loadCatalogInteractive(explicitFile);
  if (!catalog) return;

  let selectedIds = preselected;
  if (!selectedIds) {
    // 2/3 — choose packages
    const applicable = catalog.packages.filter(p => !p.orgTypes?.length || p.orgTypes.includes(org!.kind));
    const hidden = catalog.packages.length - applicable.length;
    if (!applicable.length) {
      vscode.window.showWarningMessage(`ReejFastOrg: no package in the catalog applies to a ${kindLabel(org.kind)} org.`);
      return;
    }
    const sorted = [...applicable].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
    const picks = await vscode.window.showQuickPick(
      sorted.map(p => ({
        label: p.name,
        description: [p.versionId, p.requiresKey ? '$(key)' : '', p.postInstall?.length ? `$(gear) ${p.postInstall.length} post-install` : '']
          .filter(Boolean).join('  '),
        detail: [p.description, p.dependsOn?.length ? `Requires: ${p.dependsOn.join(', ')}` : ''].filter(Boolean).join(' — ') || undefined,
        picked: !!p.default,
        id: p.id
      })),
      {
        title: `ReejFastOrg Setup — 2/3 Packages to install in ${org.alias ?? org.username}`,
        placeHolder: `Select packages${hidden ? ` (${hidden} hidden: not for ${kindLabel(org.kind)} orgs)` : ''}`,
        canPickMany: true,
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true
      }
    );
    if (!picks?.length) return;
    selectedIds = picks.map(p => p.id);
  }

  const { ordered, addedDeps } = resolveInstallPlan(catalog.packages, selectedIds);
  const notAllowed = ordered.filter(p => p.orgTypes?.length && !p.orgTypes.includes(org!.kind));
  if (notAllowed.length) {
    throw new Error(`Not allowed on ${kindLabel(org.kind)} orgs: ${notAllowed.map(p => p.name).join(', ')}`);
  }

  // Customer customization: company name, icon and colour, asked before the confirmation.
  const branding = new Map<string, BrandingInput>();
  for (const p of ordered.filter(p => p.kind === 'demoBranding')) {
    const input = await askBranding(p.name);
    if (!input) return;
    branding.set(p.id, input);
  }

  // 3/3 — confirm
  const planText = ordered
    .map((p, i) => {
      const b = branding.get(p.id);
      const extra = b
        ? ` — "${b.company}", ${b.color}, ${path.basename(b.iconPath)}`
        : p.postInstall?.length ? ` + ${p.postInstall.length} post-install step(s)` : '';
      return `${i + 1}. ${p.name}${addedDeps.includes(p) ? ' (dependency)' : ''}${extra}`;
    })
    .join('\n');
  const isProd = org.kind === 'prod';
  const access = settings().securityType === 'AllUsers' ? 'All users' : 'Admins only';
  const confirm = await vscode.window.showWarningMessage(
    `${isProd ? '⚠ PRODUCTION ORG ⚠\n' : ''}Install ${ordered.length} package(s) in ${org.alias ?? org.username}${org.orgName ? ` (${org.orgName})` : ''} — access: ${access}?`,
    { modal: true, detail: `${planText}\n\nAccess: ${access} (change it in the package screen or the reejFastOrg.securityType setting)` },
    isProd ? 'Install in Production' : 'Install'
  );
  if (!confirm) return;

  const keys = new Map<string, string>();
  for (const p of ordered.filter(p => p.requiresKey && !p.installationKey)) {
    const key = await vscode.window.showInputBox({
      title: `Installation key — ${p.name}`,
      password: true,
      ignoreFocusOut: true,
      validateInput: v => (v ? undefined : 'Required')
    });
    if (!key) return;
    keys.set(p.id, key);
  }

  output.show(true);
  let results: PackageResult[];
  const branded: BrandingResult[] = [];
  PackagesPanel.current?.startRun(ordered.map(p => p.id));
  try {
    results = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `ReejFastOrg → ${org.alias ?? org.username}`, cancellable: true },
      (progress, token) =>
        runInstallPlan(ordered, {
          org: org!, catalog, settings: settings(), keys, projectDir: workspaceDir(), progress, token, log,
          onStatus: (id, state, detail) => PackagesPanel.current?.setRun(id, state, detail),
          branding,
          onBranded: r => branded.push(r)
        })
    );
  } finally {
    sidebar.invalidateInstalled(org.target);
    PackagesPanel.current?.endRun();
  }

  await context.workspaceState.update(LAST_RUN_KEY, { when: new Date().toISOString(), org: org.alias ?? org.username, results } as LastRun);
  refreshAll();

  const summary = summarize(results);
  log(`\n=== Summary ===\n${summary}`);
  const failed = results.filter(r => r.status === 'failed').length;
  const done = results.filter(r => r.status === 'installed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const msg = `ReejFastOrg: ${done} installed, ${skipped} skipped, ${failed} failed.`;
  const action = await (failed ? vscode.window.showErrorMessage : vscode.window.showInformationMessage)(msg, 'Show Log');
  if (action) output.show();

  for (const b of branded) {
    const open = await vscode.window.showInformationMessage(
      `ReejFastOrg: theme "${b.themeLabel}" is deployed. Activate it in Setup → Themes and Branding to see the logo and colour.`,
      'Open Themes and Branding'
    );
    if (open) await openOrg(undefined, THEMES_SETUP_PATH);
  }
}

/** Company name, icon and brand colour for the Customer customization (last values are proposed again). */
async function askBranding(title: string): Promise<BrandingInput | undefined> {
  const last = context.workspaceState.get<Partial<BrandingInput>>(BRANDING_KEY) ?? {};
  const company = await vscode.window.showInputBox({
    title: `${title} — 1/3 Company name`,
    prompt: 'Used for the app names ("<Company> Sales", "<Company> Service Console"), the profile ("<Company> Standard User") and the theme ("<Company> Theme")',
    value: last.company ?? '',
    ignoreFocusOut: true,
    validateInput: v => (!v.trim() ? 'Required' : v.trim().length > 40 ? '40 characters max' : undefined)
  });
  if (!company) return undefined;

  const { width: W, height: H } = BRAND_IMAGE_SIZE;
  let iconPath: string | undefined;
  while (!iconPath) {
    const pick = await vscode.window.showOpenDialog({
      title: `${title} — 2/3 Brand Image (${W}x${H} pixels)`,
      openLabel: 'Use this brand image',
      canSelectMany: false,
      filters: { [`Brand Image (${W}x${H} pixels)`]: ICON_TYPES },
      defaultUri: last.iconPath && fs.existsSync(last.iconPath) ? vscode.Uri.file(path.dirname(last.iconPath)) : undefined
    });
    if (!pick?.[0]) return undefined;
    const file = pick[0].fsPath;
    if (fs.statSync(file).size > MAX_ICON_BYTES) {
      vscode.window.showErrorMessage('ReejFastOrg: the brand image is larger than 5 MB.');
      continue;
    }
    const size = imageSize(file);
    if (!size || size.width !== W || size.height !== H) {
      const found = size ? `${size.width}x${size.height} pixels` : 'of an unknown size';
      const choice = await vscode.window.showWarningMessage(
        `The brand image should be ${W}x${H} pixels; ${path.basename(file)} is ${found}. Salesforce will scale it, which can blur or crop it.`,
        { modal: true },
        'Use It Anyway',
        'Choose Another…'
      );
      if (choice === 'Use It Anyway') iconPath = file;
      else if (choice !== 'Choose Another…') return undefined;
      continue;
    }
    iconPath = file;
  }

  const color = await vscode.window.showInputBox({
    title: `${title} — 3/3 Brand colour`,
    prompt: 'Hex colour of the brand, e.g. #0070D2 (header, buttons, highlights)',
    value: last.color ?? '#0070D2',
    ignoreFocusOut: true,
    validateInput: v => (normalizeColor(v) ? undefined : 'Use a hex colour like #0070D2')
  });
  if (!color) return undefined;

  const input = { company: company.trim(), iconPath, color: normalizeColor(color)! };
  await context.workspaceState.update(BRANDING_KEY, input);
  return input;
}
