<p align="center"><img src="brand/logo-navy.png" width="180" alt="NexBlazers"></p>

# Package Blocker Finder for Salesforce
**by [NexBlazers](https://nexblazers.vercel.app)**: *Learn. Build. Grow.* · Chrome extension v0.4

Salesforce shows package-uninstall blockers one level at a time: fix one and the next delete is blocked by something else.
This extension finds the **whole chain at once**, puts it in the order you need to fix it, and gives every row a direct link,
a "Delete now" button where possible, and a one-shot destructive deploy.

## Install (developer mode)
1. Unzip this folder.
2. Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick the folder.
3. Log in to your org, open any Salesforce tab, click the extension icon → **Open for this org**.
   (On Installed Packages pages there is also a floating **⛓ Find all blockers** button.)

It uses your existing browser session (same approach as Salesforce Inspector). Nothing is installed in the org and no data leaves your browser.

## Modes
| Mode | What it does |
|---|---|
| **Managed package** | Everything outside the namespace that references it, plus the full chain behind every component you'll delete. |
| **Unmanaged package** | Retrieves the package's members (Metadata API), finds all references to them, and plans their deletion. |
| **Specific components** | Paste IDs (fields, classes, flows…) to get the full chain blocking their deletion. |

## How the chain is built
1. **Level 1**: components referencing the package (Dependency API `MetadataComponentDependency`).
2. Each blocker gets a default action:
   - **Delete**: the component exists only for the package, e.g. your formula field, validation rule, flow or workflow.
   - **Modify**: a shared component where you only remove the reference, e.g. a layout, Lightning page, Apex, report or permission set.
3. For every **Delete** row it asks "what references this?" and adds the answers as **Level 2, 3…**, up to the max depth.
4. Rows are sorted so each one comes before anything it references. Components that reference each other in a circle are grouped, so they can be deleted together in one deploy.
5. Switching a row between Delete and Modify recalculates the chain below it.

**Reports, dashboards and report types** (all modes, on by default). These only look at reports related to the package, so they stay fast in big orgs:
1. One query gets every report's type (`ReportTypeApiName`). No per-report calls yet.
2. The tool works out the **related objects**:
   - the package's own objects
   - objects the package adds fields to
   - objects whose fields or objects you're deleting in the plan
   - with **Include reports on child objects** on, their child objects too, because lookups put parent fields into child reports. For example, Account fields appear in Opportunity reports.
3. It reads definitions (columns, filters, groupings, buckets, cross filters) **only** for reports whose report type involves those objects, or a custom report type that does. Reports on unrelated objects, like Lead or Case, are never opened.
4. Custom report types: any built on or using package objects are flagged. One built on a package object is set to Delete, and so are the reports that use it.
5. Dashboards are looked up only for reports set to Delete.

An info line shows how many reports were read, e.g. "Report scan: 42 of 3,180 reports…". To check everything, set **Reports to check** to **All reports**, which is slow and limited by **Max reports**.

**Bulk API deep scan** uses Bulk API 2.0 at every level, so dependency data for reports is included all the way down, not just at level 1. It's slower because each level runs a bulk job.

**Text scan** (managed mode) also reads the source of Apex classes and triggers, Visualforce pages and components, email templates, workflow rules and (optionally) list views for `ns__` tokens. It catches dynamic SOQL, merge fields and filters that the Dependency API doesn't report. Comments are ignored.

## Fixing
- **Open ↗**: a deep link to the exact Setup page for the component.
- **Delete now**: deletes through the API right away, after you confirm.
  - Supported for fields, validation rules, workflow rules, field updates and alerts, Lightning pages, layouts, reports and dashboards.
  - For flows, it deactivates the flow and deletes every version.
  - Apex is supported only outside production.
- **Download destructive zip**: `package.xml` plus `destructiveChanges.xml` covering every open Delete row. Deploy it with `sf project deploy start --metadata-dir <folder>`.
- **Deploy all deletes…**: validates or deploys that same zip from the browser.
  - Rolls back everything if any part fails.
  - Runs `RunLocalTests` in production and `NoTestRun` with purge-on-delete in sandboxes.
- **✓ checkboxes**, actions you changed, and the last result are saved per org and package. **Re-scan** marks new blockers as NEW and counts the ones that are resolved.
- **Export CSV / Print** for change records.

## Permissions needed
"API Enabled", "View Setup and Configuration", and "Modify All Data" or "Customize Application" for deletes. Deploy also needs "Modify Metadata Through Metadata API Functions".

## Known limits
- The Dependency API is still **Beta** in Salesforce. The Tooling API caps at 2,000 rows, so the tool switches to Bulk API 2.0 automatically. Reports are covered by the report scan in every mode, and by **Bulk deep scan** in the dependency data.
- The report scan uses one API call per **related** report. Listing all reports costs one query per 2,000 reports. Reports you can't open (folder sharing) are counted in a warning.
- "Related only" matches report types by object name. Reports on User, Group, RecordType and Profile aren't expanded to child objects, because nearly every object looks up to them. If the package adds fields to User, run once with **All reports**.
- Some references (certain workflow-filter blockers, managed-package settings, some Experience Cloud metadata) are not exposed by any API. The text scan covers the most common ones. Whatever is left shows up on the real uninstall error, so run **Re-scan** after each attempt.
- In production, Apex can only be removed by deployment, not edited in place.
- Always try in a full or partial sandbox first.

## Files
`brand/` holds the NexBlazers logo files and `fonts/` the bundled Montserrat font (SIL Open Font License). `app.html/js/css` is the main page. `lib/engine.js` does the chain walk and ordering. `lib/sf.js` is the REST, Tooling, Bulk and SOAP client. `lib/types.js` holds per-type actions, tips and links. `lib/zip.js` builds the destructive package.

---
Built by **NexBlazers** · https://nexblazers.vercel.app · Learn. Build. Grow.
