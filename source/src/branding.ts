// "Customer customization": brands an org for a customer without installing a package.
//  - renames the Reej apps ("Reej Sales" → "<Company> Sales", …) — the apps are retrieved from the org first so only
//    their label changes;
//  - renames the Reej profile ("Reej Standard User" → "<Company> Standard User") — a real rename, so the users assigned
//    to it are kept;
//  - uploads the company icon as an asset file (ContentAsset);
//  - creates / updates an SLDS 2 Lightning Experience theme (LightningExperienceTheme + BrandingSet) using that icon
//    as brand image and the chosen brand colour.
// Activating the theme stays a manual click in Setup → Themes and Branding (not available through the Metadata API).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sf, SfRunOptions } from './sfCli';
import { BrandingConfig, ConnectedOrg } from './types';

export interface BrandingInput {
  company: string;
  /** Absolute path of the PNG / JPG / GIF / SVG icon. */
  iconPath: string;
  /** #RRGGBB */
  color: string;
}

export interface ProfileRename {
  name: string;
  label: string;
  /** "skipped": the profile was not renamed, `message` says why. */
  status: 'renamed' | 'unchanged' | 'skipped';
  message: string;
}

export interface BrandingResult {
  themeLabel: string;
  themeName: string;
  assetName: string;
  apps: { name: string; label: string }[];
  profiles: ProfileRename[];
  projectDir: string;
}

export const DEFAULT_APPS = [
  { name: 'Reej_App_Sales', label: '{company} Sales' },
  { name: 'Reej_App_ServiceConsole', label: '{company} Service Console' }
];
export const DEFAULT_PROFILES = [{ name: 'Reej Standard User', label: '{company} Standard User' }];
/** Start of the description of the ReejOrgInit profile: tells it from a customer's own "… Standard User" profile. */
const REEJ_PROFILE_DESCRIPTION = 'Custom Standard User Profile';
export const DEFAULT_THEME = 'Reej_Demo_Theme';
export const ICON_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'svg'];
export const MAX_ICON_BYTES = 5 * 1024 * 1024;
/** Size Salesforce asks for the theme's brand image. */
export const BRAND_IMAGE_SIZE = { width: 600, height: 120 };

