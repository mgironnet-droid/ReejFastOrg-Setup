import * as vscode from 'vscode';
import { sf, SfRunOptions } from './sfCli';
import { ConnectedOrg, OrgKind } from './types';

export interface AuthOrg {
  username: string;
  alias?: string;
  instanceUrl?: string;
  connectedStatus?: string;
  isScratch: boolean;
}

export async function listAuthenticatedOrgs(opts: SfRunOptions): Promise<AuthOrg[]> {
  const r = await sf<any>(['org', 'list'], opts);
  const map = (o: any, isScratch: boolean): AuthOrg => ({
    username: o.username,
    alias: o.alias,
    instanceUrl: o.instanceUrl,
    connectedStatus: o.connectedStatus ?? o.status,
    isScratch
  });
  const seen = new Set<string>();
  const all = [
    ...(r.nonScratchOrgs ?? []).map((o: any) => map(o, false)),
    ...(r.devHubs ?? []).map((o: any) => map(o, false)),
    ...(r.sandboxes ?? []).map((o: any) => map(o, false)),
    ...(r.scratchOrgs ?? []).map((o: any) => map(o, true))
  ];
  return all.filter(o => o.username && !seen.has(o.username) && seen.add(o.username));
}

export async function loginWeb(instanceUrl: string, alias: string | undefined, opts: SfRunOptions): Promise<string> {
  const args = ['org', 'login', 'web', '--instance-url', instanceUrl];
  if (alias) args.push('--alias', alias);
  const r = await sf<any>(args, opts);
  return r.username;
}

/** Queries the Organization record to tell dev / sandbox / prod apart. */
export async function describeOrg(target: string, isScratch: boolean, opts: SfRunOptions): Promise<{ orgName?: string; kind: OrgKind; instanceUrl?: string; username?: string }> {
  let orgName: string | undefined;
  let kind: OrgKind = 'unknown';
  try {
    const q = await sf<any>(
      ['data', 'query', '--query', 'SELECT Name, IsSandbox, OrganizationType, TrialExpirationDate FROM Organization LIMIT 1', '--target-org', target],
      opts
    );
    const rec = q.records?.[0];
    if (rec) {
      orgName = rec.Name;
      if (isScratch) kind = 'scratch';
      else if (rec.IsSandbox) kind = 'sandbox';
      else if (/developer edition/i.test(rec.OrganizationType ?? '')) kind = 'dev';
      else kind = 'prod';
    }
  } catch (e: any) {
    opts.log?.(`  Could not read Organization record: ${e.message}`);
  }
  let instanceUrl: string | undefined;
  let username: string | undefined;
  try {
    const d = await sf<any>(['org', 'display', '--target-org', target], opts);
    instanceUrl = d.instanceUrl;
    username = d.username;
  } catch {
    /* non-blocking */
  }
  return { orgName, kind, instanceUrl, username };
}

const NEW_LOGIN = '__new__';

/** Full interactive connect flow. Returns undefined if the user aborts. */
export async function pickOrConnectOrg(opts: SfRunOptions): Promise<ConnectedOrg | undefined> {
  const orgs = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ReejFastOrg: reading authenticated orgs…' },
    () => listAuthenticatedOrgs(opts)
  );

  type Item = vscode.QuickPickItem & { value: string; org?: AuthOrg };
  const items: Item[] = [
    { label: '$(add) Log in to a new org…', description: 'Developer, Sandbox, Production or custom domain', value: NEW_LOGIN },
    ...(orgs.length ? [{ label: 'Authenticated orgs', kind: vscode.QuickPickItemKind.Separator, value: '' } as Item] : []),
    ...orgs.map<Item>(o => ({
      label: `$(cloud) ${o.alias ?? o.username}`,
      description: o.alias ? o.username : undefined,
      detail: [o.instanceUrl, o.isScratch ? 'scratch' : undefined, o.connectedStatus && o.connectedStatus !== 'Connected' ? `⚠ ${o.connectedStatus}` : undefined]
        .filter(Boolean)
        .join(' · '),
      value: o.username,
      org: o
    }))
  ];

  const choice = await vscode.window.showQuickPick(items, {
    title: 'ReejFastOrg Setup — 1/3 Connect to an org',
    placeHolder: 'Pick an authenticated org or log in to a new one',
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true
  });
  if (!choice) return undefined;

  let target: string;
  let isScratch = false;

  if (choice.value === NEW_LOGIN) {
    const type = await vscode.window.showQuickPick(
      [
        { label: 'Developer Edition / Production', description: 'https://login.salesforce.com', url: 'https://login.salesforce.com' },
        { label: 'Sandbox', description: 'https://test.salesforce.com', url: 'https://test.salesforce.com' },
        { label: 'Custom domain (My Domain)…', description: 'e.g. https://acme--uat.sandbox.my.salesforce.com', url: '' }
      ],
      { title: 'Org type', placeHolder: 'Where should the browser login point?', ignoreFocusOut: true }
    );
    if (!type) return undefined;

    let url = type.url;
    if (!url) {
      const input = await vscode.window.showInputBox({
        title: 'My Domain URL',
        prompt: 'Full https URL of the org login domain',
        placeHolder: 'https://mycompany.my.salesforce.com',
        ignoreFocusOut: true,
        validateInput: v => (/^https:\/\/[^\s/]+\.[^\s/]+\/?$/.test(v.trim()) ? undefined : 'Enter a full https:// domain, without a path')
      });
      if (!input) return undefined;
      url = input.trim().replace(/\/$/, '');
    }

    const alias = await vscode.window.showInputBox({
      title: 'Alias for this org',
      prompt: 'Used later as --target-org (letters, digits, - and _)',
      placeHolder: 'e.g. client-uat',
      ignoreFocusOut: true,
      validateInput: v => (v && !/^[A-Za-z0-9_\-.]+$/.test(v) ? 'Use letters, digits, ".", "-" or "_" only' : undefined)
    });
    if (alias === undefined) return undefined;

    const username = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'ReejFastOrg: complete the login in your browser…', cancellable: true },
      (_p, token) => loginWeb(url, alias || undefined, { ...opts, token })
    );
    target = alias || username;
    vscode.window.showInformationMessage(`ReejFastOrg: logged in as ${username}.`);
  } else {
    target = choice.org!.alias ?? choice.org!.username;
    isScratch = choice.org!.isScratch;
  }

  const info = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `ReejFastOrg: checking ${target}…` },
    () => describeOrg(target, isScratch, opts)
  );

  return {
    target,
    username: info.username ?? (choice.org?.username ?? target),
    alias: choice.org?.alias ?? (target !== info.username ? target : undefined),
    instanceUrl: info.instanceUrl ?? choice.org?.instanceUrl,
    orgName: info.orgName,
    kind: info.kind
  };
}

export function kindLabel(kind: OrgKind): string {
  return { dev: 'Developer', sandbox: 'Sandbox', prod: 'PRODUCTION', scratch: 'Scratch', unknown: 'Unknown type' }[kind];
}
