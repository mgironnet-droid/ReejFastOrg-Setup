import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { applyDemoBranding, BrandingInput, BrandingResult } from './branding';
import { CancelledError, sf, SfRunOptions } from './sfCli';
import { Catalog, CatalogPackage, ConnectedOrg, PackageResult, PostInstallStep } from './types';

export interface InstallSettings {
  waitMinutes: number;
  securityType: 'AdminsOnly' | 'AllUsers';
  skipAlreadyInstalled: boolean;
  stopOnError: boolean;
}

export interface InstallContext {
  org: ConnectedOrg;
  catalog: Catalog;
  settings: InstallSettings;
  /** Installation keys typed by the user, by package id. */
  keys: Map<string, string>;
  projectDir?: string;
  progress: vscode.Progress<{ message?: string; increment?: number }>;
  token: vscode.CancellationToken;
  log: (line: string) => void;
  /** Company name / icon / colour typed by the user, by Customer customization id. */
  branding?: Map<string, BrandingInput>;
  /** Called after a Customer customization was deployed. */
  onBranded?: (r: BrandingResult) => void;
  /** Live status per package (for the package screen). */
  onStatus?: (id: string, state: RunState, detail?: string) => void;
}

export type RunState = 'queued' | 'installing' | 'postInstall' | 'installed' | 'skipped' | 'failed';

function sleep(ms: number, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sub.dispose();
      resolve();
    }, ms);
    const sub = token.onCancellationRequested(() => {
      clearTimeout(t);
      sub.dispose();
      reject(new CancelledError());
    });
  });
}

export async function getInstalledVersionIds(org: ConnectedOrg, opts: SfRunOptions): Promise<Set<string>> {
  try {
    const r = await sf<any[]>(['package', 'installed', 'list', '--target-org', org.target], opts);
    return new Set((r ?? []).map(p => p.SubscriberPackageVersionId).filter(Boolean));
  } catch (e: any) {
    opts.log?.(`  Could not list installed packages (${e.message}); nothing will be skipped.`);
    return new Set();
  }
}

function errorsOf(result: any): string {
  const errs = result?.Errors?.errors ?? result?.Errors ?? [];
  if (Array.isArray(errs) && errs.length) return errs.map((e: any) => e.message ?? String(e)).join('\n');
  return result?.Status ? `Install request ended with status ${result.Status}` : 'Unknown install error';
}

async function installOne(pkg: CatalogPackage, ctx: InstallContext): Promise<void> {
  const key = ctx.keys.get(pkg.id) ?? pkg.installationKey;
  const args = [
    'package', 'install',
    '--package', pkg.versionId,
    '--target-org', ctx.org.target,
    '--wait', String(ctx.settings.waitMinutes),
    '--publish-wait', '10',
    '--security-type', ctx.settings.securityType,
    '--no-prompt'
  ];
  if (key) args.push('--installation-key', key);

  const opts: SfRunOptions = { cwd: ctx.projectDir, token: ctx.token, log: ctx.log, secrets: key ? [key] : [] };
  let result = await sf<any>(args, opts);

  // The CLI wait expired: keep polling the request until it ends.
  while (result?.Status && !['SUCCESS', 'ERROR'].includes(result.Status)) {
    if (!result.Id) throw new Error(`Install still ${result.Status} and no request Id was returned.`);
    ctx.progress.report({ message: `${pkg.name}: ${result.Status.toLowerCase().replace('_', ' ')}…` });
    await sleep(15000, ctx.token);
    result = await sf<any>(['package', 'install', 'report', '--request-id', result.Id, '--target-org', ctx.org.target], { ...opts, log: undefined });
  }
  if (result?.Status === 'ERROR') throw new Error(errorsOf(result));
}

/** Nearest folder at or above `dir` that holds an sfdx-project.json. */
export function findSfdxProject(dir: string): string | undefined {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, 'sfdx-project.json'))) return d;
    const up = path.dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

function stepLabel(step: PostInstallStep): string {
  if (step.label) return step.label;
  switch (step.type) {
    case 'permset': return `Assign permission set ${[step.name].flat().join(', ')}`;
    case 'apex': return `Run Apex ${step.file}`;
    case 'dataTree': return `Import data ${step.plan}`;
    case 'deploy': return `Deploy ${step.path}`;
    case 'sf': return `sf ${step.args.join(' ')}`;
  }
}

async function runStep(step: PostInstallStep, ctx: InstallContext): Promise<void> {
  const org = ctx.org.target;
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(ctx.catalog.baseDir, p));
  const opts: SfRunOptions = { cwd: ctx.projectDir ?? ctx.catalog.baseDir, token: ctx.token, log: ctx.log };

  switch (step.type) {
    case 'permset': {
      const args = ['org', 'assign', 'permset', '--target-org', org];
      [step.name].flat().forEach(n => args.push('--name', n));
      await sf(args, opts);
      return;
    }
    case 'apex': {
      const r = await sf<any>(['apex', 'run', '--file', abs(step.file), '--target-org', org], opts);
      if (r && (r.compiled === false || r.success === false)) {
        throw new Error(r.compileProblem || r.exceptionMessage || 'Anonymous Apex failed');
      }
      return;
    }
    case 'dataTree':
      await sf(['data', 'import', 'tree', '--plan', abs(step.plan), '--target-org', org], opts);
      return;
    case 'deploy': {
      const dir = abs(step.path);
      if (!fs.existsSync(dir)) throw new Error(`Folder not found: ${dir}`);
      const project = step.project ? abs(step.project) : findSfdxProject(dir);
      if (!project) throw new Error(`No sfdx-project.json found above ${dir} (set "project" on the step)`);
      await sf(['project', 'deploy', 'start', '--source-dir', dir, '--target-org', org, '--wait', '30'], { ...opts, cwd: project });
      return;
    }
    case 'sf': {
      const args = step.args.map(a => a.replace(/\$\{org\}/g, org).replace(/\$\{catalogDir\}/g, ctx.catalog.baseDir));
      await sf(args, opts);
      return;
    }
  }
}

