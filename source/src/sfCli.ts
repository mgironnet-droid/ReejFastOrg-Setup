import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export class SfError extends Error {
  constructor(message: string, public readonly output?: any) {
    super(message);
    this.name = 'SfError';
  }
}

export class SfNotFoundError extends SfError {
  constructor(public readonly tried: string[]) {
    super(
      'Salesforce CLI (sf) was not found. If it is installed, set "reejFastOrg.sfPath" to the full path of sf ' +
      '(e.g. C:\\Program Files\\sf\\bin\\sf.cmd) or restart VS Code so it picks up the new PATH.'
    );
    this.name = 'SfNotFoundError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled by user');
    this.name = 'CancelledError';
  }
}

export interface SfRunOptions {
  cwd?: string;
  token?: vscode.CancellationToken;
  log?: (line: string) => void;
  /** Argument values to mask in the log (installation keys, …). */
  secrets?: string[];
}

const isWin = process.platform === 'win32';

/** Places the sf installers put the CLI, used when "sf" is not on VS Code's PATH. */
function knownLocations(): string[] {
  const env = process.env;
  const home = os.homedir();
  const list = isWin
    ? [
        path.join(env['ProgramFiles'] ?? 'C:\\Program Files', 'sf', 'bin', 'sf.cmd'),
        path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'sf', 'bin', 'sf.cmd'),
        env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'sf', 'client', 'bin', 'sf.cmd') : '',
        env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'sf', 'bin', 'sf.cmd') : '',
        env.APPDATA ? path.join(env.APPDATA, 'npm', 'sf.cmd') : '',
        path.join(env['ProgramFiles'] ?? 'C:\\Program Files', 'Salesforce CLI', 'bin', 'sf.cmd')
      ]
    : ['/usr/local/bin/sf', '/opt/homebrew/bin/sf', path.join(home, '.npm-global', 'bin', 'sf'), path.join(home, '.local', 'bin', 'sf'), '/usr/local/lib/sf/bin/sf'];
  return list.filter(p => p && fs.existsSync(p));
}

let resolvedCommand: string | undefined;

/** Forget the resolved CLI (after the sfPath setting changes). */
export function resetSfResolution() {
  resolvedCommand = undefined;
}

function configuredPath(): string | undefined {
  const v = vscode.workspace.getConfiguration('reejFastOrg').get<string>('sfPath', '')?.trim();
  return v ? v : undefined;
}

function candidates(): string[] {
  const conf = configuredPath();
  if (conf) return [conf];
  if (resolvedCommand) return [resolvedCommand];
  return ['sf', ...knownLocations()];
}

/** Which executable is being used (for display). */
export function sfCommandInUse(): string {
  return configuredPath() ?? resolvedCommand ?? 'sf';
}

function quoteForWindowsShell(arg: string): string {
  if (arg === '') return '""';
  return /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

interface RawResult { code: number | null; stdout: string; stderr: string; notFound: boolean }

function spawnOnce(command: string, args: string[], opts: SfRunOptions): Promise<RawResult> {
  // A missing cwd makes spawn fail with ENOENT, exactly like a missing executable.
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : undefined;
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      SF_AUTOUPDATE_DISABLE: 'true',
      SF_JSON_TO_STDOUT: 'true',
      SF_USE_PROGRESS_BAR: 'false',
      SF_DISABLE_TELEMETRY: 'true',
      FORCE_COLOR: '0',
      NO_COLOR: '1'
    };
    const child = isWin
      ? spawn(quoteForWindowsShell(command), args.map(quoteForWindowsShell), { cwd, env, shell: true, windowsHide: true })
      : spawn(command, args, { cwd, env });

    let stdout = '';
    let stderr = '';
    let cancelled = false;
    const sub = opts.token?.onCancellationRequested(() => {
      cancelled = true;
      child.kill();
    });
    child.stdout.on('data', d => (stdout += d.toString()));
    child.stderr.on('data', d => (stderr += d.toString()));
    child.on('error', (err: NodeJS.ErrnoException) => {
      sub?.dispose();
      if (err.code === 'ENOENT') resolve({ code: null, stdout, stderr, notFound: true });
      else reject(new SfError(err.message));
    });
    child.on('close', code => {
      sub?.dispose();
      if (cancelled) return reject(new CancelledError());
      // cmd.exe exits with 9009 for an unknown command; messages are localized (FR/DE/ES covered).
      const notFound =
        !stdout.includes('{') &&
        (code === 9009 || code === 127 ||
          /is not recognized|n'est pas reconnu|nicht erkannt|no se reconoce|command not found|cannot find the path|chemin d'accès spécifié|no such file/i.test(stderr + stdout));
      resolve({ code, stdout, stderr, notFound });
    });
  });
}

