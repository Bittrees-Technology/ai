import test from 'node:test';
import assert from 'node:assert/strict';
import { requestSchema, remoteStatusSchema, authoritySchema } from '../modules/contracts/index.js';
import { isAuthorized, type Scope } from '../modules/domain/authority.js';
const actor = authoritySchema.parse({userId:'alice',subjectId:'alice',tenantId:'workspace',deviceId:'personal',sourceApp:'crm',grantId:'grant',policyRevision:'1'});
const scope: Scope = {userId:'alice',subjectId:'alice',tenantId:'workspace',sourceApp:'crm',expiresAt:200,revoked:false,delegationAllowed:true,actions:['read'],resourceIds:['selected']};
const scopes = () => ({source:{...scope},delegation:{...scope},connector:{...scope},policy:{...scope}});
test('authority is the intersection of all four independently verified scopes', () => {
  const action={app:'crm',resourceId:'selected',action:'read'};
  assert.equal(isAuthorized(actor,action,scopes(),100),true);
  for(const key of ['source','delegation','connector','policy'] as const){
    for(const patch of [{userId:'bob'},{subjectId:'bob'},{tenantId:'other'},{sourceApp:'mail'},{expiresAt:100},{revoked:true},{delegationAllowed:false},{actions:['send']},{resourceIds:['other']}]){
      const changed=scopes(); Object.assign(changed[key],patch);
      assert.equal(isAuthorized(actor,action,changed,100),false,`${key}: ${JSON.stringify(patch)}`);
    }
  }
});
test('strict request schema rejects caller authority and unbounded input',()=>{
 const body={conversationId:'c',kind:'query',prompt:'Hello',modelProfileId:'m'};
 assert.equal(requestSchema.safeParse(body).success,true);
 assert.equal(requestSchema.safeParse({...body,authority:actor}).success,false);
 assert.equal(requestSchema.safeParse({...body,prompt:'x'.repeat(32001)}).success,false);
});
test('remote status cannot carry prompts, titles, subjects or arbitrary errors',()=>{
 const base={id:'r',deviceId:'d',status:'queued',revision:1,updatedAt:'2026-09-21T00:00:00Z'};
 assert.equal(remoteStatusSchema.safeParse(base).success,true);
 for(const key of ['prompt','title','subject','memory','result','content','error']) assert.equal(remoteStatusSchema.safeParse({...base,[key]:'PRIVATE'}).success,false);
 assert.equal(remoteStatusSchema.safeParse({...base,errorCode:'PRIVATE'}).success,false);
});
