# ReejFastOrg Setup

VS Code extension that prepares a Salesforce org in three steps:

1. **Connect** to a Developer, Sandbox, Production (or My Domain / scratch) org through the `sf` CLI — reuse an authenticated org or log in through the browser.
2. **Choose** the packages to install from a catalog (multi-select; dependencies are added automatically).
3. **Install** them one after the other, in dependency order, and run each package's post-install steps.

## Requirements

- Salesforce CLI (`sf`) on your PATH
- VS Code 1.85+

## Quick start

1. **Connect an org**: plug button in the sidebar title, or the → next to an org under *Authenticated orgs*.
2. **Run Setup** (rocket in the sidebar, the status-bar item, or a click on *Packages*) opens the **package screen** in the editor for the connected org. It doesn't ask for the org again.
3. **Click the tiles** to choose packages. Tiles are grouped by **source** (Reej, UnofficialSF, …). Selecting a package also selects the packages it needs; unselecting one unselects the packages that need it. Each tile shows whether that version is already installed in the org.
4. The bottom bar shows the **install order** (already-installed packages struck through, as they will be skipped) — choose **Access** (*Admins only* or *All users*, remembered for next time) and click **Install N packages**. Tiles show live status: queued → installing → post-install → installed / failed.

The built-in Reej list (ReejOrgInit, Flow Base Packs, Datatable) is used until you set your own catalog with *Choose Package Catalog…* ("…" menu). The first time you add a package, an editable copy is saved and used for all your workspaces.

## Customer customization

The **Customer customization** tile (Reej group) installs no package. When applied, it asks for:
1. the **company name**;
2. the **Brand Image (600x120 pixels)** — PNG, JPG, GIF or SVG, 5 MB max; you're warned if it has another size;
3. the **brand colour** (`#RRGGBB`).

