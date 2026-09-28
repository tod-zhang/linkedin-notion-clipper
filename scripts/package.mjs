// Build the Chrome Web Store upload: dist/linkedin-notion-clipper-<version>.zip
// The store assigns the extension id itself and rejects a manifest with "key",
// so the key (kept in manifest.json for unpacked installs) is stripped here.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
delete manifest.key;

const build = join(root, 'dist', 'store');
rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
writeFileSync(join(build, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
for (const dir of ['icons', 'src']) cpSync(join(root, dir), join(build, dir), { recursive: true });

const zip = join(root, 'dist', `linkedin-notion-clipper-${manifest.version}.zip`);
rmSync(zip, { force: true });
execFileSync('zip', ['-rq', zip, '.', '-x', '*.DS_Store'], { cwd: build });
console.log(`✓ ${zip}（已移除 manifest 中的 key）`);