export async function runInstallPlan(plan: CatalogPackage[], ctx: InstallContext): Promise<PackageResult[]> {
  const results: PackageResult[] = plan.map(pkg => ({ pkg, status: 'not run', steps: [] }));
  const step = 100 / plan.length;

  ctx.log(`\n=== Installing ${plan.length} package(s) in ${ctx.org.target} (${ctx.org.kind}), access: ${ctx.settings.securityType} ===`);
  const installed = ctx.settings.skipAlreadyInstalled
    ? await getInstalledVersionIds(ctx.org, { token: ctx.token, log: ctx.log })
    : new Set<string>();

  for (let i = 0; i < plan.length; i++) {
    const pkg = plan[i];
    const res = results[i];
    const prefix = `[${i + 1}/${plan.length}] ${pkg.name}`;

    if (pkg.kind === 'demoBranding') {
      ctx.log(`\n${prefix} — demo branding`);
      ctx.progress.report({ message: `${prefix}: branding…` });
      ctx.onStatus?.(pkg.id, 'installing');
      try {
        const input = ctx.branding?.get(pkg.id);
        if (!input) throw new Error('No company name / icon / colour given');
        const r = await applyDemoBranding(ctx.org, input, pkg.branding ?? {}, {
          cwd: ctx.projectDir, token: ctx.token, log: ctx.log,
          onStep: label => ctx.onStatus?.(pkg.id, 'postInstall', label)
        });
        res.status = 'installed';
        r.apps.forEach(a => res.steps.push({ label: `App ${a.name} renamed "${a.label}"`, status: 'ok' }));
        r.profiles.forEach(p => res.steps.push({ label: p.message, status: p.status === 'skipped' ? 'skipped' : 'ok' }));
        res.steps.push({ label: `Theme "${r.themeLabel}" deployed (activate it in Setup → Themes and Branding)`, status: 'ok' });
        ctx.log(`  ✔ branding deployed`);
        ctx.onStatus?.(pkg.id, 'installed', `Theme "${r.themeLabel}" deployed — activate it in Setup`);
        ctx.onBranded?.(r);
      } catch (e: any) {
        if (e instanceof CancelledError) {
          ctx.onStatus?.(pkg.id, 'failed', 'Cancelled');
          throw e;
        }
        res.status = 'failed';
        res.error = e.message;
        ctx.log(`  ✖ ${String(e.message).replace(/\n/g, '\n    ')}`);
        ctx.onStatus?.(pkg.id, 'failed', e.message);
        if (ctx.settings.stopOnError) break;
      }
      ctx.progress.report({ increment: step });
      continue;
    }

    if (installed.has(pkg.versionId)) {
      ctx.log(`\n${prefix} — already installed (${pkg.versionId}), skipped.`);
      res.status = 'skipped';
      ctx.onStatus?.(pkg.id, 'skipped');
      ctx.progress.report({ increment: step });
      continue;
    }

    ctx.log(`\n${prefix} — installing ${pkg.versionId}`);
    ctx.progress.report({ message: `${prefix}: installing…` });
    ctx.onStatus?.(pkg.id, 'installing');
    try {
      await installOne(pkg, ctx);
      res.status = 'installed';
      ctx.log(`  ✔ installed`);
    } catch (e: any) {
      if (e instanceof CancelledError) {
        ctx.onStatus?.(pkg.id, 'failed', 'Cancelled');
        throw e;
      }
      res.status = 'failed';
      res.error = e.message;
      ctx.onStatus?.(pkg.id, 'failed', e.message);
      ctx.log(`  ✖ ${e.message}`);
      if (ctx.settings.stopOnError) break;
      ctx.progress.report({ increment: step });
      continue;
    }

    let stop = false;
    for (const s of pkg.postInstall ?? []) {
      const label = stepLabel(s);
      ctx.onStatus?.(pkg.id, 'postInstall', label);
      ctx.progress.report({ message: `${prefix}: ${label}` });
      ctx.log(`  → ${label}`);
      try {
        await runStep(s, ctx);
        res.steps.push({ label, status: 'ok' });
        ctx.log(`    ✔ done`);
      } catch (e: any) {
        if (e instanceof CancelledError) throw e;
        res.steps.push({ label, status: 'failed', error: e.message });
        ctx.log(`    ✖ ${e.message}`);
        if (!s.continueOnError) {
          res.status = 'failed';
          res.error = `Post-install step failed: ${label}`;
          if (ctx.settings.stopOnError) stop = true;
          break;
        }
      }
    }
    if (res.status === 'failed') ctx.onStatus?.(pkg.id, 'failed', res.error);
    else ctx.onStatus?.(pkg.id, 'installed', res.steps.some(s => s.status === 'failed') ? 'Installed, a post-install step failed' : undefined);
    ctx.progress.report({ increment: step });
    if (stop) break;
  }
  return results;
}

export function summarize(results: PackageResult[]): string {
  const icon = { installed: '✔', skipped: '↷', failed: '✖', 'not run': '·' } as const;
  return results
    .map(r => {
      const lines = [`${icon[r.status]} ${r.pkg.name} — ${r.status}${r.error ? `: ${r.error}` : ''}`];
      r.steps.forEach(s => lines.push(`    ${s.status === 'ok' ? '✔' : '✖'} ${s.label}${s.error ? `: ${s.error}` : ''}`));
      return lines.join('\n');
    })
    .join('\n');
}
