// Works out whether a user can access a record, and explains every path that grants it.
// UserRecordAccess is the authoritative answer; the rest of the data explains *why*.

const ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

export const OWD_LABELS = {
  None: 'Private / No access',
  Private: 'Private',
  Read: 'Public Read Only',
  ReadSelect: 'Public Read Only',
  ReadWrite: 'Public Read/Write',
  ReadWriteTransfer: 'Public Read/Write/Transfer',
  FullAccess: 'Public Full Access',
  ControlledByParent: 'Controlled by Parent',
  ControlledByCampaign: 'Controlled by Campaign',
  ControlledByLeadOrContact: 'Controlled by Lead or Contact'
};

const OWD_ACCESS = { Read: 'Read', ReadSelect: 'Read', ReadWrite: 'Edit', ReadWriteTransfer: 'Edit', FullAccess: 'All' };

const ROW_CAUSE_LABELS = {
  Owner: 'Record owner',
  Manual: 'Manual share',
  Rule: 'Sharing rule',
  GuestRule: 'Guest user sharing rule',
  ImplicitChild: 'Implicit (access to a child record)',
  ImplicitParent: 'Implicit (access from a parent record)',
  ImplicitPerson: 'Implicit (person account)',
  Team: 'Team member (Account/Opportunity/Case team)',
  Territory: 'Territory',
  TerritoryManual: 'Territory (manual)',
  TerritoryRule: 'Territory rule',
  Territory2AssociationManual: 'Territory (manual association)',
  LeadOwner: 'Lead owner',
  CollaborationGroup: 'Chatter group'
};

const PARENT_FALLBACK = {
  ControlledByParent: ['AccountId', 'ParentId'],
  ControlledByCampaign: ['CampaignId'],
  ControlledByLeadOrContact: ['WhoId', 'WhatId']
};

const ROLE_GROUP_TYPES = ['Role', 'RoleAndSubordinates', 'RoleAndSubordinatesInternal'];

/** Convert a 15-char case-sensitive id to the 18-char form the API returns. */
export function to18(id) {
  if (id.length === 18) return id;
  const map = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  let suffix = '';
  for (let i = 0; i < 3; i++) {
    let flags = 0;
    for (let j = 0; j < 5; j++) {
      const c = id.charAt(i * 5 + j);
      if (c >= 'A' && c <= 'Z') flags |= 1 << j;
    }
    suffix += map.charAt(flags);
  }
  return id + suffix;
}

export function validateIds(userId, recordId) {
  if (!ID_RE.test(userId)) throw new Error('User Id must be a 15 or 18 character Salesforce Id.');
  if (!userId.startsWith('005')) throw new Error('User Id must start with 005.');
  if (!ID_RE.test(recordId)) throw new Error('Record Id must be a 15 or 18 character Salesforce Id.');
  return { userId: to18(userId), recordId: to18(recordId) };
}

function roleAncestors(roleId, roles) {
  const out = [];
  let cur = roleId;
  for (let guard = 0; cur && guard < 100; guard++) {
    out.push(cur);
    cur = roles.get(cur)?.ParentRoleId;
  }
  return out;
}

/** True when `upperRoleId` is strictly above `roleId` in the hierarchy. */
function isAbove(upperRoleId, roleId, roles) {
  if (!upperRoleId || !roleId || upperRoleId === roleId) return false;
  return roleAncestors(roleId, roles).slice(1).includes(upperRoleId);
}

function permSetLabel(psa) {
  const ps = psa.PermissionSet;
  if (ps.IsOwnedByProfile) return `Profile: ${ps.Profile?.Name ?? ps.Label}`;
  if (psa.PermissionSetGroup) return `Permission Set Group: ${psa.PermissionSetGroup.MasterLabel}`;
  return `Permission Set: ${ps.Label}`;
}

