// "ReejFastOrg — Packages": editor tab with one tile per package, grouped by source (Reej, UnofficialSF, …).
// Clicking a tile selects it (and the packages it needs); the bottom bar installs the selection in the connected org.
import * as vscode from 'vscode';
import { resolveInstallPlan } from './catalog';
import { RunState } from './installer';
import { kindLabel } from './orgs';
import { Catalog, CatalogPackage, ConnectedOrg } from './types';

export interface PanelDeps {
  org(): ConnectedOrg | undefined;
  catalog(): { catalog?: Catalog; error?: string; path?: string; builtIn?: boolean };
  checked(): Set<string>;
  /** Select / unselect a package, cascading to its dependencies / dependents. */
  toggle(id: string, on: boolean): Promise<void>;
  setChecked(ids: Set<string>): Promise<void>;
  installedVersionIds(org: ConnectedOrg): Promise<Set<string>>;
  extensionUri: vscode.Uri;
}

interface RunInfo { state: RunState; detail?: string }

const OTHER = 'Other';

export class PackagesPanel {
  static current?: PackagesPanel;

  private installed?: { target: string; ids: Set<string> };
  private installedError?: string;
  private loading = false;
  /** Incremented by every read of the org; an older read that finishes late is ignored. */
  private loadSeq = 0;
  private run = new Map<string, RunInfo>();
  private running = false;

