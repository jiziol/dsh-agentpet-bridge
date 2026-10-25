import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtemp, lstat, rm, chmod, symlink } from 'node:fs/promises'
import { Observer, resultOf, baselineEvents } from '../lib/observer.js'
import { NavigationHub, Publisher, privateSocketDirectory, Mailbox } from '../lib/transport.js'
import { TYPERT } from '../lib/typert.host.js'
import { TYPERT_REMOTE } from '../lib/typert.remote-client.js'

const session = { id: 'native-A', header: { title: 'Fixture', cwd: '/tmp/fixture' } }
const fixture = (path = '/tmp/profile-A') => {
  const frames = []; const observer = new Observer(path, frame => frames.push(frame), () => 100000)
  return { frames, observer }
}
const start = (observer, seq = 1, turn = 1) => observer.consume(session, { type: 'turn/start', seq, time: 100000, data: { turn } })

test('long-history baseline retains current turn and metadata within a bounded fold', () => {
  const events = [{ type: 'session/title', seq: 0, data: { title: 'Long task' } },
    { type: 'turn/start', seq: 1, time: 100000, data: { turn: 7 } },
    { type: 'request/header', seq: 2, data: { header: { config: { model: 'fixture-model' } } } }]
  for (let seq = 3; seq < 4000; seq++) events.push({ type: 'assistant/message', seq, data: { text: 'private' } })
  const { observer } = fixture()
  const baseline = baselineEvents(events)
  assert.ok(baseline.length <= 2052)
  for (const event of baseline) observer.consume(session, event, true, false)
  assert.equal(observer.rows.get(session.id).turn, 7)
  assert.equal(observer.rows.get(session.id).phase, 'working')
  assert.equal(observer.rows.get(session.id).title, 'Long task')
  assert.equal(observer.rows.get(session.id).model, 'fixture-model')
})

test('leaving an ambiguous Client set requests a fresh unique-client pending snapshot', () => {
  const { observer } = fixture(); const hub = new NavigationHub(observer)
  const frames = []; const releaseA = hub.register('client-A', frame => { frames.push(frame); return true })
  const releaseB = hub.register('client-B', () => true)
  assert.equal(frames.length, 0)
  releaseB(); assert.equal(frames.at(-1).kind, 'resync')
  assert.equal(frames.at(-1).generation, hub.clients.get('client-A').generation)
  releaseA()
})

