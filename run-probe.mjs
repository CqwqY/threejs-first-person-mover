import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const root = dirname(fileURLToPath(import.meta.url));
chdir(root);
const which = process.argv[2];
if (which === 'ledge') await import('./tools/probe-physics-ledge.mjs');
else console.error('usage: run-probe.mjs ledge');
