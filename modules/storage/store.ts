import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { Vault } from './vault.js';
import { requestSchema, commandSchema, type TaskInput, type TaskStatus } from '../contracts/index.js';
export class StoreError extends Error {constructor(public code: 'NOT_FOUND'|'CONFLICT'|'STALE_CLAIM'|'INVALID_INPUT'|'EXPIRED'|'CAPACITY'){super(code);}}
export interface Owner {userId:string; tenantId:string}
interface Row {id:string; user_id:string; tenant_id:string; conversation_id:string; sequence:number; status:TaskStatus; revision:number; generation:number; lease_until:number|null; worker_id:string|null; deadline:number|null; next_attempt_at:number; created_at:number; updated_at:number; input:Buffer; result:Buffer|null; payload_hash:string; attempts:number}
export interface Task {id:string; conversationId:string; sequence:number; status:TaskStatus; revision:number; generation:number; createdAt:number; updatedAt:number; input:TaskInput; result:unknown}
export interface Claim {task:Task;workerId:string;generation:number;leaseUntil:number}
const terminal=['completed','failed','cancelled','expired'];
export class Store {
 readonly db:Database.Database;
 constructor(path:string,private vault:Vault, private now:()=>number=Date.now){
  this.db=new Database(path);this.db.pragma('journal_mode = WAL');this.db.pragma('foreign_keys = ON');this.db.pragma('busy_timeout = 5000');this.db.pragma('secure_delete = ON');
  const version=this.db.pragma('user_version',{simple:true}) as number;
  if(version>1) {this.db.close();throw new Error('Unsupported database version');}
  this.db.transaction(()=>{
   this.db.exec(`
CREATE TABLE IF NOT EXISTS conversations(id TEXT NOT NULL,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,next_sequence INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(id,user_id,tenant_id));
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,conversation_id TEXT NOT NULL,sequence INTEGER NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,generation INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,worker_id TEXT,deadline INTEGER,next_attempt_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,input BLOB NOT NULL,result BLOB,payload_hash TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,UNIQUE(user_id,tenant_id,conversation_id,sequence));
CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(user_id,tenant_id,created_at);
CREATE INDEX IF NOT EXISTS tasks_claim ON tasks(status,next_attempt_at,lease_until);
CREATE TABLE IF NOT EXISTS dependencies(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,depends_on TEXT NOT NULL REFERENCES tasks(id),PRIMARY KEY(task_id,depends_on));
CREATE TABLE IF NOT EXISTS idempotency(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,PRIMARY KEY(user_id,tenant_id,key));
CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,revision INTEGER NOT NULL,type TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(task_id,revision));
CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,acknowledged_at INTEGER);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,generation INTEGER NOT NULL,worker_id TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,outcome TEXT,UNIQUE(task_id,generation));
`);this.db.pragma('user_version = 1');
  })();
 }
 private row(owner:Owner,id:string):Row {const row=this.db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=? AND tenant_id=?').get(id,owner.userId,owner.tenantId) as Row|undefined;if(!row)throw new StoreError('NOT_FOUND');return row;}
 private task(row:Row):Task {return {id:row.id,conversationId:row.conversation_id,sequence:row.sequence,status:row.status,revision:row.revision,generation:row.generation,createdAt:row.created_at,updatedAt:row.updated_at,input:this.vault.open(row.input,'task:'+row.id),result:row.result?this.vault.open(row.result,'result:'+row.id):null};}
 get(owner:Owner,id:string):Task {return this.task(this.row(owner,id));}
 list(owner:Owner,limit=50):Task[]{return (this.db.prepare('SELECT * FROM tasks WHERE user_id=? AND tenant_id=? ORDER BY created_at DESC,id LIMIT ?').all(owner.userId,owner.tenantId,Math.max(1,Math.min(limit,100))) as Row[]).map(r=>this.task(r));}
 private event(id:string,type:string){const r=this.db.prepare('SELECT revision FROM tasks WHERE id=?').get(id) as {revision:number};const eid=randomUUID();this.db.prepare('INSERT INTO events(id,task_id,revision,type,created_at) VALUES(?,?,?,?,?)').run(eid,id,r.revision,type,this.now());this.db.prepare('INSERT INTO outbox(event_id) VALUES(?)').run(eid);}
 create(owner:Owner,raw:unknown,key:string):Task {
  const input=requestSchema.parse(raw);if(!/^[A-Za-z0-9:_-]{1,128}$/.test(key))throw new StoreError('INVALID_INPUT');
  return this.db.transaction(()=>{
   const hash=this.vault.fingerprint(input);const previous=this.db.prepare('SELECT hash,task_id FROM idempotency WHERE user_id=? AND tenant_id=? AND key=?').get(owner.userId,owner.tenantId,key) as {hash:string;task_id:string}|undefined;
   if(previous){if(previous.hash!==hash)throw new StoreError('CONFLICT');return this.get(owner,previous.task_id);}
   const now=this.now(),deadline=input.deadline?Date.parse(input.deadline):null;if(deadline!==null&&deadline<=now)throw new StoreError('EXPIRED');
   for(const dep of input.dependencies)this.row(owner,dep);
   this.db.prepare('INSERT OR IGNORE INTO conversations(id,user_id,tenant_id) VALUES(?,?,?)').run(input.conversationId,owner.userId,owner.tenantId);
   const sequence=(this.db.prepare('UPDATE conversations SET next_sequence=next_sequence+1 WHERE id=? AND user_id=? AND tenant_id=? RETURNING next_sequence-1 AS sequence').get(input.conversationId,owner.userId,owner.tenantId) as {sequence:number}).sequence;
   const id=randomUUID();this.db.prepare('INSERT INTO tasks(id,user_id,tenant_id,conversation_id,sequence,status,deadline,created_at,updated_at,input,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,owner.userId,owner.tenantId,input.conversationId,sequence,'queued',deadline,now,now,this.vault.seal(input,'task:'+id),hash);
   for(const dep of new Set(input.dependencies))this.db.prepare('INSERT INTO dependencies VALUES(?,?)').run(id,dep);
   this.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)').run(owner.userId,owner.tenantId,key,hash,id);this.event(id,'created');return this.get(owner,id);
  }).immediate();
 }
 command(owner:Owner,id:string,raw:unknown):Task {const command=commandSchema.parse(raw);return this.db.transaction(()=>{
  const r=this.row(owner,id);if(r.revision!==command.expectedRevision||terminal.includes(r.status))throw new StoreError('CONFLICT');
  if(command.command==='resume'&&r.status!=='paused')throw new StoreError('CONFLICT');
  if(command.command==='pause'&&r.status==='paused')throw new StoreError('CONFLICT');
  const status=command.command==='cancel'?'cancelled':command.command==='pause'?'paused':'queued';
  this.db.prepare('UPDATE runs SET finished_at=?,outcome=? WHERE task_id=? AND finished_at IS NULL').run(this.now(),status,id);
  this.db.prepare('UPDATE tasks SET status=?,revision=revision+1,generation=generation+1,lease_until=NULL,worker_id=NULL,updated_at=? WHERE id=?').run(status,this.now(),id);this.event(id,status);return this.get(owner,id);
 }).immediate();}
 claim(owner:Owner,workerId:string,leaseMs=30_000):Claim|null {
  if(!workerId||leaseMs<100||leaseMs>300_000)throw new StoreError('INVALID_INPUT');
  return this.db.transaction(()=>{
   const now=this.now();
   const expired=this.db.prepare("SELECT id FROM tasks WHERE user_id=? AND tenant_id=? AND deadline<=? AND status NOT IN ('completed','failed','cancelled','expired')").all(owner.userId,owner.tenantId,now) as {id:string}[];
   for(const {id}of expired){this.db.prepare("UPDATE tasks SET status='expired',revision=revision+1,generation=generation+1,lease_until=NULL,worker_id=NULL,updated_at=? WHERE id=?").run(now,id);this.db.prepare("UPDATE runs SET finished_at=?,outcome='expired' WHERE task_id=? AND finished_at IS NULL").run(now,id);this.event(id,'expired');}
   const r=this.db.prepare(`SELECT t.* FROM tasks t WHERE user_id=? AND tenant_id=? AND (status='queued' OR(status='running' AND lease_until<=?)) AND next_attempt_at<=?
AND NOT EXISTS(SELECT 1 FROM tasks earlier WHERE earlier.user_id=t.user_id AND earlier.tenant_id=t.tenant_id AND earlier.conversation_id=t.conversation_id AND earlier.sequence<t.sequence AND earlier.status NOT IN ('completed','failed','cancelled','expired'))
AND NOT EXISTS(SELECT 1 FROM dependencies d JOIN tasks p ON p.id=d.depends_on WHERE d.task_id=t.id AND p.status!='completed') ORDER BY created_at,id LIMIT 1`).get(owner.userId,owner.tenantId,now,now) as Row|undefined;
   if(!r)return null;
   this.db.prepare("UPDATE runs SET finished_at=?,outcome='lease_expired' WHERE task_id=? AND finished_at IS NULL").run(now,r.id);
   this.db.prepare("UPDATE tasks SET status='running',revision=revision+1,generation=generation+1,lease_until=?,worker_id=?,updated_at=?,attempts=attempts+1 WHERE id=?").run(now+leaseMs,workerId,now,r.id);
   this.db.prepare('INSERT INTO runs(id,task_id,generation,worker_id,started_at) VALUES(?,?,?,?,?)').run(randomUUID(),r.id,r.generation+1,workerId,now);this.event(r.id,'claimed');
   return {task:this.get(owner,r.id),workerId,generation:r.generation+1,leaseUntil:now+leaseMs};
  }).immediate();
 }
 private validClaim(owner:Owner,id:string,worker:string,generation:number):Row {const r=this.row(owner,id);if(r.status!=='running'||r.worker_id!==worker||r.generation!==generation||(r.lease_until??0)<=this.now()||(r.deadline!==null&&r.deadline<=this.now()))throw new StoreError('STALE_CLAIM');return r;}
 heartbeat(owner:Owner,id:string,worker:string,generation:number,leaseMs=30_000){if(leaseMs<100||leaseMs>300_000)throw new StoreError('INVALID_INPUT');return this.db.transaction(()=>{this.validClaim(owner,id,worker,generation);this.db.prepare('UPDATE tasks SET lease_until=? WHERE id=?').run(this.now()+leaseMs,id);}).immediate();}
 complete(owner:Owner,id:string,worker:string,generation:number,result:unknown):Task {if(Buffer.byteLength(JSON.stringify(result)??'')>256_000)throw new StoreError('INVALID_INPUT');return this.db.transaction(()=>{
  this.validClaim(owner,id,worker,generation);this.db.prepare("UPDATE tasks SET status='completed',revision=revision+1,result=?,lease_until=NULL,worker_id=NULL,updated_at=? WHERE id=?").run(this.vault.seal(result,'result:'+id),this.now(),id);this.db.prepare("UPDATE runs SET finished_at=?,outcome='completed' WHERE task_id=? AND generation=?").run(this.now(),id,generation);this.event(id,'completed');return this.get(owner,id);
 }).immediate();}
 fail(owner:Owner,id:string,worker:string,generation:number,transient:boolean){return this.db.transaction(()=>{
  const r=this.validClaim(owner,id,worker,generation);const retry=transient&&r.attempts<3;
  this.db.prepare('UPDATE tasks SET status=?,revision=revision+1,lease_until=NULL,worker_id=NULL,next_attempt_at=?,updated_at=? WHERE id=?').run(retry?'queued':'failed',this.now()+1000*2**r.attempts,this.now(),id);
  this.db.prepare('UPDATE runs SET finished_at=?,outcome=? WHERE task_id=? AND generation=?').run(this.now(),retry?'retry':'failed',id,generation);this.event(id,retry?'retry_scheduled':'failed');return this.get(owner,id);
 }).immediate();}
 events(owner:Owner,after=0){return this.db.prepare('SELECT e.* FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.user_id=? AND t.tenant_id=? AND e.cursor>? ORDER BY cursor LIMIT 100').all(owner.userId,owner.tenantId,after);}
 pending(owner:Owner){return this.db.prepare('SELECT e.* FROM events e JOIN tasks t ON t.id=e.task_id JOIN outbox o ON o.event_id=e.id WHERE t.user_id=? AND t.tenant_id=? AND o.acknowledged_at IS NULL ORDER BY e.cursor LIMIT 100').all(owner.userId,owner.tenantId);}
 acknowledge(owner:Owner,eventId:string){this.db.prepare('UPDATE outbox SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE event_id=? AND event_id IN(SELECT e.id FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.user_id=? AND t.tenant_id=?)').run(this.now(),eventId,owner.userId,owner.tenantId);}
 export(owner:Owner){return (this.db.prepare('SELECT * FROM tasks WHERE user_id=? AND tenant_id=? ORDER BY created_at,id').all(owner.userId,owner.tenantId) as Row[]).map(r=>this.task(r));}
 deleteAll(owner:Owner){this.db.transaction(()=>{this.db.prepare('DELETE FROM dependencies WHERE task_id IN(SELECT id FROM tasks WHERE user_id=? AND tenant_id=?)').run(owner.userId,owner.tenantId);this.db.prepare('DELETE FROM tasks WHERE user_id=? AND tenant_id=?').run(owner.userId,owner.tenantId);this.db.prepare('DELETE FROM conversations WHERE user_id=? AND tenant_id=?').run(owner.userId,owner.tenantId);}).immediate();this.db.pragma('wal_checkpoint(TRUNCATE)');}
 async backup(destination:string){await this.db.backup(destination);}
 close(){this.db.close();}
}
