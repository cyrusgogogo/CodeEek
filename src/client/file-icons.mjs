// A deliberately bounded subset of Material Icon Theme. Never turn a repository
// filename into an import, URL, HTML, or SVG source. Exact names win over suffixes.
const fileNames = Object.freeze({
  'package.json': 'nodejs', 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm',
  'pnpm-lock.yaml': 'pnpm', 'pnpm-workspace.yaml': 'pnpm', 'yarn.lock': 'lock', 'bun.lock': 'lock', 'bun.lockb': 'lock',
  '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git', '.gitkeep': 'git',
  '.editorconfig': 'settings', 'settings.json': 'settings', 'tsconfig.json': 'typescript-def', 'jsconfig.json': 'javascript',
  'dockerfile': 'docker', 'docker-compose.yml': 'docker', 'docker-compose.yaml': 'docker', 'compose.yml': 'docker', 'compose.yaml': 'docker',
});
const extensions = Object.freeze({
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'react_ts',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'react',
  vue: 'vue', svelte: 'svelte', html: 'html', htm: 'html', css: 'css', scss: 'sass', sass: 'sass',
  json: 'json', jsonc: 'json', json5: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown', java: 'java', py: 'python', pyi: 'python', ipynb: 'python',
  go: 'go', rs: 'rust', php: 'php', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
  rb: 'ruby', swift: 'swift', kt: 'kotlin', kts: 'kotlin', dart: 'dart', ps1: 'powershell', psm1: 'powershell',
  sh: 'console', bash: 'console', zsh: 'console', bat: 'console', cmd: 'console', sql: 'database', db: 'database',
  xml: 'xml', xsl: 'xml', xsd: 'xml', svg: 'svg', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image',
  pdf: 'pdf', zip: 'zip', gz: 'zip', tgz: 'zip', tar: 'zip', '7z': 'zip', rar: 'zip', lock: 'lock', ini: 'settings', conf: 'settings',
});
const folders = Object.freeze({
  src: 'folder-src', source: 'folder-src', sources: 'folder-src',
  docs: 'folder-docs', doc: 'folder-docs', documentation: 'folder-docs',
  test: 'folder-test', tests: 'folder-test', __tests__: 'folder-test', spec: 'folder-test', specs: 'folder-test',
  config: 'folder-config', configs: 'folder-config', '.config': 'folder-config', '.vscode': 'folder-config',
  components: 'folder-components', public: 'folder-public', static: 'folder-public',
  '.github': 'folder-github', scripts: 'folder-scripts', bin: 'folder-scripts',
  images: 'folder-images', assets: 'folder-images', icons: 'folder-images', lib: 'folder-lib', libs: 'folder-lib', packages: 'folder-lib',
});
const basename = path => String(path ?? '').replaceAll('\\', '/').split('/').filter(Boolean).at(-1)?.toLowerCase() ?? '';

export function getFileIconName(path) {
  const name = basename(path);
  if (Object.hasOwn(fileNames, name)) return fileNames[name];
  if (/^readme(?:\.|$)/.test(name)) return 'readme';
  if (/^(?:licen[cs]e|copying)(?:[._-]|$)/.test(name)) return 'license';
  if (/^dockerfile\./.test(name)) return 'docker';
  if (/^tsconfig\..+\.json$/.test(name) || /\.d\.(?:ts|mts|cts)$/.test(name)) return 'typescript-def';
  if (/^(?:vite|vitest)\.config\./.test(name)) return 'vite';
  if (/^(?:eslint\.config\.|\.eslintrc(?:\.|$))/.test(name)) return 'eslint';
  if (/^(?:prettier\.config\.|\.prettierrc(?:\.|$))/.test(name)) return 'prettier';
  const extension = name.includes('.') ? name.split('.').at(-1) : '';
  return Object.hasOwn(extensions, extension) ? extensions[extension] : 'file';
}

export function getFolderIconName(path, { open = false, root = false } = {}) {
  const name = basename(path);
  const icon = root ? 'folder-root' : Object.hasOwn(folders, name) ? folders[name] : 'folder';
  return open ? `${icon}-open` : icon;
}