It then (after ReejOrgInit, which it needs):
- renames **Reej Sales** → **<Company> Sales** and **Reej Service Console** → **<Company> Service Console**. The apps are retrieved from the org first, so only their label changes. Both apps keep `shouldOverrideOrgTheme=false`, so they show the theme logo.
- renames the **Reej Standard User** profile → **<Company> Standard User**. It is a rename of the same profile, so its users and settings stay. A profile that is missing or ambiguous is left alone and reported as skipped in the log.
- uploads the icon as an asset file and creates (or updates) the SLDS 2 theme **<Company> Theme** (`Reej_Demo_Theme`), with the image as brand image (also used on the Lightning Experience loading page), the colour as brand colour and a light tint of it as page background.
- offers to open **Setup → Themes and Branding**, where you click **Activate** (the Metadata API can't activate a theme).

Running it again with another company updates the same theme, the same two apps and the same profile. Upgrading ReejOrgInit puts the "Reej …" app names back — apply the customization again afterwards. The upgrade's post-install deploy also creates a new **Reej Standard User** profile next to the renamed one: with the same company name, the customization reports this and leaves both in place, so remove the extra one in Setup. The last name / icon / colour are proposed again next time.

In the catalog, the entry is `"kind": "demoBranding"`; its `branding` block lists the apps (`{ "name": "Reej_App_Sales", "label": "{company} Sales" }`), the profiles (`{ "name": "Reej Standard User", "label": "{company} Standard User" }`) and the theme API name. A catalog without `profiles` uses that same default.

## Adding packages to the catalog

Click **+ Add package** (package screen or sidebar) and answer 5 questions:
1. paste the **install link** (`https://login.salesforce.com/packaging/installPackage.apexp?p0=04t…`) or the **04t Id**;
2. a **name**;
3. its **source** — the tile group (pick an existing one or type a new one);
4. tick the packages that must be installed **before** it (its dependencies);
5. whether it needs an **installation key**.

The extension writes it into the catalog JSON. Right-click a package → *Remove from Catalog* to take it out (nothing is uninstalled from any org).
You can also edit the JSON directly (format below).

## Sidebar

| Section | Content | Actions |
|---|---|---|
| Connected org | Alias, type (Dev / Sandbox / PRODUCTION / Scratch), org name | Open in browser, change org, open *Installed Packages* setup page, disconnect |
| Packages | A checkbox per package; ✔ icon when that exact version is installed in the connected org, ⊘ when not allowed for this org type | Install selected, select all / none, add, remove, copy the 04t Id, open / choose the catalog |
| Authenticated orgs | Orgs known to the sf CLI, ● for the connected one, broken auth highlighted | Use this org, open it in the browser |
| Last run | Result of the last install, package by package | Open the log |
| Environment | sf CLI version (or why it isn't found), catalog path, settings | |

Title bar: **Install Selected**, **Connect**, **Add Package**, **Refresh**; the "…" menu has *Run Setup*, *Install Packages (list)*, *Open / Choose Catalog*, *Show Log*, *Disconnect*.

## Salesforce CLI not found?

The extension tries `sf` on VS Code's PATH, then the usual install folders (`C:\Program Files\sf\bin\sf.cmd`, `%APPDATA%\npm\sf.cmd`, …).
If the CLI was installed while VS Code was open, restart VS Code. Otherwise set **`reejFastOrg.sfPath`** to the full path (find it with `where sf` in a terminal).
Hover the *Environment* line in the sidebar to see the exact error.

## Commands (Ctrl/Cmd+Shift+P → "ReejFastOrg")

| Command | What it does |
|---|---|
| Run Org Setup | Full flow: connect → choose packages → install |
| Connect to an Org | Pick / log in to an org (remembered per workspace, shown in the status bar) |
| Install Packages in Connected Org | Steps 2 and 3 on the current org |
| Open / Create Package Catalog | Opens the catalog (creates a sample one if missing) |
| Show Log | Output channel with every `sf` command and result |

## Package catalog

Default location: `.reejfastorg/packages.json` in the workspace (setting `reejFastOrg.catalogPath`).

```json
{
  "packages": [
    {
      "id": "core",
      "name": "Reej Core",
      "source": "Reej",
      "url": "https://…",
      "description": "Base objects",
      "versionId": "04t...",
      "order": 10,
      "default": true,
      "dependsOn": [],
      "requiresKey": false,
      "orgTypes": ["dev", "sandbox", "prod", "scratch"],
      "postInstall": [
        { "type": "permset",  "name": ["Reej_Admin"] },
        { "type": "apex",     "file": "scripts/apex/init.apex" },
        { "type": "dataTree", "plan": "data/plan.json" },
        { "type": "deploy",   "path": "force-app/post-install" },
        { "type": "sf",       "args": ["org", "assign", "permsetlicense", "--name", "X", "--target-org", "${org}"], "continueOnError": true }
      ]
    }
  ]
}
```

- **source** groups the tiles; **url** adds a *Docs* link on the tile.
- **Order**: dependencies (`dependsOn`) always install first; otherwise ascending `order`, then catalog position.
- **Installation keys**: `requiresKey: true` prompts at install time (masked in the log). `installationKey` in the file also works but avoid committing it.
- **orgTypes**: hides a package for other org kinds (e.g. demo data never offered on production).
- **Post-install paths** are absolute or relative to the catalog file's folder. In `sf` steps, `${org}` and `${catalogDir}` are substituted. A `deploy` step runs from the nearest folder above its `path` that holds an `sfdx-project.json` (or the folder given in `"project"`).
- A failed step stops the sequence unless `continueOnError: true` on the step (or `reejFastOrg.stopOnError: false`).

## Safety

- Production orgs are detected (Organization record) and flagged in the status bar; the confirmation dialog requires an explicit "Install in Production".
- Packages whose exact version is already installed are skipped (`reejFastOrg.skipAlreadyInstalled`).
- The whole run can be cancelled from the progress notification.

## Settings

| Setting | Default |
|---|---|
| `reejFastOrg.catalogPath` | `.reejfastorg/packages.json` (an absolute path in User settings is recommended) |
| `reejFastOrg.sfPath` | empty = auto-detect |
| `reejFastOrg.waitMinutes` | `30` (then polls `sf package install report`) |
| `reejFastOrg.securityType` | `AdminsOnly` |
| `reejFastOrg.skipAlreadyInstalled` | `true` |
| `reejFastOrg.stopOnError` | `true` |

## Build

```bash
npm install
npm run compile
npm run package   # produces reejfastorg-setup-0.1.0.vsix
```
Install the .vsix via Extensions → "…" → *Install from VSIX…*. Press F5 in this folder to debug.
