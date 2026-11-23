// Per-component-type knowledge: default action, what to do, links, delete support.

// action: 'delete' = component exists for the package, remove it (and keep scanning what blocks *its* delete)
//         'modify' = shared component, just remove the reference
export const TYPE_INFO = {
  CustomField:           { action: 'delete', tip: 'Delete the field. If the uninstall still complains, erase it from the object\'s "Deleted Fields" list (deleted fields can still block).' },
  ValidationRule:        { action: 'delete', tip: 'Delete the rule, or edit its formula to drop the package field.' },
  WorkflowRule:          { action: 'delete', tip: 'Deactivate, then delete. Check the rule criteria and its actions.' },
  WorkflowFieldUpdate:   { action: 'delete', tip: 'Remove it from every workflow rule that uses it, then delete.' },
  WorkflowAlert:         { action: 'delete', tip: 'Remove it from workflow rules / processes, then delete.' },
  WorkflowOutboundMessage: { action: 'delete', tip: 'Remove it from workflow rules, then delete.' },
  Flow:                  { action: 'delete', tip: 'Deactivate and delete EVERY version, including old inactive ones. Any old version still referencing the package blocks the uninstall.' },
  CustomTab:             { action: 'delete', tip: 'Delete the tab (remove it from apps first).' },
  FieldSet:              { action: 'delete', tip: 'Delete the field set, or remove the package field from it.' },
  WebLink:               { action: 'delete', tip: 'Remove the button/link from layouts, then delete it.' },
  ApexClass:             { action: 'modify', tip: 'Remove the reference in a sandbox and deploy. Apex can\'t be edited or deleted directly in production — use the destructive deploy if the class should go.' },
  ApexTrigger:           { action: 'modify', tip: 'Remove the reference (or delete the trigger) in a sandbox and deploy. In production use the destructive deploy.' },
  ApexPage:              { action: 'modify', tip: 'Edit the Visualforce page to remove the package reference, or delete it.' },
  ApexComponent:         { action: 'modify', tip: 'Edit the Visualforce component to remove the package reference, or delete it.' },
  LightningComponentBundle: { action: 'modify', tip: 'Edit the LWC source (VS Code / SFDX) and deploy, or delete via destructive deploy.' },
  AuraDefinitionBundle:  { action: 'modify', tip: 'Edit the Aura bundle source and deploy, or delete via destructive deploy.' },
  Layout:                { action: 'modify', tip: 'Edit the page layout: remove the package field, related list or button, then save.' },
  FlexiPage:             { action: 'modify', tip: 'Open Lightning App Builder, remove the package component/field, save and re-activate.' },
  CompactLayout:         { action: 'modify', tip: 'Remove the package field from the compact layout.' },
  RecordType:            { action: 'modify', tip: 'Remove package picklist values / assignments from the record type.' },
  QuickActionDefinition: { action: 'modify', tip: 'Remove the package field from the action layout, or delete the action.' },
  PermissionSet:         { action: 'modify', tip: 'Remove the package object/field/class permissions from this permission set.' },
  Profile:               { action: 'modify', tip: 'Remove the package permissions from this profile.' },
  Report:                { action: 'modify', tip: 'Edit the report: remove the field from columns, filters, groupings, buckets and cross filters, then save. Or delete the report.' },
  Dashboard:             { action: 'modify', tip: 'Remove the dashboard component(s) that use the report being deleted, or delete the dashboard. Must happen before the report delete.' },
  ReportType:            { action: 'modify', tip: 'Edit the custom report type: remove the package object/fields from its relationships and field layout. Or delete it (its reports go with it).' },
  ListView:              { action: 'modify', tip: 'Remove the package field from the list view columns and filters, or delete the list view.' },
  EmailTemplate:         { action: 'modify', tip: 'Remove merge fields that reference the package, or delete the template.' },
  CustomObject:          { action: 'modify', tip: 'Remove the reference from the object (lookup, formula, setting).' },
  GlobalValueSet:        { action: 'modify', tip: 'Remove the package reference from the value set.' },
  StaticResource:        { action: 'modify', tip: 'Remove the package reference, or delete the static resource.' }
};

const DEFAULT_INFO = { action: 'modify', tip: 'Open the component and remove its reference to the package.' };

export const typeInfo = t => TYPE_INFO[t] || DEFAULT_INFO;

export const OTHER_PACKAGE_TIP = ns =>
  `This belongs to another installed package${ns ? ` (${ns})` : ''} that depends on this one. Uninstall that package first.`;

// Ordering tie-break: lower = fix earlier when nothing else decides.
export const TYPE_RANK = [
  'ApexTrigger', 'ApexClass', 'ApexPage', 'ApexComponent', 'LightningComponentBundle', 'AuraDefinitionBundle',
  'Flow', 'WorkflowRule', 'WorkflowFieldUpdate', 'WorkflowAlert', 'WorkflowOutboundMessage', 'ValidationRule',
  'Dashboard', 'Report', 'ReportType', 'ListView', 'EmailTemplate', 'FlexiPage', 'Layout', 'CompactLayout', 'QuickActionDefinition',
  'WebLink', 'RecordType', 'FieldSet', 'CustomTab', 'PermissionSet', 'Profile', 'CustomField', 'CustomObject'
];
export const typeRank = t => { const i = TYPE_RANK.indexOf(t); return i < 0 ? TYPE_RANK.length : i; };

