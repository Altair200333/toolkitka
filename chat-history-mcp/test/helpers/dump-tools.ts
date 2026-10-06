// Prints the exact tools/list payload the server serves to clients + its size.
import { startServer } from './mcp-client.ts';
import { paths } from '../../core/config.ts';

const client = startServer({ CHAT_ARCHIVE_DIR: paths.dataDir });
await client.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dump', version: '0' } });
const res = await client.call('tools/list', {});
const json = JSON.stringify(res.tools);
for (const t of res.tools) {
  const schema = JSON.stringify(t.inputSchema ?? {});
  console.log(`${t.name}: desc ${t.description.length} символов, schema ${schema.length} символов, параметры: ${Object.keys(t.inputSchema?.properties ?? {}).join(', ')}`);
}
console.log(`итого tools/list JSON: ${json.length} символов, ${res.tools.length} инструментов`);
client.close();