  static show(deps: PanelDeps) {
    if (PackagesPanel.current) {
      PackagesPanel.current.panel.reveal(vscode.ViewColumn.One);
      PackagesPanel.current.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel('reejFastOrg.packages', 'ReejFastOrg — Packages', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'media')]
    });
    panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'media', 'icon.png');
    PackagesPanel.current = new PackagesPanel(panel, deps);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly deps: PanelDeps) {
    panel.webview.html = this.html();
    panel.onDidDispose(() => {
      if (PackagesPanel.current === this) PackagesPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    this.refresh();
  }

  /** Redraw; force = re-read the installed packages of the org. */
  refresh(force = false) {
    if (force) {
      this.installed = undefined;
      // Results of the last run ("Installed now", "Already installed", "Failed") are history: after a refresh the
      // tiles show only what the org reports (e.g. once a package has been uninstalled).
      if (!this.running) this.run.clear();
    }
    this.post();
    const org = this.deps.org();
    if (org && (force || (!this.loading && (!this.installed || this.installed.target !== org.target)))) {
      const seq = ++this.loadSeq;
      this.loading = true;
      this.installedError = undefined;
      this.post();
      this.deps
        .installedVersionIds(org)
        .then(ids => {
          if (seq === this.loadSeq) this.installed = { target: org.target, ids };
        })
        .catch(e => {
          if (seq === this.loadSeq) this.installedError = e.message;
        })
        .finally(() => {
          if (seq !== this.loadSeq) return;
          this.loading = false;
          this.post();
        });
    }
  }

  /* ----- install run (driven by the extension) ----- */

  startRun(ids: string[]) {
    this.run.clear();
    ids.forEach(id => this.run.set(id, { state: 'queued' }));
    this.running = true;
    this.post();
  }

  setRun(id: string, state: RunState, detail?: string) {
    this.run.set(id, { state, detail });
    this.post();
  }

  endRun() {
    for (const [id, r] of this.run) if (r.state === 'queued' || r.state === 'installing' || r.state === 'postInstall') this.run.delete(id);
    this.running = false;
    const results = new Map(this.run);
    this.refresh(true); // re-read the org…
    results.forEach((r, id) => this.run.set(id, r)); // …but keep showing this run's results until the next refresh
    this.post();
  }

  /* ----- webview ----- */

  private async onMessage(m: any) {
    try {
      switch (m?.type) {
        case 'toggle':
          if (!this.running) await this.deps.toggle(String(m.id), !!m.on);
          break;
        case 'group': {
          if (this.running) break;
          const cat = this.deps.catalog().catalog;
          if (!cat) break;
          const org = this.deps.org();
          const ids = this.deps.checked();
          const inOrg = org && this.installed?.target === org.target ? this.installed.ids : new Set<string>();
          const members = cat.packages.filter(p => (p.source || OTHER) === m.source && allowed(p, org) && !inOrg.has(p.versionId));
          if (m.on) {
            const plan = resolveInstallPlan(cat.packages, members.map(p => p.id)).ordered;
            plan.filter(p => allowed(p, org)).forEach(p => ids.add(p.id));
            await this.deps.setChecked(ids);
          } else {
            for (const p of members) await this.deps.toggle(p.id, false);
          }
          break;
        }
        case 'clear':
          if (!this.running) await this.deps.setChecked(new Set());
          break;
        case 'install':
          await vscode.commands.executeCommand('reejFastOrg.installChecked');
          break;
        case 'installOne': {
          const pkg = this.deps.catalog().catalog?.packages.find(p => p.id === m.id);
          if (pkg) await vscode.commands.executeCommand('reejFastOrg.installPackage', { pkg });
          break;
        }
        case 'openUrl':
          if (/^https:\/\//.test(String(m.url))) await vscode.env.openExternal(vscode.Uri.parse(String(m.url)));
          break;
        case 'command':
          if (/^reejFastOrg\.[A-Za-z]+$/.test(String(m.command))) await vscode.commands.executeCommand(String(m.command));
          break;
        case 'refresh':
          await vscode.commands.executeCommand('reejFastOrg.refresh'); // sidebar + this screen
          break;
        case 'security':
          if (!this.running && (m.value === 'AdminsOnly' || m.value === 'AllUsers')) {
            await vscode.workspace.getConfiguration('reejFastOrg').update('securityType', m.value, vscode.ConfigurationTarget.Global);
            this.post();
          }
          break;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`ReejFastOrg: ${e.message}`);
    }
  }

  private post() {
    void this.panel.webview.postMessage({ type: 'state', state: this.state() });
  }

  private state() {
    const org = this.deps.org();
    const { catalog, error, path, builtIn } = this.deps.catalog();
    const checked = this.deps.checked();
    const installed = org && this.installed?.target === org.target ? this.installed.ids : undefined;
    const pkgs = catalog?.packages ?? [];
    const byId = new Map(pkgs.map(p => [p.id, p]));

    let plan: { id: string; name: string; dep: boolean; skip: boolean }[] = [];
    let planError: string | undefined;
    // Packages already in the org are shown ticked but are not part of the selection to install.
    const selected = [...checked].filter(id => byId.has(id) && !installed?.has(byId.get(id)!.versionId));
    if (selected.length) {
      try {
        const r = resolveInstallPlan(pkgs, selected);
        plan = r.ordered.map(p => ({ id: p.id, name: p.name, dep: !checked.has(p.id), skip: !!installed?.has(p.versionId) }));
      } catch (e: any) {
        planError = e.message;
      }
    }

    // Groups in the order of their first package (catalog "order", then position).
    const sorted = [...pkgs].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
    const groups = new Map<string, any[]>();
    for (const p of sorted) {
      const src = p.source?.trim() || OTHER;
      if (!groups.has(src)) groups.set(src, []);
      const dependents = pkgs.filter(o => o.dependsOn?.includes(p.id)).map(o => o.name);
      groups.get(src)!.push({
        id: p.id,
        name: p.name,
        description: p.description ?? '',
        versionId: p.versionId,
        addon: p.kind === 'demoBranding',
        url: p.url,
        needs: (p.dependsOn ?? []).map(d => byId.get(d)?.name ?? d),
        neededBy: dependents,
        requiresKey: !!p.requiresKey && !p.installationKey,
        postInstall: (p.postInstall ?? []).map(s => s.label ?? s.type),
        allowed: allowed(p, org),
        orgTypes: p.orgTypes ?? [],
        installed: installed ? installed.has(p.versionId) : null,
        checked: checked.has(p.id) && !installed?.has(p.versionId),
        run: this.run.get(p.id) ?? null
      });
    }

    return {
      org: org
        ? { name: org.alias ?? org.username, username: org.username, orgName: org.orgName ?? '', kind: org.kind, kindLabel: kindLabel(org.kind), url: org.instanceUrl ?? '' }
        : null,
      catalog: { builtIn: !!builtIn, path: path ?? '', error: error ?? '', count: pkgs.length },
      groups: [...groups.entries()].map(([source, items]) => ({ source, items })),
      plan,
      planError: planError ?? '',
      loadingInstalled: this.loading,
      installedError: this.installedError ?? '',
      running: this.running,
      securityType: vscode.workspace.getConfiguration('reejFastOrg').get<string>('securityType', 'AdminsOnly')
    };
  }

  private html(): string {
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    const csp = `default-src 'none'; img-src ${this.panel.webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ReejFastOrg — Packages</title>
<style>
  :root {
    --gap: 14px;
    --radius: 8px;
    --border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,.35)));
    --card: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    --muted: var(--vscode-descriptionForeground);
    --ok: var(--vscode-testing-iconPassed, #3fb950);
    --bad: var(--vscode-testing-iconFailed, #f85149);
    --warn: var(--vscode-editorWarning-foreground, #d29922);
    --accent: var(--vscode-focusBorder, #0e70c0);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 0 96px;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
  }
  button {
    font: inherit; cursor: pointer; border-radius: 4px; padding: 5px 12px;
    border: 1px solid transparent;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 2px 4px; }
  button.link:hover { text-decoration: underline; background: none; }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, .tile:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }

  header {
    position: sticky; top: 0; z-index: 2;
    display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
    padding: 14px 24px; background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--border);
  }
  .org { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
  .org-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--ok); flex: none; }
  .org.prod .org-dot { background: var(--warn); }
  .org.none .org-dot { background: var(--muted); }
  .org-name { font-weight: 600; font-size: 1.15em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kind { font-size: .8em; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .org.prod .kind { color: var(--warn); border-color: var(--warn); font-weight: 600; }
  .org-sub { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tools { display: flex; gap: 6px; flex-wrap: wrap; }

  main { padding: 8px 24px; max-width: 1400px; }
  .notice { margin: 14px 0 0; padding: 10px 12px; border-radius: var(--radius); border: 1px solid var(--border); color: var(--muted); }
  .notice.error { color: var(--bad); border-color: var(--bad); }

  section { margin-top: 22px; }
  .group-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
  .group-head h2 { margin: 0; font-size: 1.05em; font-weight: 600; letter-spacing: .02em; }
  .group-head .count { color: var(--muted); }
  .group-head .spacer { flex: 1; }
  .swatch { width: 4px; height: 16px; border-radius: 2px; align-self: center; }

  .grid { display: grid; gap: var(--gap); grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr)); }
  .tile {
    position: relative; display: flex; flex-direction: column; gap: 8px;
    padding: 14px 14px 12px; border-radius: var(--radius);
    background: var(--card); border: 1px solid var(--border);
    cursor: pointer; user-select: none; transition: border-color .12s, background .12s;
  }
  .tile::before {
    content: ''; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 0 3px 3px 0;
    background: var(--swatch, var(--accent)); opacity: .9;
  }
  .tile:hover { border-color: var(--vscode-list-hoverForeground, var(--accent)); }
  .tile.checked { border-color: var(--accent); background: var(--vscode-list-inactiveSelectionBackground, var(--card)); }
  .tile.blocked { cursor: not-allowed; opacity: .55; }
  .tile.installed {
    cursor: default;
    border-color: color-mix(in srgb, var(--ok) 45%, var(--border));
    background: color-mix(in srgb, var(--ok) 9%, var(--card));
  }
  .tile.installed:hover { border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
  .tile.installed .box { background: var(--ok); border-color: var(--ok); }
  .tile.installed .box::after { content: ''; width: 9px; height: 5px; border: 2px solid #fff; border-top: 0; border-right: 0; transform: translateY(-1px) rotate(-45deg); }
  .tile.locked { cursor: progress; }
  .top { display: flex; gap: 10px; align-items: flex-start; }
  .box {
    flex: none; width: 18px; height: 18px; margin-top: 1px; border-radius: 4px;
    border: 1px solid var(--vscode-checkbox-border, var(--border)); background: var(--vscode-checkbox-background, transparent);
    display: grid; place-items: center;
  }
  .tile.checked .box { background: var(--accent); border-color: var(--accent); }
  .tile.checked .box::after { content: ''; width: 9px; height: 5px; border: 2px solid #fff; border-top: 0; border-right: 0; transform: translateY(-1px) rotate(-45deg); }
  .title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .name { font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
  .vid { font-family: var(--vscode-editor-font-family); font-size: .85em; color: var(--muted); }
  .desc { color: var(--muted); line-height: 1.4; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; }
  .chip { font-size: .8em; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--border); color: var(--muted); max-width: 100%; overflow-wrap: anywhere; }
  .chip.needs { border-style: dashed; }
  .status { display: inline-flex; align-items: center; gap: 5px; font-size: .85em; font-weight: 600; white-space: nowrap; }
  .status.installed { color: var(--ok); }
  .status.failed { color: var(--bad); }
  .status.busy { color: var(--accent); }
  .status.muted { color: var(--muted); font-weight: 400; }
  .spin { width: 10px; height: 10px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .detail { font-size: .85em; color: var(--bad); word-break: break-word; }
  .detail.ok { color: var(--muted); }
  .foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 24px; }
  .foot .spacer { flex: 1; }
  .foot button { padding: 2px 8px; font-size: .9em; }

  .bar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 3;
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 12px 24px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-top: 1px solid var(--border); box-shadow: 0 -4px 12px rgba(0,0,0,.15);
  }
  .plan { flex: 1; min-width: 200px; color: var(--muted); line-height: 1.5; }
  .access { display: flex; align-items: center; gap: 8px; }
  .access-label { color: var(--muted); }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; }
  .seg button { border-radius: 0; border: 0; background: transparent; color: var(--muted); padding: 5px 10px; }
  .seg button + button { border-left: 1px solid var(--border); }
  .seg button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); color: var(--vscode-foreground); }
  .seg button[aria-checked="true"] { background: var(--vscode-button-secondaryBackground); color: var(--vscode-foreground); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
  .plan b { color: var(--vscode-foreground); }
  .plan .step { white-space: nowrap; }
  .plan .step.dep { font-style: italic; }
  .plan .step.skip { text-decoration: line-through; }
  .empty { padding: 48px 0; text-align: center; color: var(--muted); }
</style>
</head>
<body>
<header>
  <div id="org" class="org none"></div>
  <div class="tools">
    <button data-cmd="reejFastOrg.connectOrg" title="Connect or switch org">Change org</button>
    <button data-cmd="reejFastOrg.openOrg" id="openOrg" title="Open the org in the browser">Open org</button>
    <button data-cmd="reejFastOrg.addPackage" title="Add a package to the catalog">+ Add package</button>
    <button data-cmd="reejFastOrg.openCatalog" title="Open the catalog JSON">Catalog</button>
    <button id="refresh" title="Re-read the packages installed in the org">Refresh</button>
  </div>
</header>
<main id="main"></main>
<div class="bar">
  <div class="plan" id="plan"></div>
  <div class="access" role="radiogroup" aria-label="Who gets access to the installed packages">
    <span class="access-label">Access</span>
    <div class="seg">
      <button role="radio" data-sec="AdminsOnly" title="Install for admins only (--security-type AdminsOnly)">Admins only</button>
      <button role="radio" data-sec="AllUsers" title="Install for all users (--security-type AllUsers)">All users</button>
    </div>
  </div>
  <button id="clear">Clear</button>
  <button id="install" class="primary">Install</button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PALETTE = ['--vscode-charts-blue', '--vscode-charts-orange', '--vscode-charts-purple', '--vscode-charts-green', '--vscode-charts-yellow', '--vscode-charts-red'];
  const swatch = (src, i) => src === 'Reej' ? 'var(--vscode-charts-blue, #3794ff)' : 'var(' + PALETTE[(i + 1) % PALETTE.length] + ', #888)';
  let S = null;

  document.querySelectorAll('[data-cmd]').forEach(b => b.addEventListener('click', () => vscode.postMessage({ type: 'command', command: b.dataset.cmd })));
  $('#refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('#install').addEventListener('click', () => vscode.postMessage({ type: 'install' }));
  $('#clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));

  window.addEventListener('message', e => { if (e.data?.type === 'state') { S = e.data.state; render(); } });

  function statusHtml(p) {
    const r = p.run;
    if (r) {
      if (r.state === 'queued') return '<span class="status muted">Queued</span>';
      if (r.state === 'installing') return '<span class="status busy"><span class="spin"></span>' + (p.addon ? 'Applying…' : 'Installing…') + '</span>';
      if (r.state === 'postInstall') return '<span class="status busy"><span class="spin"></span>' + (p.addon ? 'Applying…' : 'Post-install…') + '</span>';
      if (r.state === 'installed') return '<span class="status installed">✓ ' + (p.addon ? 'Applied' : 'Installed now') + '</span>';
      if (r.state === 'skipped') return '<span class="status installed">✓ Already installed</span>';
      if (r.state === 'failed') return '<span class="status failed">✕ Failed</span>';
    }
    if (!p.allowed) return '<span class="status muted">Not for this org type</span>';
    if (p.installed === true) return '<span class="status installed">✓ Installed</span>';
    if (p.addon) return '<span class="status muted">Asks for name, icon and colour</span>';
    if (p.installed === false) return '<span class="status muted">Not installed</span>';
    return '';
  }

  function tile(p, color) {
    const locked = S.running;
    const inOrg = p.installed === true || (p.run && (p.run.state === 'installed' || p.run.state === 'skipped'));
    const cls = ['tile', inOrg ? 'installed' : p.checked ? 'checked' : '', !p.allowed && !inOrg ? 'blocked' : '', locked ? 'locked' : ''].join(' ');
    const chips = [];
    if (p.needs.length) chips.push('<span class="chip needs" title="Installed before it">after ' + esc(p.needs.join(', ')) + '</span>');
    if (p.requiresKey) chips.push('<span class="chip" title="An installation key will be asked">🔑 key</span>');
    if (p.postInstall.length) chips.push('<span class="chip" title="' + esc(p.postInstall.join('\\n')) + '">⚙ ' + p.postInstall.length + ' post-install</span>');
    if (!p.allowed && p.orgTypes.length) chips.push('<span class="chip">only ' + esc(p.orgTypes.join(', ')) + '</span>');
    const r = p.run;
    const detail = r && r.detail ? '<div class="detail ' + (r.state === 'failed' ? '' : 'ok') + '">' + esc(r.detail) + '</div>' : '';
    const tip = inOrg ? 'Already installed in this org' : p.allowed ? (p.checked ? 'Click to unselect' : 'Click to select') + (p.neededBy.length ? ' — needed by ' + p.neededBy.join(', ') : '') : 'Not allowed on this org type';
    const active = p.allowed && !inOrg;
    return '<div class="' + cls + '" style="--swatch:' + color + '" role="checkbox" tabindex="' + (active ? 0 : -1) + '" aria-checked="' + (inOrg || p.checked) + '" aria-disabled="' + (!active || locked) + '" data-id="' + esc(p.id) + '" title="' + esc(tip) + '">' +
      '<div class="top"><span class="box"></span><div class="title"><div class="name">' + esc(p.name) + '</div><div class="vid">' + (p.addon ? 'Customer customization · no package' : esc(p.versionId)) + '</div></div></div>' +
      (p.description ? '<div class="desc">' + esc(p.description) + '</div>' : '') +
      (chips.length ? '<div class="chips">' + chips.join('') + '</div>' : '') +
      detail +
      '<div class="foot">' + statusHtml(p) + '<span class="spacer"></span>' +
        (p.url ? '<button class="link" data-url="' + esc(p.url) + '" title="Open documentation">Docs</button>' : '') +
        (active && !locked && S.org ? '<button data-one="' + esc(p.id) + '" title="' + (p.addon ? 'Apply the branding (and install what it needs)' : 'Install only this package (and what it needs)') + '">' + (p.addon ? 'Apply' : 'Install') + '</button>' : '') +
      '</div>' +
    '</div>';
  }

  function render() {
    // Org header
    const o = S.org;
    const org = $('#org');
    org.className = 'org ' + (o ? (o.kind === 'prod' ? 'prod' : '') : 'none');
    org.innerHTML = o
      ? '<span class="org-dot"></span><span class="org-name" title="' + esc(o.username) + '">' + esc(o.name) + '</span><span class="kind">' + esc(o.kindLabel) + '</span><span class="org-sub">' + esc(o.orgName) + (o.url ? ' · ' + esc(o.url.replace(/^https:\\/\\//, '')) : '') + '</span>'
      : '<span class="org-dot"></span><span class="org-name">No org connected</span><span class="org-sub">Choose the org to install into</span>';
    $('#openOrg').disabled = !o;

    // Groups
    const main = $('#main');
    let html = '';
    if (!o) html += '<div class="notice">Connect an org first (Change org) — the tiles will then show what is already installed in it.</div>';
    if (S.catalog.error) html += '<div class="notice error">Catalog error: ' + esc(S.catalog.error) + '</div>';
    if (S.installedError) html += '<div class="notice error">Could not read the installed packages: ' + esc(S.installedError) + '</div>';
    else if (S.loadingInstalled) html += '<div class="notice">Reading the packages installed in ' + esc(o ? o.name : '') + '…</div>';
    if (!S.groups.length && !S.catalog.error) html += '<div class="empty">No package in the catalog yet.<br><br><button class="primary" data-cmd2="reejFastOrg.addPackage">+ Add package</button></div>';
    S.groups.forEach((g, i) => {
      const color = swatch(g.source, i);
      const selectable = g.items.filter(p => p.allowed && p.installed !== true);
      const all = selectable.length && selectable.every(p => p.checked);
      html += '<section><div class="group-head"><span class="swatch" style="background:' + color + '"></span><h2>' + esc(g.source) + '</h2>' +
        '<span class="count">' + g.items.length + ' package' + (g.items.length > 1 ? 's' : '') + '</span><span class="spacer"></span>' +
        (selectable.length && !S.running ? '<button class="link" data-group="' + esc(g.source) + '" data-on="' + (!all) + '">' + (all ? 'Unselect all' : 'Select all') + '</button>' : '') +
        '</div><div class="grid">' + g.items.map(p => tile(p, color)).join('') + '</div></section>';
    });
    main.innerHTML = html;

    // Bottom bar
    const plan = S.plan;
    const toInstall = plan.filter(p => !p.skip);
    if (S.planError) $('#plan').innerHTML = '<span style="color:var(--bad)">' + esc(S.planError) + '</span>';
    else if (!plan.length) $('#plan').innerHTML = 'Click the tiles to choose what to install' + (o ? ' in <b>' + esc(o.name) + '</b>' : '') + '. Required packages are added automatically.';
    else $('#plan').innerHTML = '<b>Install order:</b> ' + plan.map((p, i) => '<span class="step' + (p.dep ? ' dep' : '') + (p.skip ? ' skip' : '') + '" title="' + (p.skip ? 'already installed — skipped' : p.dep ? 'added because another package needs it' : '') + '">' + (i + 1) + '. ' + esc(p.name) + '</span>').join(' → ');
    const btn = $('#install');
    btn.textContent = S.running ? 'Installing…' : toInstall.length ? 'Install ' + toInstall.length + ' package' + (toInstall.length > 1 ? 's' : '') + (o ? ' in ' + o.name : '') : 'Install';
    btn.disabled = S.running || !toInstall.length || !o;
    $('#clear').disabled = S.running || !plan.length;
    document.querySelectorAll('[data-sec]').forEach(b => {
      b.setAttribute('aria-checked', String(b.dataset.sec === S.securityType));
      b.disabled = S.running;
    });
  }

  // Event delegation: tiles, per-tile buttons, group toggles.
  document.addEventListener('click', e => {
    const t = e.target.closest('button, .tile');
    if (!t || !S) return;
    if (t.dataset.one) { vscode.postMessage({ type: 'installOne', id: t.dataset.one }); return; }
    if (t.dataset.url) { vscode.postMessage({ type: 'openUrl', url: t.dataset.url }); return; }
    if (t.dataset.group) { vscode.postMessage({ type: 'group', source: t.dataset.group, on: t.dataset.on === 'true' }); return; }
    if (t.dataset.cmd2) { vscode.postMessage({ type: 'command', command: t.dataset.cmd2 }); return; }
    if (t.dataset.sec) { if (!S.running) vscode.postMessage({ type: 'security', value: t.dataset.sec }); return; }
    if (t.classList.contains('tile')) toggle(t);
  });
  document.addEventListener('keydown', e => {
    const t = e.target;
    if (t.classList?.contains('tile') && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggle(t); }
  });
  function toggle(t) {
    if (S.running || t.classList.contains('blocked') || t.classList.contains('installed')) return;
    vscode.postMessage({ type: 'toggle', id: t.dataset.id, on: !t.classList.contains('checked') });
  }
</script>
</body>
</html>`;
  }
}

function allowed(p: CatalogPackage, org?: ConnectedOrg): boolean {
  return !org || !p.orgTypes?.length || p.orgTypes.includes(org.kind);
}
