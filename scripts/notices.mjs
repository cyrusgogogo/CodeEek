import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
export async function notices(metafiles) {
  const roots = new Set();
  for (const metadata of metafiles) for (const input of Object.keys(metadata.inputs)) {
    const full = path.resolve(input).replaceAll('\\', '/'); const index = full.lastIndexOf('/node_modules/');
    if (index < 0) continue;
    const suffix = full.slice(index + 14).split('/'); roots.add(full.slice(0, index + 14) + suffix.slice(0, suffix[0].startsWith('@') ? 2 : 1).join('/'));
  }
  const sections = [];
  for (const root of [...roots].sort()) {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')); const names = (await readdir(root)).filter(name => /^(licen[cs]e|copying|copyright|notice)(\.|$)/i.test(name));
    const texts = [];
    for (const name of names) { try { texts.push(`${name}\n${await readFile(path.join(root, name), 'utf8')}`); } catch (error) { if (error.code !== 'EISDIR') throw error; } }
    if (!texts.length) {
      for (const name of ['README.md', 'readme.md']) {
        try { const readme = await readFile(path.join(root, name), 'utf8'); const match = /^#{1,3}\s+Licen[cs]e\s*$/im.exec(readme); if (match) { texts.push(`License section from ${name}\n${readme.slice(match.index)}`); break; } } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    sections.push(`===== ${pkg.name}@${pkg.version} =====\nLicense identifier: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license) ?? 'Not specified in package metadata; see text below'}\n${texts.length ? texts.join('\n\n') : 'No separate license text was distributed at the package root; see upstream package and retained source notices.'}`);
  }
  for (const [name, license] of [
    ['Material Icon Theme 5.39.0 — selected SVG assets (MIT)', 'src/client/icons/material/LICENSE'],
    ['Lucide Static 0.468.0 — selected geometry (ISC and Feather MIT)', 'src/client/icons/lucide/LICENSE'],
    ['shadcn/ui — adapted Select composition (MIT)', 'src/client/ui/LICENSE'],
  ]) sections.push(`===== ${name} =====\n${await readFile(license, 'utf8')}`);
  return `Third-party software bundled into dsh-code-reading\nGenerated from esbuild input metadata and the explicitly vendored icon subset. React is provided externally by DSH.\n\n${sections.join('\n\n')}`;
}
