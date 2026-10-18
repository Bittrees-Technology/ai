import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,generateKeyPairSync,sign} from 'node:crypto';
import {createProjectAdministration} from '../shared/project-administration/portal.mjs';
import {seal,cookie} from '../shared/sso/client.mjs';
import {ecosystemDecisionMessage} from '../shared/ecosystem-authority.mjs';
const keys=generateKeyPairSync('ed25519'),source=generateKeyPairSync('ed25519'),secret='a'.repeat(64),origin='https://ai.bittrees.org';
const env={BITTREES_ADMIN_SSO_CLIENT_SECRET:secret,ROLES_ECOSYSTEM_REQUEST_PRIVATE_KEY:source.privateKey.export({type:'pkcs8',format:'pem'}),ROLES_ECOSYSTEM_DECISION_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'pem'})};
function session(identity){const sessionSecret=createHmac('sha256',secret).update('bittrees project administration session v1:'+origin).digest('hex');return cookie('project-admin-session',seal({project:'ai',identity,authTime:Date.now(),key:'test-session',expires:Date.now()+60000},sessionSecret),60,origin).split(';')[0];}
for(const identity of ['0x'+'1'.repeat(40),'verified@example.test'])test('AI authority rechecks grants and revocation for '+(identity.startsWith('0x')?'wallet':'verified email'),async()=>{
 let actions=['project.admin'];
 const handler=createProjectAdministration('ai',{env,fetcher:async(url,init)=>{assert.equal(String(url),'https://roles.bittrees.org/api/authority/ecosystem-decision');const{request}=JSON.parse(init.body),now=Date.now(),decision={version:1,issuer:'https://roles.bittrees.org',audience:request.source,request,enrolled:true,authoritative:true,actions,checkedAt:now,expiresAt:now+5000,requiresPrivateOwnership:true};return Response.json({decision,signature:sign(null,Buffer.from(ecosystemDecisionMessage(decision)),keys.privateKey).toString('base64')});}});
 const read=()=>handler(new Request(origin+'/api/project-admin/status',{headers:{cookie:session(identity)}}));
 assert.equal((await read()).status,200);actions=[];assert.equal((await read()).status,403);actions=['tier.partner'];assert.equal((await read()).status,403);
 assert.equal((await handler(new Request(origin+'/api/project-admin/status'))).status,401);
});