// Dependency-API type -> Tooling sObject name (when they differ).
export const TOOLING_SOBJECT = { QuickActionDefinition: 'QuickActionDefinition' };

// Dependency-API type -> Metadata API type for destructiveChanges.xml.
const METADATA_TYPE = { QuickActionDefinition: 'QuickAction' };
export const metadataType = t => METADATA_TYPE[t] || t;

// Types we can put in destructiveChanges.xml (needs a correct fullName).
export const DESTRUCTIVE_TYPES = new Set([
  'CustomField', 'ValidationRule', 'WorkflowRule', 'WorkflowFieldUpdate', 'WorkflowAlert', 'WorkflowOutboundMessage',
  'Flow', 'ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent', 'Layout', 'FlexiPage', 'CustomTab',
  'LightningComponentBundle', 'AuraDefinitionBundle', 'StaticResource', 'RecordType', 'CompactLayout',
  'QuickActionDefinition', 'FieldSet', 'WebLink', 'ListView', 'CustomObject', 'Report', 'Dashboard', 'ReportType'
]);

// Types we can delete right now via API (Apex only outside production).
export const DIRECT_DELETE = new Set([
  'CustomField', 'ValidationRule', 'WorkflowRule', 'WorkflowFieldUpdate', 'WorkflowAlert', 'Flow',
  'FlexiPage', 'Layout', 'Report', 'Dashboard', 'ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent'
]);
export const APEX_TYPES = new Set(['ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent']);

const OBJECT_DOT = new Set(['CustomField', 'ValidationRule', 'RecordType', 'CompactLayout', 'FieldSet', 'WorkflowRule',
  'WorkflowFieldUpdate', 'WorkflowAlert', 'WorkflowOutboundMessage', 'ListView', 'WebLink', 'QuickActionDefinition']);

export function objectFromFullName(type, fullName) {
  if (!fullName) return null;
  if (type === 'Layout') return fullName.split('-')[0];
  if (OBJECT_DOT.has(type) && fullName.includes('.')) return fullName.split('.')[0];
  return null;
}

// Direct links into Setup for a node. Returns [{label, url}].
export function linksFor(base, n) {
  const id = n.id;
  const setup = (page, rid = id) => `${base}/lightning/setup/${page}/page?address=${encodeURIComponent('/' + rid)}`;
  const om = n.objectName ? `${base}/lightning/setup/ObjectManager/${encodeURIComponent(n.objectName)}` : null;
  const open = url => [{ label: 'Open', url }];
  switch (n.type) {
    case 'CustomField':
      return open(om ? `${om}/FieldsAndRelationships/${id}/view` : `${base}/${id}`);
    case 'ValidationRule': return open(om ? `${om}/ValidationRules/${id}/view` : `${base}/${id}`);
    case 'Layout':         return open(om ? `${om}/PageLayouts/${id}/view` : `${base}/${id}`);
    case 'RecordType':     return open(om ? `${om}/RecordTypes/${id}/view` : `${base}/${id}`);
    case 'CompactLayout':  return open(om ? `${om}/CompactLayouts/${id}/view` : `${base}/${id}`);
    case 'FieldSet':       return open(om ? `${om}/FieldSets/${id}/view` : `${base}/${id}`);
    case 'WebLink':        return open(om ? `${om}/ButtonsLinksActions/${id}/view` : `${base}/${id}`);
    case 'ApexClass':      return open(setup('ApexClasses'));
    case 'ApexTrigger':    return open(setup('ApexTriggers'));
    case 'ApexPage':       return open(setup('ApexPages'));
    case 'ApexComponent':  return open(setup('ApexComponents'));
    case 'Flow': {
      const out = [{ label: 'Open', url: `${base}/builder_platform_interaction/flowBuilder.app?flowId=${id}` }];
      out.push({ label: 'All versions', url: n.definitionId ? setup('Flows', n.definitionId) : `${base}/lightning/setup/Flows/home` });
      return out;
    }
    case 'FlexiPage':      return open(`${base}/visualEditor/appBuilder.app?id=${id}`);
    case 'WorkflowRule':   return open(setup('WorkflowRules'));
    case 'WorkflowFieldUpdate': return open(setup('WorkflowFieldUpdates'));
    case 'WorkflowAlert':  return open(setup('WorkflowEmails'));
    case 'PermissionSet':  return open(setup('PermSets'));
    case 'Profile':        return open(setup('EnhancedProfiles'));
    case 'CustomTab':      return open(setup('CustomTabs'));
    case 'StaticResource': return open(setup('StaticResources'));
    case 'Report':         return [{ label: 'Open', url: `${base}/lightning/r/Report/${id}/view` }, { label: 'Edit', url: `${base}/lightning/r/Report/${id}/edit` }];
    case 'ReportType':     return open(/^070/.test(id) ? setup('CustomReportTypes') : `${base}/lightning/setup/CustomReportTypes/home`);
    case 'Dashboard':      return open(`${base}/lightning/r/Dashboard/${id}/view`);
    case 'ListView':       return open(n.objectName ? `${base}/lightning/o/${encodeURIComponent(n.objectName)}/list?filterName=${id}` : `${base}/${id}`);
    case 'LightningComponentBundle': return open(`${base}/lightning/setup/LightningComponentBundles/home`);
    default:               return open(`${base}/${id}`);
  }
}