/** Width × height of a PNG, GIF, JPEG or SVG file, read from its header (undefined when unknown). */
export function imageSize(file: string): { width: number; height: number } | undefined {
  try {
    const b = fs.readFileSync(file);
    // PNG: IHDR chunk
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    // GIF
    if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    // JPEG: walk the markers up to a SOFn frame
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
      return undefined;
    }
    // SVG: width/height attributes, else viewBox
    const t = b.toString('utf8', 0, Math.min(b.length, 4096));
    const svg = t.match(/<svg\b[^>]*>/i)?.[0];
    if (svg) {
      const num = (n: string) => { const v = svg.match(new RegExp(`\\b${n}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, 'i')); return v ? Math.round(parseFloat(v[1])) : undefined; };
      const w = num('width'), h = num('height');
      if (w && h) return { width: w, height: h };
      const vb = svg.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
      if (vb) return { width: Math.round(parseFloat(vb[1])), height: Math.round(parseFloat(vb[2])) };
    }
  } catch {
    /* unreadable: unknown size */
  }
  return undefined;
}
/** Setup page where the theme is activated. */
export const THEMES_SETUP_PATH = 'lightning/setup/ThemingAndBranding/home';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function normalizeColor(v: string): string | undefined {
  const m = v.trim().match(/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/);
  if (!m) return undefined;
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
  return '#' + h.toUpperCase();
}

/** Mix the colour with white (amount 0..1 of white) — used for the page background. */
export function tint(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) + (255 - ((n >> shift) & 255)) * amount);
  return '#' + [16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function validateInput(input: BrandingInput): string | undefined {
  if (!input.company.trim()) return 'Company name is required';
  if (input.company.trim().length > 40) return 'Company name: 40 characters max (it goes into app and theme labels)';
  if (!normalizeColor(input.color)) return `Colour "${input.color}" is not a #RRGGBB value`;
  const ext = path.extname(input.iconPath).slice(1).toLowerCase();
  if (!ICON_TYPES.includes(ext)) return `Icon must be ${ICON_TYPES.join(', ')}`;
  if (!fs.existsSync(input.iconPath)) return `Icon not found: ${input.iconPath}`;
  if (fs.statSync(input.iconPath).size > MAX_ICON_BYTES) return 'Icon is larger than 5 MB';
  return undefined;
}

/** Asset names must start with a letter and contain only letters, digits and single underscores. */
export function assetName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `ReejDemoLogo_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Writes the asset, branding set and theme into <dir>/force-app/main/default. */
export function writeThemeSource(dir: string, input: BrandingInput, themeName: string, asset: string): { themeLabel: string } {
  const root = path.join(dir, 'force-app', 'main', 'default');
  const company = input.company.trim();
  const color = normalizeColor(input.color)!;
  const themeLabel = `${company} Theme`.slice(0, 70);
  const ext = path.extname(input.iconPath).toLowerCase();

  // 1. the icon, as an asset file (a ContentAsset is a binary .asset + its -meta.xml)
  const assets = path.join(root, 'contentassets');
  fs.mkdirSync(assets, { recursive: true });
  fs.copyFileSync(input.iconPath, path.join(assets, `${asset}.asset`));
  fs.writeFileSync(
    path.join(assets, `${asset}.asset-meta.xml`),
    `<?xml version="1.0" encoding="UTF-8"?>
<ContentAsset xmlns="http://soap.sforce.com/2006/04/metadata">
    <isVisibleByExternalUsers>false</isVisibleByExternalUsers>
    <language>en_US</language>
    <masterLabel>${xml(`${company} logo`.slice(0, 255))}</masterLabel>
    <relationships>
        <organization>
            <access>VIEWER</access>
        </organization>
    </relationships>
    <versions>
        <version>
            <number>1</number>
            <pathOnClient>${xml(`${asset}${ext}`)}</pathOnClient>
        </version>
    </versions>
</ContentAsset>
`
  );

  // 2. the branding set: brand colour + brand image (the logo shown in the header).
  //    No <type>: Lightning Experience theme branding sets don't have one (a value is rejected as a bad picklist value).
  const props: [string, string][] = [
    ['BRAND_COLOR', color],
    ['BRAND_IMAGE', `/file-asset/${asset}?v=1`],
    ['HEADER_BACKGROUND_COLOR', '#FFFFFF'],
    ['PAGE_BACKGROUND_COLOR', tint(color, 0.85)],
    ['LINK_AS_BACKGROUND', 'false'],
    // "Use brand image on Lightning Experience loading page"
    ['OVERRIDE_LOADING_PAGE', 'true']
  ];
  const sets = path.join(root, 'brandingSets');
  fs.mkdirSync(sets, { recursive: true });
  fs.writeFileSync(
    path.join(sets, `LEXTHEMING${themeName}.brandingSet-meta.xml`),
    `<?xml version="1.0" encoding="UTF-8"?>
<BrandingSet xmlns="http://soap.sforce.com/2006/04/metadata">
${props
  .map(([n, v]) => `    <brandingSetProperty>
        <propertyName>${n}</propertyName>
        <propertyValue>${xml(v)}</propertyValue>
    </brandingSetProperty>`)
  .join('\n')}
    <masterLabel>${xml(themeLabel)}</masterLabel>
</BrandingSet>
`
  );

  // 3. the SLDS 2 theme
  const themes = path.join(root, 'lightningExperienceThemes');
  fs.mkdirSync(themes, { recursive: true });
  fs.writeFileSync(
    path.join(themes, `${themeName}.lightningExperienceTheme-meta.xml`),
    `<?xml version="1.0" encoding="UTF-8"?>
<LightningExperienceTheme xmlns="http://soap.sforce.com/2006/04/metadata">
    <defaultBrandingSet>LEXTHEMING${themeName}</defaultBrandingSet>
    <description>${xml(`Demo theme for ${company}, generated by ReejFastOrg Setup.`)}</description>
    <designSystemVersion>SLDS_v2</designSystemVersion>
    <masterLabel>${xml(themeLabel)}</masterLabel>
    <shouldOverrideLoadingImage>true</shouldOverrideLoadingImage>
</LightningExperienceTheme>
`
  );
  return { themeLabel };
}

/** Replaces the app's top-level <label> (CustomApplication has no nested <label> elements). */
export function relabelApp(appXml: string, label: string): string {
  if (!/<label>[^<]*<\/label>/.test(appXml)) {
    return appXml.replace(/<\/CustomApplication>\s*$/, `    <label>${xml(label)}</label>\n</CustomApplication>\n`);
  }
  return appXml.replace(/<label>[^<]*<\/label>/, `<label>${xml(label)}</label>`);
}

export interface OrgProfile { Id: string; Name: string; Description?: string | null }

/** What to do for one profile; `rename` is the profile to rename, when there is one. `wanted.label` is already filled in. */
export function planProfileRename(
  profiles: OrgProfile[],
  wanted: { name: string; label: string; template: string }
): Pick<ProfileRename, 'status' | 'message'> & { rename?: OrgProfile } {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const source = profiles.find(p => same(p.Name, wanted.name));
  const target = profiles.find(p => same(p.Name, wanted.label));
  if (target && source && target !== source) {
    return { status: 'skipped', message: `Profile "${wanted.name}" not renamed: "${wanted.label}" already exists. Move its users, then delete one of the two.` };
  }
  if (target) return { status: 'unchanged', message: `Profile "${wanted.label}" already has this name` };

  // Renamed by an earlier run for another company: same template and description, another company name.
  const [before, after = ''] = wanted.template.split('{company}');
  const found = source ? [source] : profiles.filter(p =>
    p.Name.length > before.length + after.length && p.Name.startsWith(before) && p.Name.endsWith(after) &&
    (p.Description ?? '').startsWith(REEJ_PROFILE_DESCRIPTION));
  if (found.length > 1) {
    return { status: 'skipped', message: `Profile "${wanted.name}" not renamed: several profiles could be it (${found.map(p => p.Name).join(', ')}).` };
  }
  if (!found.length) {
    return { status: 'skipped', message: `Profile "${wanted.name}" not found in the org: not renamed (it comes with the ReejOrgInit post-install deploy).` };
  }
  return { status: 'renamed', message: `Profile "${found[0].Name}" renamed "${wanted.label}"`, rename: found[0] };
}

/**
 * The value goes through --flags-dir (a file read by the CLI), not the command line: on Windows sf runs through cmd.exe,
 * where no quoting suits every company name (L'Oréal, A&B). --values has no escape, so the quote must not be in the name.
 */
async function setProfileName(org: ConnectedOrg, id: string, name: string, opts: SfRunOptions): Promise<void> {
  const quote = name.includes('"') ? "'" : '"';
  if (name.includes(quote)) throw new Error(`Could not rename the profile to "${name}": a name can't hold both ' and "`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reejfastorg-flags-'));
  try {
    fs.writeFileSync(path.join(dir, 'values'), `Name=${quote}${name}${quote}`);
    await sf(['data', 'update', 'record', '--sobject', 'Profile', '--record-id', id, '--target-org', org.target, '--flags-dir', dir], opts);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function renameProfiles(org: ConnectedOrg, wanted: { name: string; label: string; template: string }[], opts: SfRunOptions): Promise<ProfileRename[]> {
  if (!wanted.length) return [];
  const q = await sf<{ records: OrgProfile[] }>(['data', 'query', '--query', "SELECT Id, Name, Description FROM Profile WHERE UserType = 'Standard'", '--target-org', org.target], opts);
  const done: ProfileRename[] = [];
  for (const w of wanted) {
    const { rename, ...plan } = planProfileRename(q.records, w);
    if (rename) await setProfileName(org, rename.Id, w.label, opts);
    opts.log?.(`  ${plan.status === 'skipped' ? '⚠ ' : ''}${plan.message}`);
    done.push({ name: w.name, label: w.label, ...plan });
  }
  return done;
}

export async function applyDemoBranding(
  org: ConnectedOrg,
  input: BrandingInput,
  cfg: BrandingConfig,
  opts: SfRunOptions & { onStep?: (label: string) => void }
): Promise<BrandingResult> {
  const err = validateInput(input);
  if (err) throw new Error(err);
  const company = input.company.trim();
  const themeName = cfg.themeName || DEFAULT_THEME;
  const fill = (s: string) => s.replace(/\{company\}/g, () => company).slice(0, 255);
  const apps = (cfg.apps?.length ? cfg.apps : DEFAULT_APPS).map(a => ({ name: a.name, label: fill(a.label) }));
  const profileList = (cfg.profiles?.length ? cfg.profiles : DEFAULT_PROFILES).map(p => ({ name: p.name, label: fill(p.label), template: p.label }));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reejfastorg-branding-'));
  fs.writeFileSync(
    path.join(dir, 'sfdx-project.json'),
    JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], name: 'reejfastorg-branding', namespace: '', sourceApiVersion: '64.0' }, null, 2)
  );
  // The CLI refuses a project whose package directory doesn't exist yet (even for a retrieve).
  fs.mkdirSync(path.join(dir, 'force-app', 'main', 'default'), { recursive: true });
  const run = { ...opts, cwd: dir };
  opts.log?.(`  temporary project: ${dir}`);

  // 1. Current apps from the org, so that only their label changes.
  if (apps.length) {
    opts.onStep?.('Reading the apps from the org');
    await sf(['project', 'retrieve', 'start', ...apps.flatMap(a => ['--metadata', `CustomApplication:${a.name}`]), '--target-org', org.target, '--wait', '10'], run);
    for (const a of apps) {
      const file = path.join(dir, 'force-app', 'main', 'default', 'applications', `${a.name}.app-meta.xml`);
      if (!fs.existsSync(file)) throw new Error(`App ${a.name} was not found in the org — install ReejOrgInit first.`);
      fs.writeFileSync(file, relabelApp(fs.readFileSync(file, 'utf8'), a.label));
      opts.log?.(`  ${a.name} → "${a.label}"`);
    }
  }

  // 2. Logo, branding set and SLDS 2 theme.
  const asset = assetName();
  const { themeLabel } = writeThemeSource(dir, input, themeName, asset);
  opts.log?.(`  theme ${themeName} "${themeLabel}", colour ${normalizeColor(input.color)}, logo ${asset}`);

  // 3. One deploy for everything.
  opts.onStep?.('Deploying the apps and the theme');
  await sf(['project', 'deploy', 'start', '--source-dir', 'force-app', '--target-org', org.target, '--wait', '30'], run);

  // 4. Profile, last: the rename isn't part of the deploy, so nothing changes if the deploy fails.
  opts.onStep?.('Renaming the profile');
  const profiles = await renameProfiles(org, profileList, opts);

  return { themeLabel, themeName, assetName: asset, apps, profiles, projectDir: dir };
}
