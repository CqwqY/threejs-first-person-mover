import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const root = dirname(fileURLToPath(import.meta.url));
chdir(root);
const which = process.argv[2];
if (which === 'students') await import('./tools/probe-students.mjs');
else if (which === 'npc') await import('./tools/probe-npc-move.mjs');
else console.error('usage: run-probe.mjs students|npc');