test('native result mapping separates user stop from other abort causes', () => {
  assert.equal(resultOf({kind:'completed'}), 'completed')
  assert.equal(resultOf({kind:'error'}), 'failed')
  assert.equal(resultOf({kind:'aborted',reason:{kind:'user'}}), 'cancelled')
  for (const kind of ['parent','hook','disposed','legacy']) assert.equal(resultOf({kind:'aborted',reason:{kind}}), 'unknown')
  for (const kind of ['blocked','interrupted','forked','max-tokens']) assert.equal(resultOf({kind}), 'unknown')
})
test('ordered fold ignores duplicate and mismatched turn endings', () => {
  const {observer,frames}=fixture(); start(observer,2)
  observer.consume(session,{type:'turn/end',seq:1,time:100100,data:{turn:1,reason:{kind:'completed'}}})
  observer.consume(session,{type:'turn/end',seq:3,time:100100,data:{turn:2,reason:{kind:'completed'}}})
  assert.equal(frames.length,1); assert.equal(observer.rows.get(session.id).phase,'working')
})
test('tool labels and model metadata never expose arguments or messages', () => {
  const {observer,frames}=fixture(); start(observer)
  observer.consume(session,{type:'tool/call',seq:2,time:100100,data:{turn:1,name:'bash',arguments:'SECRET'}})
  observer.consume(session,{type:'assistant/message',seq:3,time:100200,data:{text:'PRIVATE'}})
  observer.consume(session,{type:'request/header',seq:4,time:100300,data:{header:{config:{model:'test-model',apiKey:'SECRET'}}}})
  assert.equal(frames.at(-1).model,'test-model'); assert.match(frames[1].message,/bash/)
  assert.doesNotMatch(JSON.stringify(frames),/SECRET|PRIVATE|arguments|apiKey/)
})
test('approval asked alone is never orange; explicit pending is retained and resolved', () => {
  const {observer,frames}=fixture(); start(observer)
  observer.consume(session,{type:'approval/asked',seq:2,time:100100,data:{requestId:'auto'}})
  assert.equal(frames.length,1)
  observer.pending(session.id,{id:'question:one',kind:'choice'}); assert.equal(frames.at(-1).dsh.pending.length,1)
  observer.pending(session.id,null); assert.deepEqual(frames.at(-1).dsh.pending,[])
})
test('user cancellation clears pending; late tool events cannot revive it', () => {
  const {observer,frames}=fixture(); start(observer); observer.pending(session.id,{id:'q',kind:'reply'})
  observer.consume(session,{type:'turn/end',seq:2,time:100100,data:{turn:1,reason:{kind:'aborted',reason:{kind:'user'}}}})
  observer.consume(session,{type:'tool/result',seq:3,time:100200,data:{turn:1}})
  observer.pending(session.id,{id:'q',kind:'reply'})
  assert.equal(frames.at(-1).dsh.result,'cancelled'); assert.deepEqual(frames.at(-1).dsh.pending,[])
  start(observer,4,2); assert.equal(frames.at(-1).dsh.phase,'working')
})
test('completed timed question stays waiting until native pending clears', () => {
  const {observer,frames}=fixture(); start(observer); observer.pending(session.id,{id:'q',kind:'choice'})
  observer.consume(session,{type:'turn/end',seq:2,time:100100,data:{turn:1,reason:{kind:'completed'}}})
  assert.equal(frames.at(-1).dsh.pending[0].id,'q')
  observer.pending(session.id,null); assert.deepEqual(frames.at(-1).dsh.pending,[])
})
test('profiles isolate the same native session and Host restarts get fresh identity', () => {
  const a=fixture(),b=fixture('/tmp/profile-B'),c=fixture(); start(a.observer); start(b.observer); start(c.observer)
  assert.notEqual(a.frames[0].sessionId,b.frames[0].sessionId)
  assert.equal(a.frames[0].sessionId,c.frames[0].sessionId); assert.notEqual(a.observer.hostID,c.observer.hostID)
})
test('heartbeat and rebaseline mark recovery without inventing event boundaries', () => {
  const {observer,frames}=fixture(); start(observer); observer.heartbeat(); observer.rebaseline(true)
  assert.equal(frames[1].dsh.heartbeat,true); assert.equal(frames[2].dsh.baseline,true); assert.equal(frames[2].dsh.gap,true)
  assert.equal(frames[2].dsh.turn,1)
})
test('observer rows stay bounded without evicting an active task', () => {
  const {observer}=fixture()
  for(let i=0;i<140;i++) observer.consume({id:`s-${i}`,header:{}},{type:'turn/start',seq:1,time:100000,data:{turn:1}})
  assert.equal(observer.rows.size,128); assert.ok(observer.rows.has('s-0'))
})
test('official generated descriptors have exactly one metadata stream', () => {
  assert.equal(TYPERT.invocations.length,1); const method=TYPERT.invocations[0]
  assert.equal(method.namespace,'agentPetBridge'); assert.equal(method.method,'watch'); assert.equal(method.mode,'stream')
  assert.equal(method.cancellation.parameter,'signal'); assert.ok(method.uplink)
  assert.equal(TYPERT_REMOTE.descriptors[0].id,method.id)
  assert.equal(method.uplink.codec.create().safeParse({kind:'exec',hostID:'x'}).success,false)
})
test('navigation rejects wrong Host and absent/ambiguous Clients', async () => {
  const {observer}=fixture(); start(observer); const hub=new NavigationHub(observer)
  const req={schema:1,operation:'navigate',hostID:observer.hostID,profileID:observer.profileID,requestID:'request',nativeSessionID:session.id}
  assert.equal((await hub.request({...req,operation:'approve'})).ok,false)
  assert.equal((await hub.request({...req,hostID:'wrong'})).ok,false)
  assert.equal((await hub.request({...req,nativeSessionID:'missing'})).ok,false)
  assert.equal((await hub.request(req)).ok,false)
  const a=hub.register('client-A',()=>true), b=hub.register('client-B',()=>true)
  assert.equal((await hub.request(req)).ok,false); a(); b(); await hub.close()
})
test('unloaded native session is checked by current Client, not lifecycle cache', async () => {
  const {observer}=fixture(); const hub=new NavigationHub(observer); let frame
  const release=hub.register('client-A',value=>{frame=value;return true})
  const req={schema:1,operation:'navigate',hostID:observer.hostID,profileID:observer.profileID,requestID:'r',nativeSessionID:'unloaded'}
  const pending=hub.request(req)
  assert.equal(frame.nativeSessionID,'unloaded'); assert.equal(observer.rows.size,0)
  hub.acknowledge('client-A',{...frame,ok:false}); assert.equal((await pending).ok,false)
  const selected=hub.request({...req,requestID:'r2'})
  hub.acknowledge('client-A',{...frame,ok:true}); assert.equal((await selected).ok,true)
  release(); await hub.close()
})
test('only current Client generation and exact request identity can acknowledge', async () => {
  const {observer}=fixture(); start(observer); const hub=new NavigationHub(observer); let frame
  const release=hub.register('client-A',value=>{frame=value;return true})
  const pending=hub.request({schema:1,operation:'navigate',hostID:observer.hostID,profileID:observer.profileID,requestID:'r',nativeSessionID:session.id})
  assert.equal(hub.acknowledge('client-A',{...frame, generation:'stale',ok:true}),false)
  assert.equal(hub.acknowledge('client-A',{...frame,nativeSessionID:'other',ok:true}),false)
  assert.equal(hub.acknowledge('client-A',{...frame,ok:true}),true)
  assert.equal((await pending).ok,true); assert.equal(hub.acknowledge('client-A',{...frame,ok:true}),false)
  release(); await hub.close()
})
test('disconnect and backpressure fail requests rather than reporting selection', async () => {
  const {observer}=fixture(); start(observer); const hub=new NavigationHub(observer)
  const req={schema:1,operation:'navigate',hostID:observer.hostID,profileID:observer.profileID,requestID:'r',nativeSessionID:session.id}
  let release=hub.register('client-A',()=>false); assert.equal((await hub.request(req)).ok,false); release()
  release=hub.register('client-B',()=>true); const pending=hub.request(req); release()
  assert.equal((await pending).reason,'client-disconnected'); await hub.close()
})
test('private navigation socket is bounded, permissioned and removed on dispose', async () => {
  const {observer}=fixture(); start(observer); const hub=new NavigationHub(observer); await hub.listen()
  const directory=hub.directory, socketPath=hub.path
  assert.equal((await lstat(directory)).mode & 0o777,0o700); assert.equal((await lstat(socketPath)).mode & 0o777,0o600)
  const response=await new Promise((resolve,reject)=>{
    const client=net.createConnection(socketPath,()=>client.write('{"operation":"exec"}\n')); let buffer=''
    client.on('data',data=>buffer+=data);client.on('end',()=>resolve(JSON.parse(buffer)));client.on('error',reject)
  })
  assert.equal(response.ok,false); await hub.close(); await assert.rejects(lstat(socketPath))
})
test('socket root rejects symlinks and writable directories', async () => {
  const dir=await mkdtemp('/tmp/ap-dsh-root-')
  try {
    await chmod(dir,0o755); await assert.rejects(privateSocketDirectory(dir))
    await symlink(dir,`${dir}-link`); await assert.rejects(privateSocketDirectory(`${dir}-link`))
  } finally {await rm(`${dir}-link`,{force:true});await rm(dir,{recursive:true,force:true})}
})
test('metadata Publisher sends to an owned Unix socket and tolerates absent pet', async () => {
  const dir=await mkdtemp('/tmp/ap-dsh-pub-'), path=`${dir}/events.sock`
  const clients=new Set(); let frame; let observed
  const got=new Promise(resolve=>{observed=resolve})
  const server=net.createServer(socket=>{clients.add(socket);socket.on('data',data=>{frame=JSON.parse(data.toString().split('\n')[0]);observed()})})
  await new Promise(resolve=>server.listen(path,resolve))
  const publisher=new Publisher(path,()=>publisher.send({sessionId:'fixture',agentKind:'dsh',eventName:'test',timestamp:100}))
  await Promise.race([got,new Promise((_,reject)=>setTimeout(()=>reject(Error('no frame')),1500))])
  assert.equal(frame.sessionId,'fixture'); assert.equal(publisher.send({huge:'x'.repeat(32769)}),false)
  publisher.close();for(const client of clients)client.destroy();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})
  const absent=new Publisher(path,()=>{}); assert.equal(absent.send({fixture:true}),false); absent.close()
})
test('Client stream queue is bounded and cancellation ends it', async () => {
  const mailbox=new Mailbox();for(let i=0;i<16;i++)assert.equal(mailbox.push({i}),true)
  assert.equal(mailbox.push({i:16}),false);const controller=new AbortController();const iterator=mailbox.iterate(controller.signal)
  assert.equal((await iterator.next()).value.i,0);controller.abort();assert.equal((await iterator.next()).done,true)
})

