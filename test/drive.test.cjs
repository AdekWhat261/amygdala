const test = require('node:test');
const assert = require('node:assert/strict');
const { Drive, sha256, parseFolderLink } = require('../src/drive.cjs');
const encoder = new TextEncoder();
const drive = request => new Drive({ request, getAccessToken: async () => 'TOKEN', vaultId: 'vault_12345678' });
test('pagination combines pages and rejects incomplete, invalid or repeated pages', async () => {
  let calls = 0;
  const d = drive(async () => ({ status: 200, json: ++calls === 1 ? { files: [{ id: 'file_12345' }], nextPageToken: 'next' } : { files: [{ id: 'file_67890' }] } }));
  assert.equal((await d.list('event')).length, 2);
  for (const json of [{ files: [], incompleteSearch: true }, { files: null }, { files: [null] }, { files: [{ id: '../evil' }] }, { files: [], nextPageToken: {} }, { files: [], nextPageToken: 'loop' }]) {
    await assert.rejects(drive(async () => ({ status: 200, json })).list('event'));
  }
});
test('multipart upload preserves arbitrary binary bytes exactly', async () => {
  const binary = Uint8Array.from([0, 255, 254, 13, 10, 128, 65]);
  let request;
  const d = drive(async r => { request = r; return { status: 200, json: { id: 'file_12345' } }; });
  await d.create('blob', 'hash', binary, 'картинка');
  const body = new Uint8Array(request.body);
  const marker = encoder.encode('Content-Type: application/octet-stream\r\n\r\n');
  let start = -1;
  for (let i = 0; i < body.length; i++) if (marker.every((v, j) => body[i + j] === v)) { start = i + marker.length; break; }
  assert.ok(start > 0); assert.deepEqual(body.slice(start, start + binary.length), binary);
});
test('blob hashes and malicious ids fail before use', async () => {
  const original = encoder.encode('original'), hash = await sha256(original);
  const d = drive(async r => r.url.includes('alt=media') ? { status: 200, arrayBuffer: encoder.encode('corrupted').buffer } : { status: 200, json: { files: [{ id: 'file_12345' }] } });
  await assert.rejects(d.getBlob(hash), /Проверка/);
  await assert.rejects(d.putBlob(hash, encoder.encode('other')), /изменился/);
  await assert.rejects(d.raw('../secret'), /идентификатор/);
});
test('immutable event cache avoids repeat media reads and returns fresh objects', async () => {
  let media = 0;
  const d = drive(async r => r.url.includes('alt=media') ? (media++, { status: 200, arrayBuffer: encoder.encode('{"id":"event_12345","nested":{"a":1}}').buffer }) : { status: 200, json: { files: [{ id: 'file_12345' }] } });
  const first = await d.listEvents(); first[0].nested.a = 999;
  assert.equal((await d.listEvents())[0].nested.a, 1); assert.equal(media, 1);
  await d.putEvent({ nested: { a: 1 }, id: 'event_12345' }); assert.equal(media, 1);
  await assert.rejects(d.putEvent({ id: 'event_12345', nested: { a: 2 } }), /Конфликт/);
});
test('newly uploaded events are cached without a media re-download', async () => {
  let media = 0, created = false;
  const event = { id: 'event_12345', path: 'note.md' };
  const d = drive(async request => {
    if (request.url.includes('alt=media')) { media += 1; return { status: 200, arrayBuffer: encoder.encode(JSON.stringify(event)).buffer }; }
    if (request.url.includes('uploadType=multipart')) { created = true; return { status: 200, json: { id: 'file_12345' } }; }
    return { status: 200, json: { files: created ? [{ id: 'file_12345' }] : [] } };
  });
  await d.putEvent(event);
  assert.deepEqual(await d.listEvents(), [event]);
  assert.equal(media, 0);
});
test('a stalled Drive request stops at the configured deadline', async () => {
  const d = new Drive({ request: async () => new Promise(() => {}), getAccessToken: async () => 'TOKEN',
    vaultId: 'vault_12345678', requestTimeout: 10 });
  await assert.rejects(d.list('event'), /Не удалось связаться/);
});
test('Drive errors never expose secret response bodies or transport messages', async () => {
  for (const request of [async () => ({ status: 500, text: 'SECRET' }), async () => { throw new Error('SECRET'); }]) {
    await assert.rejects(drive(request).list('blob'), error => !error.message.includes('SECRET'));
  }
});
test('team Drive queries and uploads stay inside the selected folder', async () => {
  const calls=[];
  const d=new Drive({request:async request=>{calls.push(request);if(request.url.includes('uploadType=multipart')) return {status:200,json:{id:'new_file_12345'}};if(request.url.includes('/files?')) return {status:200,json:{files:[{id:'file_12345',parents:['folder_12345678']}]}};return {status:200,json:{id:'new_file_12345'}};},getAccessToken:async()=>'TOKEN',mode:'team',folderId:'folder_12345678'});
  assert.equal((await d.list('event')).length,1);
  await d.create('blob','key',encoder.encode('data'),'blob');
  const listing=new URL(calls[0].url);
  assert.equal(listing.searchParams.get('spaces'),'drive');assert.ok(listing.searchParams.get('q').includes("'folder_12345678' in parents"));assert.equal(listing.searchParams.get('supportsAllDrives'),'true');
  const body=new TextDecoder().decode(calls[1].body);assert.ok(body.includes('"parents":["folder_12345678"]'));
  const outside=new Drive({request:async()=>({status:200,json:{files:[{id:'file_12345',parents:['other_folder_123']} ]}}),getAccessToken:async()=>'TOKEN',mode:'team',folderId:'folder_12345678'});
  await assert.rejects(outside.list('event'),/вне выбранной папки/);
});
test('folder links accept Drive sharing parameters but reject unrelated query data',()=>{
  assert.equal(parseFolderLink('https://drive.google.com/drive/folders/folder_12345678?usp=sharing&resourcekey=key'),'folder_12345678');
  assert.throws(()=>parseFolderLink('https://drive.google.com/drive/folders/folder_12345678?download=1'));
  assert.throws(()=>parseFolderLink('https://drive.google.com/file/d/folder_12345678'));
});
test('team access verifies editor capability, manifest and actor identity',async()=>{
  let permissions=false;
  const d=new Drive({request:async request=>{
    if(request.url.includes('/permissions?')){permissions=true;return {status:200,json:{permissions:[{id:'permission_alice',type:'user',emailAddress:'alice@example.org',displayName:'Alice',role:'writer'}]}};}
    if(request.url.includes('/files/file_manifest'))return {status:200,arrayBuffer:encoder.encode(JSON.stringify({id:'folder_12345678',name:'Team notes',version:2,type:'easy-sync-team'})).buffer};
    if(request.url.includes('/files?'))return {status:200,json:{files:[{id:'file_manifest',parents:['folder_12345678']}]}};
    return {status:200,json:{id:'folder_12345678',name:'Amygdala — Team notes',mimeType:'application/vnd.google-apps.folder',capabilities:{canListChildren:true,canAddChildren:true}}};
  },getAccessToken:async()=>'TOKEN',mode:'team',folderId:'folder_12345678'});
  assert.deepEqual(await d.teamInfo(),{id:'folder_12345678',name:'Team notes',version:2,kind:'team',folderName:'Amygdala — Team notes'});
  assert.deepEqual(await d.actorFor('alice@example.org'),{actorId:'permission_alice',actorName:'Alice'});assert.ok(permissions);
  const revoked=new Drive({request:async()=>({status:403}),getAccessToken:async()=>'TOKEN',mode:'team',folderId:'folder_12345678'});
  await assert.rejects(revoked.assertAccess(),/подтверждён или был отозван/);
});
