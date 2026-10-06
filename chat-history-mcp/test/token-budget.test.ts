import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/mcp-client.ts';
import { prepareTestArchive } from './helpers/claude-fixture.ts';

// Runs against a fixture archive; with CHAT_SMOKE=1 and CHAT_ARCHIVE_DIR set, against that archive (real data), like mcp.test.ts.
// Budgets are deliberately loose (+~50% structural overhead over the content caps):
// the point is to catch «забыли усечение» regressions, not to pin exact byte counts.
test('token budgets: tool answers stay compact', async (t) => {
  const archive = prepareTestArchive();
  const client = startServer(archive.env);
  t.after(() => {
    client.close();
    archive.cleanup();
  });
  await client.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'budget-test', version: '0' },
  });

  let convId: string | undefined;
  let itemIds: string[] = [];
  for (const query of ['индексация чатов sqlite', 'ошибка теста crash digest', 'бэкап vacuum поколения']) {
    const r = await client.call('tools/call', { name: 'chat_search', arguments: { query, k: 10 } });
    const text: string = r.content[0].text;
    assert.ok(text.length <= 9000, `chat_search(«${query}») распух: ${text.length} символов`);
    convId ??= text.match(/c:([0-9a-f]{12})/)?.[1];
    if (!itemIds.length) itemIds = [...text.matchAll(/p:([0-9a-f]{12})/g)].map((m) => m[1]).slice(0, 3);
  }
  assert.ok(convId && itemIds.length, 'на dev-данных поиск обязан что-то находить');

  const read = await client.call('tools/call', { name: 'chat_read', arguments: { chat: convId, max_chars: 6000 } });
  const readText: string = read.content[0].text;
  assert.ok(readText.length <= 9000, `chat_read(max_chars=6000) распух: ${readText.length} символов`);

  const details = await client.call('tools/call', { name: 'chat_details', arguments: { ids: itemIds, max_chars: 2000 } });
  const detailsText: string = details.content[0].text;
  assert.ok(detailsText.length <= 3200, `chat_details(max_chars=2000) распух: ${detailsText.length} символов`);

  const list = await client.call('tools/call', { name: 'chat_list', arguments: { k: 20 } });
  const listText: string = list.content[0].text;
  assert.ok(listText.length <= 6000, `chat_list(k=20) распух: ${listText.length} символов`);
});
