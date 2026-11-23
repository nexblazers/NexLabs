import { Scanner, planOrder, defaultAction } from '../lib/engine.js';
import { destructiveXml, destructiveZip } from '../lib/zip.js';
import { to18, parseCSV } from '../lib/util.js';
import { writeFileSync } from 'fs';
import assert from 'assert';

// Mock org: package ns "acme"; field acme__Amount__c (P1)
// Total__c (F1) formula refs P1  -> delete -> referenced by Flow (FL1) and Layout (L1)
// Flow FL1 -> referenced by Apex TotalsHelper (A1)
// Apex A2 and A3 reference each other, A2 refs P1 (cycle if both deleted)
// Other package "zed" component refs P1
const R = (id,type,name,ns,rid,rtype,rname,rns='') => ({MetadataComponentId:id,MetadataComponentType:type,MetadataComponentName:name,MetadataComponentNamespace:ns,RefMetadataComponentId:rid,RefMetadataComponentType:rtype,RefMetadataComponentName:rname,RefMetadataComponentNamespace:rns});
const data = [
  R('F1','CustomField','Total','', 'P1','CustomField','Amount','acme'),
  R('VR1','ValidationRule','Check_Amount','', 'P1','CustomField','Amount','acme'),
  R('L0','Layout','Opportunity Layout','', 'P1','CustomField','Amount','acme'),
  R('A2','ApexClass','Svc','', 'P1','CustomField','Amount','acme'),
  R('Z1','ApexClass','ZedThing','zed', 'P1','CustomField','Amount','acme'),
  R('PK1','ApexClass','InsidePkg','acme', 'P1','CustomField','Amount','acme'),
  R('FL1','Flow','Update_Totals','', 'F1','CustomField','Total'),
  R('L1','Layout','Opportunity Layout','', 'F1','CustomField','Total'),
  R('A1','ApexClass','TotalsHelper','', 'FL1','Flow','Update_Totals'),
  R('A3','ApexClass','Svc2','', 'A2','ApexClass','Svc'),
  R('A2','ApexClass','Svc','', 'A3','ApexClass','Svc2'),
];
let calls=0;
const sf = { calls:0, async tooling(soql){ calls++;
  let m;
  if ((m = soql.match(/RefMetadataComponentNamespace = '(\w+)'/))) return data.filter(r=>r.RefMetadataComponentNamespace===m[1]);
  if ((m = soql.match(/RefMetadataComponentId IN \(([^)]*)\)/))) { const ids = m[1].split(',').map(s=>s.replace(/'/g,'')); return data.filter(r=>ids.includes(r.RefMetadataComponentId)); }
  if ((m = soql.match(/RefMetadataComponentId = '(\w+)'/))) return data.filter(r=>r.RefMetadataComponentId===m[1]);
  if ((m = soql.match(/FROM (\w+) WHERE Id = '(\w+)'/))) {
    const full = { F1:'Opportunity.Total__c', VR1:'Opportunity.Check_Amount', L0:'Opportunity-Opportunity Layout', L1:'Opportunity-Opportunity Layout', A1:'TotalsHelper', A2:'Svc', A3:'Svc2'}[m[2]];
    if (m[1]==='Flow') return [{Id:m[2], DefinitionId:'300X', VersionNumber:2, Status:'Active', Definition:{DeveloperName:'Update_Totals'}}];
    return full ? [{Id:m[2], FullName: full}] : [];
  }
  return [];
}};
const sc = new Scanner(sf, ()=>{});
const ctx = {mode:'managed', ns:'acme'};
const overrides = {};
const actionOf = n => overrides[n.id] || defaultAction(n, ctx);

const l1 = await sc.managedLevel1('acme');
assert.ok(!l1.find(r=>r.MetadataComponentId==='PK1'), 'internal package rows filtered');
let nodes = await sc.build({level1Rows:l1, actionOf, textRows:[{id:'EM1',type:'EmailTemplate',name:'Quote mail',matches:new Set(['acme__Amount__c'])}]});
await sc.enrich(nodes);
let plan = planOrder(nodes, actionOf);
const show = p => p.map(g => (g.cycle?'[CYCLE] ':'') + g.ids.map(id=>{const n=nodes.get(id); return `${n.type}:${n.name}(L${n.level},${actionOf(n)})`}).join(' + '));
console.log('--- default plan'); console.log(show(plan).join('\n'));
const pos = id => plan.findIndex(g=>g.ids.includes(id));
assert.ok(pos('A1') < pos('FL1') && pos('FL1') < pos('F1') && pos('L1') < pos('F1'), 'chain order');
assert.equal(actionOf(nodes.get('Z1')), 'other-package');
assert.equal(nodes.get('F1').fullName, 'Opportunity.Total__c');
assert.equal(nodes.get('F1').objectName, 'Opportunity');
assert.ok(!nodes.has('A3'), 'A2 is modify by default -> A3 not discovered');

// Toggle A2 to delete -> discovers A3 -> cycle
overrides['A2']='delete'; overrides['A3']='delete';
nodes = await sc.build({level1Rows:l1, actionOf});
plan = planOrder(nodes, actionOf);
console.log('--- after marking Svc delete'); console.log(show(plan).join('\n'));
assert.ok(plan.some(g=>g.cycle && g.ids.includes('A2') && g.ids.includes('A3')), 'cycle grouped');

// unmanaged-style targets
const nodes2 = await sc.build({targets:[{id:'P1',type:'CustomField',name:'Amount',fullName:'Opportunity.acme__Amount__c'}], level1Rows: await sc.referrersOf(['P1']), actionOf: n=>defaultAction(n,{mode:'unmanaged'})});
const plan2 = planOrder(nodes2, n=>defaultAction(n,{mode:'unmanaged'}));
assert.equal(plan2[plan2.length-1].ids[0], 'P1', 'target last');

const xml = destructiveXml([{type:'CustomField',fullName:'Opportunity.Total__c'},{type:'Flow',fullName:'Update_Totals'},{type:'QuickActionDefinition',fullName:'Account.Do'}], '62.0');
console.log(xml);
writeFileSync('./out.zip', destructiveZip([{type:'CustomField',fullName:'Opportunity.Total__c'}], '62.0'));
assert.equal(to18('001A0000006Vm9r'), '001A0000006Vm9rIAC');
assert.deepEqual(parseCSV('a,b\n"x,1","y""z"\n'), [{a:'x,1',b:'y"z'}]);
console.log('ALL OK, mock calls', calls);
