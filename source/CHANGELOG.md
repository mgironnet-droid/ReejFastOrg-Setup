# Changelog

## 0.6.0 — 2026-11-09
- Built-in list, Reej group: **Account Contact Card 0.8.0-1** (`04tg8000000aNR7AAM`) and **Contact Hierarchy (Org Chart) 0.2.3-1** (`04tg8000000a5lxAAA`). After installing, each assigns its permission set (ReejAccountContactCardAccess / ReejContactHierarchy) to the installing user.

## 0.5.9 — 2026-11-04
- **Demo Add-on** is now called **Customer customization** (tile, sidebar, docs). Its catalog `id`, its `kind` and the theme API name don't change.
- It also renames the **Reej Standard User** profile to **<Company> Standard User**. Assigned users are kept. Running it again with another company renames the same profile. Catalog entries can set `branding.profiles`.

## 0.5.8 — 2026-11-02
- Built-in list: UnofficialSF **Input Rich Text 1.7** (`04t5G000004fzB0QAI`).

## 0.5.7 — 2026-10-28
- Fix: after uninstalling packages, *Refresh* still showed them as installed. The results of the last install run no longer keep tiles green after a refresh, a refresh always re-reads the org (an older read finishing late is ignored), and the package screen's Refresh button also refreshes the sidebar.

## 0.5.6 — 2026-10-28
- Built-in list: **Lightning Messaging Utility** (Salesforce Labs, `04t5w000005PlsJAAS`) in the AppExchange group.

## 0.5.5 — 2026-10-28
- Built-in list: UnofficialSF **File Upload Improved 2.0.2** and **Show Toast 2.0**; new AppExchange group with **DLRS 2.25** (Declarative Lookup Rollup Summaries).

## 0.5.4 — 2026-10-28
- Fix: Demo Add-on deploy rejected with *bad value for restricted picklist field: lightningExperienceBrandingSetDefinition* — the theme's branding set no longer has a `type` element (Lightning theme branding sets have none).

## 0.5.3 — 2026-10-28
- Failed deploys / retrieves now show the reason of each failing component (from the CLI's componentFailures) instead of "sf exited with status 1"; when the CLI gives no reason, its raw output is written to the log.

## 0.5.2 — 2026-10-28
- Fix: Demo Add-on failed with *The path "force-app", specified in sfdx-project.json, does not exist* — the temporary project now creates its package folder before retrieving the apps. The log shows where the temporary project is.

## 0.5.1 — 2026-10-28
- Demo Add-on: asks for the **Brand Image (600x120 pixels)** and warns when the chosen file has another size (use it anyway / choose another).
- The theme now has **Use brand image on Lightning Experience loading page** checked (`shouldOverrideLoadingImage` + `OVERRIDE_LOADING_PAGE`).

## 0.5.0 — 2026-10-28
- **Demo Add-on** tile (Reej group): no package — asks for the company name, icon and brand colour, then
  - renames *Reej Sales* → *<Company> Sales* and *Reej Service Console* → *<Company> Service Console* (apps are read from the org first, only the label changes);
  - uploads the icon as an asset file and creates / updates the SLDS 2 theme *<Company> Theme* (API name `Reej_Demo_Theme`) with the icon as brand image and the colour as brand colour;
  - offers to open Setup → Themes and Branding to activate the theme (activation is not available through the Metadata API).
- Catalog entries can have `"kind": "demoBranding"` with a `branding` block (apps to relabel, theme name).

## 0.4.3 — 2026-10-28
- Package screen: **Access** switch (Admins only / All users) in the bottom bar, used for the next install and remembered in `reejFastOrg.securityType`. The confirmation dialog and the log show the access level.

## 0.4.2 — 2026-10-28
- Package screen: a package already installed in the org shows a ticked (green) checkbox, a light green tile and no Install button; it can't be selected and *Select all* skips it. In the sidebar it shows the ✔ icon without a checkbox.

## 0.4.1 — 2026-10-28
- Built-in Reej list: ReejOrgInit updated to 1.0.0-3 (04tg8000000Xgi1AAC); added Generic PDF Generator 1.0.0-1 and Render Email Template 1.0.0-1 to the Reej group; Docs links to the GitHub repositories.

## 0.4.0 — 2026-10-27
- **Package screen** (editor tab): one tile per package, grouped by source (Reej, UnofficialSF, …), with installed status in the connected org, dependencies, post-install steps, Docs link and a per-tile Install button. Select all / Unselect all per group. A bottom bar shows the install order and installs the selection; tiles show live progress.
- **Run Setup** now opens the package screen for the connected org instead of asking for the org again (it only asks when no org is connected). Clicking *Packages* in the sidebar opens it too.
- Packages have a `source` (tile group) and an optional `url`; *Add Package* asks for the source.

## 0.3.1 — 2026-10-27
- The full Reej package list (ReejOrgInit, Flow Actions Base Pack, Flow Screen Components Base Pack, Datatable) is now built in and used by default when no catalog file is set — nothing to configure.
- Adding or removing a package while on the built-in list first saves an editable copy and makes it your catalog for all workspaces.

## 0.3.0 — 2026-10-27
- Fix: the Salesforce CLI was reported as "not found" (`sf version --json` has no status field). The CLI is now also looked for in its usual install folders, can be set with `reejFastOrg.sfPath`, and the real error is shown on hover.
- Packages are selected with **checkboxes** in the sidebar; ticking a package ticks its dependencies, unticking one unticks the packages that need it. New *Install Selected Packages*, *Select All*, *Clear Selection*.
- **Add Package to Catalog…**: paste an install link or a 04t Id, name it, pick its dependencies. *Remove from Catalog* on right-click.
- **Choose Package Catalog…**: use or create a catalog file, for all workspaces or this one.
- `deploy` post-install steps run from the SFDX project that contains the deployed folder.
- The sample catalog now holds the real UnofficialSF Flow Base Packs and Datatable.

## 0.2.0 — 2026-10-27
- Extension icon and activity-bar icon (Reej mark + cloud with a lightning bolt).
- ReejFastOrg sidebar: connected org, catalog packages with their install status in that org, authenticated orgs, last run, environment.
- Menus: title-bar buttons (Run Setup, Connect, Open Catalog, Refresh), inline and right-click actions on orgs and packages (install one package, use / open an org, open the Installed Packages page, copy the 04t Id), explorer and editor menus on `.reejfastorg/*.json` catalogs.

## 0.1.0 — 2026-10-27
- First version: connect to a Dev / Sandbox / Production / scratch org via the sf CLI (existing auth or browser login), pick packages from `.reejfastorg/packages.json`, install them in dependency order with post-install steps (permission sets, anonymous Apex, data tree import, deploy, any sf command).