/** Runs sf with the first working executable; remembers it for the next calls. */
async function runSf(args: string[], opts: SfRunOptions): Promise<RawResult> {
  if (opts.token?.isCancellationRequested) throw new CancelledError();
  const tried: string[] = [];
  for (const c of candidates()) {
    tried.push(c);
    const r = await spawnOnce(c, args, opts);
    if (!r.notFound) {
      if (!configuredPath()) resolvedCommand = c;
      return r;
    }
  }
  throw new SfNotFoundError(tried);
}

/**
 * Runs `sf <args> --json` and returns the parsed `result`.
 * Rejects with SfError when the CLI reports a non-zero status.
 */
export async function sf<T = any>(args: string[], opts: SfRunOptions = {}): Promise<T> {
  const fullArgs = [...args, '--json'];
  const shown = fullArgs.map(a => (opts.secrets?.includes(a) ? '********' : a)).join(' ');
  opts.log?.(`$ sf ${shown}`);

  const { code, stdout, stderr } = await runSf(fullArgs, opts);

  const start = stdout.indexOf('{');
  if (start < 0) throw new SfError((stderr || stdout).trim() || `sf exited with code ${code}`);

  let json: any;
  try {
    json = JSON.parse(stdout.slice(start));
  } catch {
    throw new SfError(`Could not parse sf output: ${stdout.slice(0, 500)}`);
  }

  for (const w of json.warnings ?? []) opts.log?.(`  ⚠ ${w}`);

  // Most sf commands wrap their output in { status, result }; a few oclif ones (sf version) do not.
  if (typeof json.status !== 'number') {
    if (code && code !== 0) throw new SfError(json.message || `sf exited with code ${code}`, json);
    return (json.result ?? json) as T;
  }
  if (json.status !== 0) {
    const msg = describeFailure(json);
    if (!msg) opts.log?.(`  raw sf output: ${stdout.slice(start, start + 4000)}`);
    throw new SfError(msg || `sf exited with status ${json.status}`, json);
  }
  return json.result as T;
}

const asArray = (v: any): any[] => (Array.isArray(v) ? v : v ? [v] : []);

/**
 * Readable reason of a failed command. Deploy / retrieve failures often have an empty "message": the reasons are in
 * result.details.componentFailures (or result.files[].error), sometimes under "data" instead of "result".
 */
export function describeFailure(json: any): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (l: string) => { if (l && !seen.has(l)) { seen.add(l); lines.push(l); } };
  for (const r of [json?.result, json?.data]) {
    if (!r || typeof r !== 'object') continue;
    for (const f of asArray(r.details?.componentFailures)) {
      const where = [f.componentType, f.fullName].filter(Boolean).join(' ');
      const line = f.lineNumber ? ` (line ${f.lineNumber})` : '';
      add(`${where || f.fileName || 'component'}: ${f.problem ?? f.problemType ?? 'failed'}${line}`);
    }
    for (const f of asArray(r.files)) {
      if (f?.state === 'Failed' && f.error) add(`${[f.type, f.fullName].filter(Boolean).join(' ')}: ${f.error}`);
    }
    for (const m of asArray(r.details?.runTestResult?.failures)) add(`test ${m.name}.${m.methodName}: ${m.message}`);
    if (r.errorMessage) add(String(r.errorMessage));
  }
  const head = [json?.name && json.name !== 'Error' ? json.name : '', json?.message].filter(Boolean).join(': ');
  if (!lines.length) return head;
  return (head ? head + '\n' : '') + lines.map(l => '  • ' + l).join('\n');
}

/** `sf --version` → "@salesforce/cli/2.x.y win32-x64 node-v20…" */
export async function sfVersion(opts: SfRunOptions = {}): Promise<string> {
  const { stdout, stderr } = await runSf(['--version'], opts);
  const line = (stdout || stderr).trim().split(/\r?\n/)[0] ?? '';
  const m = line.match(/@salesforce\/cli\/(\S+)/);
  if (m) return m[1];
  if (line) return line;
  throw new SfError('sf --version returned nothing');
}
