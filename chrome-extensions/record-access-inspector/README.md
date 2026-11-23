# Salesforce Record Access Inspector

A Chrome / Edge extension (Manifest V3). You give it a **User Id** and a **Record Id**, and it tells you:

- whether the user can **Read / Edit / Delete / Transfer** the record, or has **Full access** to it
- **why**: every path that grants access (owner, queue, role hierarchy, org-wide default, sharing rules, manual or Apex shares, teams, View All / Modify All, parent record)
- every **share row** on the record, who it is shared with, and whether that row applies to the user
- the user's **object permissions**, and which profile or permission set grants each one

## How it authenticates

The extension reuses the Salesforce session already open in your browser (the `sid` cookie). It does not use a connected app and asks for no password. Every query runs as **you**, with **your** permissions. The session id stays in memory and is never stored or sent anywhere except your own org's API.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and select the `chrome-extensions/record-access-inspector` folder.
3. Pin the extension.

## Use

1. Open any page in your Salesforce org. On a record page, the Record Id is filled in for you.
2. Click the extension icon, enter the **User Id** (`005…`), and click **Check access**. **Me** fills in your own Id.
3. **Open in tab** shows the results in a full browser tab.
4. If the record's access comes from a parent record (Controlled by Parent / master-detail), click **Inspect parent**.

## How it works

| Step | API used |
| --- | --- |
| Final access answer | `UserRecordAccess` (HasRead/Edit/Delete/Transfer/AllAccess, MaxAccessLevel) |
| Object type | Global describe, matched on the key prefix |
| Org-wide defaults | `EntityDefinition.InternalSharingModel` / `ExternalSharingModel` |
| Owner, name, parent | SOQL on the record, plus describe for master-detail fields |
| Share rows | `<Object>Share` / `<Custom>__Share` |
| Groups the user belongs to | `GroupMember` (direct and nested), role / role-and-subordinates groups, All Internal Users |
| Role hierarchy | `UserRole` |
| System and object permissions | `PermissionSetAssignment` (includes the profile), `ObjectPermissions` |

The **effective** verdict combines sharing (`UserRecordAccess`) with object permissions. If sharing grants access but the user has no object Read permission, the verdict says so.

## Permissions your login needs

- **View Setup and Configuration**: to read roles, groups, permission sets and org-wide defaults.
- **View All Data** (recommended): without it you only see share rows and records that you can see yourself. Anything the extension could not read is listed under *Notes & limitations*.

## Known limitations

- For custom objects, it assumes **Grant Access Using Hierarchies** is enabled when it reports role-hierarchy access (the API does not expose this setting). The verdict itself always comes from `UserRecordAccess`.
- It does not resolve in detail: territory membership, sharing sets / share groups for Experience Cloud users, manager groups, and the names of the sharing rules behind `Rule` share rows. These cases show up as *Other mechanism* or as raw share rows.
