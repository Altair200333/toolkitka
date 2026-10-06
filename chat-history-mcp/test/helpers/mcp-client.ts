import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface McpTestClient {
  call(method: string, params?: unknown): Promise<any>;
  close(): void;
}

/** Minimal stdio JSON-RPC client for driving the server in tests. */
export function startServer(env: Record<string, string> = {}): McpTestClient {
  const child = spawn(process.execPath, ['--no-warnings', 'mcp/server.ts'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    }
  });

  const send = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + '\n');

  return {
    call(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
        }, 30000);
        send({ jsonrpc: '2.0', id, method, params });
        if (method === 'initialize') {
          // initialized notification is expected right after the response; harmless if early
          setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/initialized' }), 50);
        }
      });
    },
    close() {
      child.kill();
    },
  };
}
