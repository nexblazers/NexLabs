import { Scanner, planOrder, defaultAction, reportTypeTouches } from '../lib/engine.js';
import { destructiveXml } from '../lib/zip.js';
import assert from 'assert';

const R = (id,type,name,ns,rid,rtype,rname,rns='') => ({MetadataComponentId:id,MetadataComponentType:type,MetadataComponentName:name,MetadataComponentNamespace:ns,RefMetadataComponentId:rid,RefMetadataComponentType:rtype,RefMetadataComponentName:rname,RefMetadataComponentNamespace:rns});
const mcd = [ R('F1','CustomField','Total','', 'P1','CustomField','Amount','acme') ];
const reports = [
  {Id:'R1', Name:'Pipeline by Total', DeveloperName:'Pipeline_by_Total', OwnerId:'00lSALES', NamespacePrefix:null, ReportTypeApiName:'Opportunity'},
  {Id:'R2', Name:'Invoice Aging', DeveloperName:'Invoice_Aging', OwnerId:'00DORG', NamespacePrefix:null, ReportTypeApiName:'Invoices_with_Lines__c'},
  {Id:'R3', Name:'Big Deals', DeveloperName:'Big_Deals', OwnerId:'005ME', NamespacePrefix:null, ReportTypeApiName:'Opportunity'},
  {Id:'R4', Name:'Clean report', DeveloperName:'Clean', OwnerId:'00lSALES', NamespacePrefix:null, ReportTypeApiName:'AccountList'},
  {Id:'R5', Name:'Pkg own report', DeveloperName:'Pkg', OwnerId:'00lSALES', NamespacePrefix:'acme', ReportTypeApiName:'CustomEntity$acme__Invoice__c'},
  {Id:'R6', Name:'Products with Amount', DeveloperName:'Products', OwnerId:'00lSALES', NamespacePrefix:null, ReportTypeApiName:'OpportunityProduct'},
  ...Array.from({length:500}, (_,i)=>({Id:'L'+i, Name:'Lead report '+i, DeveloperName:'Lead_'+i, OwnerId:'00lSALES', NamespacePrefix:null, ReportTypeApiName: i%2?'LeadList':'CaseList'}))
];
const describe = {
  R1: {reportType:{type:'Opportunity'}, detailColumns:['OPPORTUNITY_NAME','Opportunity.Total__c']},
  R2: {reportType:{type:'Invoices_with_Lines'}, detailColumns:['Invoices_with_Lines$Name']},
  R3: {reportType:{type:'Opportunity'}, reportFilters:[{column:'Opportunity.acme__Amount__c', operator:'greaterThan', value:'1000'}]},
  R4: {reportType:{type:'Account'}, detailColumns:['ACCOUNT.NAME']},
  R5: {reportType:{type:'acme__Invoice__c'}, detailColumns:['acme__Invoice__c.Name']},
  R6: {reportType:{type:'OpportunityProduct'}, detailColumns:['Opportunity.acme__Amount__c']},
};
let describes = 0;
const sf = {
  dataPath:'/services/data/v62.0',
  async tooling(q){ let m;
    if ((m=q.match(/RefMetadataComponentNamespace = '(\w+)'/))) return mcd.filter(r=>r.RefMetadataComponentNamespace===m[1]);
    if (/MetadataComponentDependency/.test(q)) return [];
    if ((m=q.match(/WHERE Id = '(\w+)'/))) return m[1]==='F1'?[{Id:'F1',FullName:'Opportunity.Total__c'}]:[];
    if (q.includes('FROM EntityDefinition')) return [{QualifiedApiName:'acme__Invoice__c'}];
    if (q.includes('FROM CustomField WHERE NamespacePrefix')) return [{TableEnumOrId:'Opportunity'},{TableEnumOrId:'01I000INV'}];
    if (q.includes('FROM CustomObject')) return [{Id:'01I000INV', DeveloperName:'Invoice', NamespacePrefix:'acme'}];
    return []; },
  async query(q){
    if (q.includes('FROM Report ORDER')) return reports;
    if (q.includes('FROM Folder')) return [{Id:'00lSALES', DeveloperName:'Sales_Reports'},{Id:'00lDASH', DeveloperName:'Exec_Dashboards'}];
    if (q.includes('FROM DashboardComponent')) return q.includes("'R2'") ? [{Id:'C1', DashboardId:'D1', CustomReportId:'R2'}] : [];
    if (q.includes('FROM Dashboard ')) return [{Id:'D1', Title:'Finance Overview', DeveloperName:'Finance_Overview', FolderId:'00lDASH', NamespacePrefix:null}];
    return []; },
  async req(path){
    if (path.includes('/sobjects/')) { const o = path.split('/sobjects/')[1].split('/')[0];
      return {childRelationships: o==='Opportunity' ? [{childSObject:'OpportunityLineItem'},{childSObject:'OpportunityHistory'}] : o==='acme__Invoice__c' ? [{childSObject:'acme__Line__c'}] : []}; }
    describes++; const id = path.split('/reports/')[1].split('/')[0]; return {reportMetadata: describe[id] || {reportType:{type:'x'}}}; },
  async listMetadata(){ return [{fullName:'Invoices_with_Lines', id:'070X', namespacePrefix:''},{fullName:'Accounts_Plain', id:'070Y', namespacePrefix:''}]; },
  async readMetadata(t, names){ return [
    {fullName:'Invoices_with_Lines', xml:'<records><fullName>Invoices_with_Lines</fullName><baseObject>acme__Invoice__c</baseObject></records>'},
    {fullName:'Accounts_Plain', xml:'<records><fullName>Accounts_Plain</fullName><baseObject>Account</baseObject></records>'} ]; }
};
const sc = new Scanner(sf, ()=>{});
const ctx = {mode:'managed', ns:'acme'};
const overrides = {};
const actionOf = n => overrides[n.id] || defaultAction(n, ctx);
const l1 = await sc.managedLevel1('acme');

