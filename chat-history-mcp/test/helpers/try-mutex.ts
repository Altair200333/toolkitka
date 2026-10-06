import { tryAcquireWriter } from '../../ingest/mutex.ts';

const lock = tryAcquireWriter();
console.log(lock === null ? 'BLOCKED' : lock.abandoned ? 'ACQUIRED-ABANDONED' : 'ACQUIRED');
lock?.release();
