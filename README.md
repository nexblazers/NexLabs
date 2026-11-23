# NexLabs 🧪

Free Salesforce tools, browser extensions and hacks by [NexBlazers](https://nexblazers.vercel.app): *Learn. Build. Grow.*

Every tool lives in its own folder with its own README and version. The list below is also published as [`tools.json`](tools.json), so the NexBlazers site can show it automatically.

## Tools

| Tool | Type | Version | What it does |
|------|------|---------|--------------|
| [Record Access Inspector](chrome-extensions/record-access-inspector) | Chrome / Edge extension | 1.0.0 | Tells you whether a user can Read / Edit / Delete a record, and *why*: owner, role hierarchy, sharing rules, manual shares, permission sets. |
| [Package Blocker Finder](chrome-extensions/package-blocker-finder) | Chrome / Edge extension | 0.4.0 | Finds the whole chain of components blocking a package uninstall or delete, in the order you need to fix them. |

## Repo layout

```
chrome-extensions/   browser extensions (Manifest V3)
vscode-extensions/   VS Code extensions          (coming soon)
sfdx/                LWC, Apex and metadata tools (coming soon)
scripts/             CLI scripts and bookmarklets (coming soon)
tools.json           machine-readable catalog of every tool
```

## Installing an extension

1. Download the tool's zip from [Releases](https://github.com/nexblazers/NexLabs/releases) and unzip it, or clone this repo.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the tool's folder.

All NexLabs extensions use the Salesforce session already open in your browser. Nothing is installed in your org, and no data leaves your browser except calls to your own org's API.

## Adding a new tool

1. Create a folder for it in the right category, e.g. `chrome-extensions/my-tool/`.
2. Give it a `README.md` with what it does, how to install it, and its version.
3. Add an entry to `tools.json`.
4. Add a row to the table above.
5. When it's ready to share, create a release tagged `my-tool@v1.0.0` and attach the zip.
