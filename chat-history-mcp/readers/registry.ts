import type { SourceRootDef } from '../core/config.ts';
import type { ChangeBatch, GenerationInfo, ReadBudget } from './types.ts';
import { discoverClaudeGenerations, readClaudeBatch, READER_VERSION as CLAUDE_READER_VERSION } from './claude.ts';
import { discoverCodexGenerations, readCodexBatch, READER_VERSION as CODEX_READER_VERSION } from './codex.ts';
import { discoverOpencodeGenerations, readOpencodeBatch, READER_VERSION as OPENCODE_READER_VERSION } from './opencode.ts';
import { discoverT3Generations, readT3Batch, READER_VERSION as T3_READER_VERSION } from './t3.ts';

export interface Reader {
  readerVersion: number;
  discover(root: SourceRootDef): GenerationInfo[];
  /** One call = up to one budget-sized batch from one generation. */
  readBatch(gen: GenerationInfo, cursorJson: string | undefined, budget: ReadBudget): ChangeBatch;
}

export const readers: Partial<Record<SourceRootDef['app'], Reader>> = {
  claude: {
    readerVersion: CLAUDE_READER_VERSION,
    discover: discoverClaudeGenerations,
    readBatch: readClaudeBatch,
  },
  codex: {
    readerVersion: CODEX_READER_VERSION,
    discover: discoverCodexGenerations,
    readBatch: readCodexBatch,
  },
  opencode: {
    readerVersion: OPENCODE_READER_VERSION,
    discover: discoverOpencodeGenerations,
    readBatch: readOpencodeBatch,
  },
  t3: {
    readerVersion: T3_READER_VERSION,
    discover: discoverT3Generations,
    readBatch: readT3Batch,
  },
};
