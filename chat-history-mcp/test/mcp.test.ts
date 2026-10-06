import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/mcp-client.ts';
import { prepareTestArchive } from './helpers/claude-fixture.ts';

// Runs against a fixture archive; with CHAT_SMOKE=1 and CHAT_ARCHIVE_DIR set, against that archive (real data).
test('mcp server: initialize, list tools, search, read, status', async (t) => {
  const archive = prepareTestArchive();
  const client = startServer(archive.env);
  t.after(() => {
    client.close();
    archive.cleanup();
  });

  const init = await client.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(init.serverInfo.name, 'chat-history');

  const tools = await client.call('tools/list', {});
  const names = tools.tools.map((tl: { name: string }) => tl.name).sort();
  assert.deepEqual(names, ['chat_deep_search', 'chat_details', 'chat_list', 'chat_purge', 'chat_read', 'chat_search', 'chat_status']);

  const status = await client.call('tools/call', { name: 'chat_status', arguments: {} });
  assert.match(status.content[0].text, /freshness:/);

  const search = await client.call('tools/call', {
    name: 'chat_search',
    arguments: { query: 'индексация чатов sqlite', k: 5 },
  });
  const searchText: string = search.content[0].text;
  assert.match(searchText, /p:[0-9a-f]{12}/, 'expect item public ids in results');
  assert.match(searchText, /freshness:/);

  const convId = searchText.match(/c:([0-9a-f]{12})/)?.[1];
  assert.ok(convId, 'expect a conversation id in results');
  const read = await client.call('tools/call', { name: 'chat_read', arguments: { chat: convId, max_chars: 3000 } });
  assert.match(read.content[0].text, new RegExp(`чат c:${convId}`));

  const itemId = searchText.match(/p:([0-9a-f]{12})/)?.[1];
  const details = await client.call('tools/call', { name: 'chat_details', arguments: { ids: [itemId], max_chars: 2000 } });
  assert.match(details.content[0].text, new RegExp(`p:${itemId}`));

  const list = await client.call('tools/call', { name: 'chat_list', arguments: { k: 5 } });
  assert.match(list.content[0].text, /c:[0-9a-f]{12}/);
});