test('native session/title updates the final task label after completion', () => {
  const {observer, frames}=fixture(); start(observer)
  observer.consume(session,{type:'turn/end',seq:2,time:100100,data:{turn:1,reason:{kind:'completed'}}})
  observer.consume(session,{type:'session/title',seq:3,time:100200,data:{title:'Smoke task'}})
  assert.equal(frames.at(-1).title,'Smoke task'); assert.equal(frames.at(-1).dsh.result,'completed')
})
test('cold history can fold silently and publish only its final baseline', () => {
  const {observer, frames}=fixture()
  observer.consume(session,{type:'turn/start',seq:1,time:100000,data:{turn:1}},true,false)
  observer.consume(session,{type:'turn/end',seq:2,time:100100,data:{turn:1,reason:{kind:'completed'}}},true,false)
  assert.equal(frames.length,0); observer.emit(observer.rows.get(session.id),true)
  assert.equal(frames.length,1); assert.equal(frames[0].dsh.phase,'done'); assert.equal(frames[0].dsh.baseline,true)
})

test('control request cannot inject a different Client frame kind', async () => {
  const {observer}=fixture(); start(observer); const hub=new NavigationHub(observer); let frame
  const release=hub.register('client', value => { frame=value; return true })
  const pending=hub.request({schema:1,operation:'navigate',kind:'hello',hostID:observer.hostID,profileID:observer.profileID,nativeSessionID:session.id,requestID:'r'})
  assert.equal(frame.kind,'navigate'); release(); assert.equal((await pending).ok,false); await hub.close()
})
test('private server rejects malformed and oversized frames without calling Client', async () => {
  const {observer}=fixture(); start(observer); const hub=new NavigationHub(observer); await hub.listen(); let called=false
  const release=hub.register('client',()=>{called=true;return true})
  const exchange=value=>new Promise((resolve,reject)=>{ const client=net.createConnection(hub.path,()=>client.write(value));let buffer='';client.on('data',data=>buffer+=data);client.on('error',reject);client.on('close',()=>resolve(buffer)) })
  assert.equal(JSON.parse(await exchange('malformed\n')).reason,'invalid-frame')
  assert.equal(await exchange('x'.repeat(8193)),''); assert.equal(called,false); release(); await hub.close()
})