async function rebuild(){
  let extra = [], nodes;
  const sig = rows => rows.map(r => `${r.id}:${[...r.refs].sort()}:${r.suggested||''}`).sort().join('|');
  for (let pass=0; pass<5; pass++){
    nodes = await sc.build({level1Rows:l1, textRows:extra, actionOf});
    await sc.enrich(nodes);
    const next = await sc.analyticsRows(nodes, {ns:'acme', actionOf});
    if (sig(next)===sig(extra)) break; extra = next;
  }
  return nodes;
}
let nodes = await rebuild();
let plan = planOrder(nodes, actionOf);
const show = () => plan.map(g=>g.ids.map(id=>{const n=nodes.get(id);return `${n.type}:${n.name} L${n.level} ${actionOf(n)} ${n.fullName||''}`}).join(' + ')).join('\n');
console.log(show());
const pos = id => plan.findIndex(g=>g.ids.includes(id));
assert.ok(nodes.has('R1') && nodes.get('R1').refs.has('F1'), 'R1 tied to deleted field');
assert.ok(pos('R1') < pos('F1'), 'report before field delete');
assert.equal(actionOf(nodes.get('070X')), 'delete', 'CRT on package object -> delete');
assert.equal(actionOf(nodes.get('R2')), 'delete', 'report on deleted CRT -> delete');
assert.ok(nodes.has('D1') && pos('D1') < pos('R2') && pos('R2') < pos('070X'), 'dashboard -> report -> report type order');
assert.ok(nodes.has('R3') && actionOf(nodes.get('R3'))==='modify', 'filter on package field -> modify');
assert.ok(!nodes.has('R4') && !nodes.has('R5') && !nodes.has('070Y'), 'clean / package-own excluded');
assert.equal(nodes.get('R1').fullName, 'Sales_Reports/Pipeline_by_Total');
assert.equal(nodes.get('R2').fullName, 'unfiled$public/Invoice_Aging');
assert.equal(nodes.get('R3').fullName, null, 'private folder');
assert.equal(nodes.get('D1').fullName, 'Exec_Dashboards/Finance_Overview');
// toggling R1 to delete should pull in dashboards for it (none) and keep the order
overrides['R1']='delete'; nodes = await rebuild(); plan = planOrder(nodes, actionOf);
assert.equal(actionOf(nodes.get('R1')), 'delete');
const items = [...nodes.values()].filter(n=>actionOf(n)==='delete' && n.fullName).map(n=>({type:n.type, fullName:n.fullName}));
console.log(destructiveXml(items,'62.0'));
console.log('report describes:', describes);
assert.ok(describes <= 5, 'only related reports read (R1,R2,R3,R6), not the 500 Lead/Case or Account reports');
assert.ok(nodes.has('R6'), 'child-object report (OpportunityProduct) found');
assert.ok(reportTypeTouches('AccountCustomEntity$acme__Invoice__c', new Set(['acme__Invoice__c']), null));
assert.ok(!reportTypeTouches('LeadList', new Set(['Opportunity','acme__Invoice__c']), 'acme'));
assert.ok(reportTypeTouches('Activity', new Set(['Task']), null));
// "all" scope reads everything (bounded by cap)
const sc2 = new Scanner(sf, ()=>{}); describes = 0;
const n2 = await sc2.build({level1Rows:l1, actionOf}); await sc2.enrich(n2);
await sc2.analyticsRows(n2, {ns:'acme', actionOf, reportScope:'all', reportCap:100});
assert.equal(describes, 100, 'all scope honours cap');
console.log('ANALYTICS OK');
