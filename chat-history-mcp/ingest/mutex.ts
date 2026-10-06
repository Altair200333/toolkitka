import koffi from 'koffi';
import { mutexName } from '../core/config.ts';

const WAIT_OBJECT_0 = 0x000;
const WAIT_ABANDONED = 0x080;
const WAIT_TIMEOUT = 0x102;

const kernel32 = koffi.load('kernel32.dll');
const CreateMutexW = kernel32.func('__stdcall', 'CreateMutexW', 'void*', ['void*', 'bool', 'str16']);
const WaitForSingleObject = kernel32.func('__stdcall', 'WaitForSingleObject', 'uint32', ['void*', 'uint32']);
const ReleaseMutex = kernel32.func('__stdcall', 'ReleaseMutex', 'bool', ['void*']);
const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['void*']);

export interface WriterLock {
  /** True when the previous owner died while holding the lock; state on disk is still
   *  consistent (WAL + idempotent upsert), just log it and proceed. */
  abandoned: boolean;
  release(): void;
}

/** Single-writer arbitration across every MCP process and the Task Scheduler run.
 *  Global\ namespace: visible from session 0 services and all logon sessions. */
export function tryAcquireWriter(): WriterLock | null {
  const handle = CreateMutexW(null, false, mutexName);
  if (!handle) throw new Error('CreateMutexW failed');
  const r = WaitForSingleObject(handle, 0);
  if (r === WAIT_TIMEOUT) {
    CloseHandle(handle);
    return null;
  }
  if (r !== WAIT_OBJECT_0 && r !== WAIT_ABANDONED) {
    CloseHandle(handle);
    throw new Error(`WaitForSingleObject returned 0x${r.toString(16)}`);
  }
  let released = false;
  return {
    abandoned: r === WAIT_ABANDONED,
    release() {
      if (released) return;
      released = true;
      ReleaseMutex(handle);
      CloseHandle(handle);
    },
  };
}