function groupLabel(g, roles) {
  const roleName = roles.get(g.RelatedId)?.Name ?? g.RelatedId;
  switch (g.Type) {
    case 'Role':
      return `Role: ${roleName}`;
    case 'RoleAndSubordinates':
      return `Role & Subordinates: ${roleName}`;
    case 'RoleAndSubordinatesInternal':
      return `Role & Internal Subordinates: ${roleName}`;
    case 'Queue':
      return `Queue: ${g.Name}`;
    case 'Regular':
      return `Public Group: ${g.Name}`;
    case 'Organization':
      return 'All Internal Users';
    case 'Territory':
    case 'TerritoryAndSubordinates':
      return `${g.Type === 'Territory' ? 'Territory' : 'Territory & Subordinates'} (${g.RelatedId})`;
    default:
      return `${g.Type}: ${g.Name || g.DeveloperName || g.Id}`;
  }
}

export async function analyze(api, rawUserId, rawRecordId, progress = () => {}) {
  const { userId, recordId } = validateIds(rawUserId.trim(), rawRecordId.trim());
  const warnings = [];
  const safe = async (label, fn, fallback = null) => {
    try {
      return await fn();
    } catch (e) {
      warnings.push(`${label}: ${e.message}`);
      return fallback;
    }
  };

  // ---- Object type -------------------------------------------------------
  progress('Identifying object type…');
  const global = await api.describeGlobal();
  const sobj = global.sobjects.find((s) => s.keyPrefix === recordId.slice(0, 3));
  if (!sobj) throw new Error(`No object visible to you has key prefix "${recordId.slice(0, 3)}".`);
  const objName = sobj.name;

  // ---- Independent lookups in parallel -----------------------------------
  progress('Loading user, access and sharing settings…');
  const [ura, users, describe, entityDef, psas, roleRows] = await Promise.all([
    safe('UserRecordAccess', async () => {
      const base = `FROM UserRecordAccess WHERE UserId = '${userId}' AND RecordId = '${recordId}'`;
      const fields = 'RecordId, HasReadAccess, HasEditAccess, HasDeleteAccess, HasTransferAccess, HasAllAccess';
      try {
        return (await api.query(`SELECT ${fields}, MaxAccessLevel ${base}`))[0] ?? null;
      } catch {
        return (await api.query(`SELECT ${fields} ${base}`))[0] ?? null;
      }
    }),
    api.query(
      `SELECT Id, Name, Username, IsActive, UserType, ProfileId, Profile.Name, UserRoleId, UserRole.Name ` +
        `FROM User WHERE Id = '${userId}'`
    ),
    api.describe(objName),
    safe('Org-wide defaults', async () =>
      (
        await api.query(
          `SELECT QualifiedApiName, InternalSharingModel, ExternalSharingModel FROM EntityDefinition ` +
            `WHERE QualifiedApiName = '${objName}'`
        )
      )[0]
    ),
    safe(
      'Permission set assignments',
      async () => {
        const base =
          'PermissionSetId, PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.Profile.Name, ' +
          'PermissionSet.PermissionsViewAllData, PermissionSet.PermissionsModifyAllData';
        const where = `FROM PermissionSetAssignment WHERE AssigneeId = '${userId}'`;
        try {
          return await api.query(`SELECT ${base}, PermissionSetGroup.MasterLabel ${where}`);
        } catch {
          return await api.query(`SELECT ${base} ${where}`);
        }
      },
      []
    ),
    safe('Role hierarchy', () => api.query('SELECT Id, Name, ParentRoleId FROM UserRole'), [])
  ]);

  const user = users[0];
  if (!user) throw new Error(`User ${userId} not found (or not visible to you).`);
  const roles = new Map(roleRows.map((r) => [r.Id, r]));
  const isInternal = user.UserType === 'Standard';

  // ---- System + object permissions --------------------------------------
  progress('Checking profile and permission sets…');
  const systemPerms = { viewAllData: [], modifyAllData: [] };
  for (const psa of psas) {
    if (psa.PermissionSet.PermissionsModifyAllData) systemPerms.modifyAllData.push(permSetLabel(psa));
    if (psa.PermissionSet.PermissionsViewAllData) systemPerms.viewAllData.push(permSetLabel(psa));
  }

  const psLabelById = new Map(psas.map((p) => [p.PermissionSetId, permSetLabel(p)]));
  const objPermRows = psas.length
    ? await safe(
        'Object permissions',
        () =>
          api.queryIn(
            'SELECT ParentId, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, ' +
              `PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions ` +
              `WHERE SobjectType = '${objName}' AND ParentId IN ({ids})`,
            [...psLabelById.keys()]
          ),
        null
      )
    : null;

  let objPerms = null;
  if (objPermRows && (objPermRows.length || sobj.custom)) {
    const keys = { read: 'Read', create: 'Create', edit: 'Edit', delete: 'Delete', viewAll: 'ViewAllRecords', modifyAll: 'ModifyAllRecords' };
    objPerms = {};
    for (const [k, field] of Object.entries(keys)) {
      const sources = objPermRows.filter((r) => r[`Permissions${field}`]).map((r) => psLabelById.get(r.ParentId));
      objPerms[k] = { granted: sources.length > 0, sources };
    }
  } else if (objPermRows) {
    warnings.push(`No object permission rows exist for ${objName}; it may not be governed by object permissions.`);
  }

  // ---- Effective group membership ----------------------------------------
  progress('Resolving group and role membership…');
  const groups = await safe('Group membership', () => computeGroups(api, user, roles, isInternal), new Map());

  // ---- Record, owner and parent ------------------------------------------
  progress('Loading record details…');
  const fields = describe.fields;
  const nameField = fields.find((f) => f.nameField)?.name;
  const hasOwner = fields.some((f) => f.name === 'OwnerId');
  const sharingModel = entityDef?.InternalSharingModel;
  let parentFields = fields.filter((f) => f.type === 'reference' && f.relationshipOrder != null).map((f) => f.name);
  if (!parentFields.length && PARENT_FALLBACK[sharingModel]) {
    parentFields = PARENT_FALLBACK[sharingModel].filter((n) => fields.some((f) => f.name === n));
  }

  const selectFields = ['Id', nameField, hasOwner && 'OwnerId', ...parentFields].filter(Boolean);
  const record =
    sobj.queryable &&
    (await safe('Record', async () => (await api.query(`SELECT ${[...new Set(selectFields)].join(', ')} FROM ${objName} WHERE Id = '${recordId}'`))[0]));
  if (sobj.queryable && record === undefined) {
    warnings.push('You (the logged-in user) cannot see this record, so owner/parent details may be incomplete.');
  }

  // ---- Share rows --------------------------------------------------------
  progress('Reading share records…');
  const shareObj = sobj.custom ? objName.replace(/__c$/, '__Share') : `${objName}Share`;
  const shareExists = global.sobjects.some((s) => s.name === shareObj);
  let shareRows = [];
  let accessField = null;
  let extraAccessFields = [];
  if (shareExists) {
    const shareDescribe = await safe(`Describe ${shareObj}`, () => api.describe(shareObj));
    if (shareDescribe) {
      const sf = shareDescribe.fields.map((f) => f.name);
      const parentField = sf.includes('ParentId') ? 'ParentId' : `${objName}Id`;
      accessField = sf.includes('AccessLevel') ? 'AccessLevel' : `${objName}AccessLevel`;
      extraAccessFields = sf.filter((n) => n.endsWith('AccessLevel') && n !== accessField);
      shareRows = await safe(
        `Share records (${shareObj})`,
        () =>
          api.query(
            `SELECT Id, UserOrGroupId, RowCause, ${[accessField, ...extraAccessFields].join(', ')} ` +
              `FROM ${shareObj} WHERE ${parentField} = '${recordId}'`
          ),
        []
      );
    }
  }

  // Owner falls back to the Owner share row when the record itself isn't visible to us.
  const ownerId = record?.OwnerId ?? shareRows.find((s) => s.RowCause === 'Owner')?.UserOrGroupId ?? null;

  // ---- Resolve names for share recipients + owner ------------------------
  const principalIds = [...new Set([...shareRows.map((s) => s.UserOrGroupId), ownerId].filter(Boolean))];
  const userIds = principalIds.filter((id) => id.startsWith('005'));
  const groupIds = principalIds.filter((id) => id.startsWith('00G'));
  const [principalUsers, principalGroups] = await Promise.all([
    userIds.length
      ? safe('Share recipients (users)', () => api.queryIn('SELECT Id, Name, UserRoleId, IsActive FROM User WHERE Id IN ({ids})', userIds), [])
      : [],
    groupIds.length
      ? safe('Share recipients (groups)', () => api.queryIn('SELECT Id, Name, DeveloperName, Type, RelatedId FROM Group WHERE Id IN ({ids})', groupIds), [])
      : []
  ]);
  const userMap = new Map(principalUsers.map((u) => [u.Id, u]));
  const groupMap = new Map(principalGroups.map((g) => [g.Id, g]));
  const principalName = (id) => {
    if (userMap.has(id)) return `User: ${userMap.get(id).Name}`;
    if (groupMap.has(id)) return groupLabel(groupMap.get(id), roles);
    return id;
  };

  // ---- Explain each share row --------------------------------------------
  const shares = shareRows.map((s) => {
    const id = s.UserOrGroupId;
    let how = null;
    if (id === userId) how = 'Shared directly with this user';
    else if (groups.has(id)) how = `User is in this group (${groups.get(id)})`;
    else if (userMap.has(id) && isAbove(user.UserRoleId, userMap.get(id).UserRoleId, roles))
      how = `User is above ${userMap.get(id).Name} in the role hierarchy`;
    const extra = Object.fromEntries(
      extraAccessFields.filter((f) => s[f] && s[f] !== 'None').map((f) => [f.replace(/AccessLevel$/, ''), s[f]])
    );
    return {
      sharedWith: principalName(id),
      principalId: id,
      accessLevel: s[accessField],
      extra,
      rowCause: s.RowCause,
      rowCauseLabel: ROW_CAUSE_LABELS[s.RowCause] ?? (s.RowCause?.endsWith('__c') ? `Apex sharing reason (${s.RowCause})` : s.RowCause),
      applies: Boolean(how),
      how
    };
  });

  // ---- Access paths (why the user has access) ----------------------------
  const paths = [];
  const addPath = (access, title, detail) => paths.push({ access, title, detail });

  if (systemPerms.modifyAllData.length) addPath('All', 'Modify All Data', systemPerms.modifyAllData.join(', '));
  else if (systemPerms.viewAllData.length) addPath('Read', 'View All Data', systemPerms.viewAllData.join(', '));
  if (objPerms?.modifyAll.granted) addPath('All', `Modify All on ${objName}`, objPerms.modifyAll.sources.join(', '));
  else if (objPerms?.viewAll.granted) addPath('Read', `View All on ${objName}`, objPerms.viewAll.sources.join(', '));

  let owner = null;
  if (ownerId) {
    owner = { id: ownerId, name: principalName(ownerId) };
    if (ownerId === userId) addPath('All', 'Record owner', 'The user owns this record.');
    else if (groups.has(ownerId)) addPath('All', 'Member of the owning queue', `${owner.name} — ${groups.get(ownerId)}`);
    else if (userMap.has(ownerId) && isAbove(user.UserRoleId, userMap.get(ownerId).UserRoleId, roles)) {
      const ownerRole = roles.get(userMap.get(ownerId).UserRoleId)?.Name;
      addPath(
        'All',
        'Role hierarchy (above the owner)',
        `User's role "${user.UserRole?.Name}" is above the owner's role "${ownerRole}".` +
          (sobj.custom ? ' Applies only if "Grant Access Using Hierarchies" is enabled for this object.' : '')
      );
    }
  }

  const owd = entityDef && {
    internal: entityDef.InternalSharingModel,
    external: entityDef.ExternalSharingModel,
    internalLabel: OWD_LABELS[entityDef.InternalSharingModel] ?? entityDef.InternalSharingModel,
    externalLabel: OWD_LABELS[entityDef.ExternalSharingModel] ?? entityDef.ExternalSharingModel,
    appliesTo: isInternal ? 'internal' : 'external'
  };
  const applicableOwd = owd && (isInternal ? owd.internal : owd.external);
  if (OWD_ACCESS[applicableOwd]) {
    addPath(OWD_ACCESS[applicableOwd], 'Org-wide default', `${isInternal ? 'Internal' : 'External'} OWD is ${OWD_LABELS[applicableOwd]}.`);
  }

  for (const s of shares.filter((x) => x.applies && x.rowCause !== 'Owner')) {
    addPath(s.accessLevel, s.rowCauseLabel, `${s.sharedWith} — ${s.how}`);
  }

  let parent = null;
  if (applicableOwd?.startsWith('ControlledBy') || parentFields.length) {
    const field = parentFields.find((f) => record?.[f]);
    if (field) {
      const parentId = record[field];
      const parentObj = global.sobjects.find((s) => s.keyPrefix === parentId.slice(0, 3));
      parent = { field, id: parentId, object: parentObj?.name ?? 'Unknown' };
      if (applicableOwd?.startsWith('ControlledBy')) {
        addPath('Inherited', 'Controlled by parent', `Access follows the parent ${parent.object} (${parentId}) — inspect it for details.`);
      }
    }
  }

  // ---- Verdict -----------------------------------------------------------
  const allData = systemPerms.modifyAllData.length > 0;
  const viewData = allData || systemPerms.viewAllData.length > 0;
  const objOk = (k) => !objPerms || objPerms[k].granted || allData || (k === 'read' && viewData);
  const effective = ura && {
    read: ura.HasReadAccess && objOk('read'),
    edit: ura.HasEditAccess && objOk('edit'),
    delete: ura.HasDeleteAccess && objOk('delete')
  };
  if (ura?.HasReadAccess && !objOk('read')) {
    warnings.push(`Sharing grants access, but the user has no Read permission on ${objName}, so they cannot open the record.`);
  }
  if (ura?.HasReadAccess && !paths.length) {
    addPath('?', 'Other mechanism', 'Access exists but its source is not visible to you (e.g. territory, team, implicit/sharing-set access, or share rows hidden by your permissions).');
  }
  if (!user.IsActive) warnings.push('This user is inactive and cannot log in.');

  return {
    object: { name: objName, label: sobj.label, custom: sobj.custom },
    record: { id: recordId, name: record && nameField ? record[nameField] : null, owner, parent },
    user,
    owd,
    ura,
    effective,
    systemPerms,
    objPerms,
    shares,
    shareObj: shareExists ? shareObj : null,
    paths,
    warnings
  };
}

