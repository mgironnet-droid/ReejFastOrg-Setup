export type OrgKind = 'dev' | 'sandbox' | 'prod' | 'scratch' | 'unknown';

export interface ConnectedOrg {
  /** Alias if any, otherwise username. Used as --target-org. */
  target: string;
  username: string;
  alias?: string;
  instanceUrl?: string;
  orgName?: string;
  kind: OrgKind;
}

export type PostInstallStep =
  | { type: 'permset'; name: string | string[]; label?: string; continueOnError?: boolean }
  | { type: 'apex'; file: string; label?: string; continueOnError?: boolean }
  | { type: 'dataTree'; plan: string; label?: string; continueOnError?: boolean }
  | { type: 'deploy'; path: string; /** SFDX project folder; default: nearest folder above `path` holding sfdx-project.json. */ project?: string; label?: string; continueOnError?: boolean }
  | { type: 'sf'; args: string[]; label?: string; continueOnError?: boolean };

export interface CatalogPackage {
  /** Stable key used by dependsOn. */
  id: string;
  name: string;
  description?: string;
  /** Publisher / family used to group tiles (e.g. "Reej", "UnofficialSF"). */
  source?: string;
  /** Documentation or install page. */
  url?: string;
  /**
   * "package" (default): a managed / unlocked package installed with `sf package install`.
   * "demoBranding": the Customer customization — no package; asks for a company name, icon and colour, renames the
   * Reej apps and profile and deploys an SLDS 2 theme.
   */
  kind?: 'package' | 'demoBranding';
  /** Settings of a "demoBranding" entry. */
  branding?: BrandingConfig;
  /** Subscriber package version Id (04t...). Empty for a "demoBranding" entry. */
  versionId: string;
  /** Tie-breaker for install order (lower first). Dependencies always come first. */
  order?: number;
  dependsOn?: string[];
  /** Pre-selected in the picker. */
  default?: boolean;
  /** Ask the user for the installation key at install time. */
  requiresKey?: boolean;
  /** Installation key stored in the catalog (avoid committing secrets). */
  installationKey?: string;
  /** Restrict the package to some org kinds. Omitted = all. */
  orgTypes?: OrgKind[];
  postInstall?: PostInstallStep[];
}

export interface BrandingConfig {
  /** Apps to relabel; "{company}" is replaced by the company name. Default: the two Reej apps. */
  apps?: { name: string; label: string }[];
  /** Profiles to rename; "{company}" is replaced by the company name. Default: Reej Standard User. */
  profiles?: { name: string; label: string }[];
  /** API name of the theme (created or updated). Default Reej_Demo_Theme. */
  themeName?: string;
}

export interface Catalog {
  packages: CatalogPackage[];
  /** Folder of the catalog file — relative step paths resolve from here. */
  baseDir: string;
  source: string;
}

export type StepStatus = 'ok' | 'failed' | 'skipped';
export type PackageStatus = 'installed' | 'skipped' | 'failed' | 'not run';

export interface PackageResult {
  pkg: CatalogPackage;
  status: PackageStatus;
  error?: string;
  steps: { label: string; status: StepStatus; error?: string }[];
}
