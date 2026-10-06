import { parentPort, workerData } from 'node:worker_threads';
import { paths } from '../core/config.ts';
import { openArchive } from '../core/db.ts';
import { deepSearch, type DeepSearchParams } from './deep.ts';

/** Worker thread of chat_deep_search (started by mcp/server.ts): one search, one result message. */
const archive = openArchive(paths.archiveDb, { readonly: true });
try {
  parentPort!.postMessage(deepSearch(archive, workerData as DeepSearchParams));
} finally {
  archive.close();
}
