import {
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
} from 'node:fs';
import { dirname } from 'node:path';
export function writeDurableJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const dir = openSync(dirname(path), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
