import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
chdir(dirname(fileURLToPath(import.meta.url)));
const { build } = await import('vite');
await build({ outDir: 'E:/_vite_fpm', emptyOutDir: true, logLevel: 'info' });
console.log('BUILD_DONE');