/** All groups the user effectively belongs to: direct, role-based, org-wide, and nested. Map<groupId, reason>. */
async function computeGroups(api, user, roles, isInternal) {
  const groups = new Map();
  const direct = await api.query(`SELECT GroupId, Group.Name FROM GroupMember WHERE UserOrGroupId = '${user.Id}'`);
  for (const m of direct) groups.set(m.GroupId, 'direct member');

  if (user.UserRoleId) {
    const ancestors = roleAncestors(user.UserRoleId, roles);
    const roleGroups = await api.queryIn(
      `SELECT Id, Type, RelatedId FROM Group WHERE Type IN (${ROLE_GROUP_TYPES.map((t) => `'${t}'`).join(',')}) AND RelatedId IN ({ids})`,
      ancestors
    );
    for (const g of roleGroups) {
      const own = g.RelatedId === user.UserRoleId;
      if (g.Type === 'Role' && own) groups.set(g.Id, "user's role");
      else if (g.Type === 'RoleAndSubordinates' || (g.Type === 'RoleAndSubordinatesInternal' && isInternal)) {
        groups.set(g.Id, own ? "user's role" : `subordinate of role "${roles.get(g.RelatedId)?.Name ?? g.RelatedId}"`);
      }
    }
  }

  if (isInternal) {
    for (const g of await api.query(`SELECT Id FROM Group WHERE Type = 'Organization'`)) groups.set(g.Id, 'all internal users');
  }

  // Groups can contain groups: walk upward until no new parents appear.
  let frontier = [...groups.keys()];
  for (let depth = 0; frontier.length && depth < 10; depth++) {
    const parents = await api.queryIn('SELECT GroupId, UserOrGroupId FROM GroupMember WHERE UserOrGroupId IN ({ids})', frontier);
    frontier = [];
    for (const p of parents) {
      if (!groups.has(p.GroupId)) {
        groups.set(p.GroupId, 'through a nested group the user belongs to');
        frontier.push(p.GroupId);
      }
    }
  }
  return groups;
}
