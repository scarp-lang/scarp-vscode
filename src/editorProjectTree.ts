export type ScarpProjectItemKind = 'folder' | 'source';
export interface ScarpProjectTreeItem {
  readonly kind: ScarpProjectItemKind;
  /** Forward-slash project-relative filename or directory (root is empty). */
  readonly path: string;
  readonly name: string;
  readonly parent: string;
  readonly depth: number;
  readonly immediateChildren: number;
  readonly descendantSources: number;
}
export interface ScarpProjectTree {
  readonly items: readonly ScarpProjectTreeItem[];
  readonly rejected: readonly string[];
  readonly sourceCount: number;
}
export interface ScarpProjectTreeOptions {
  readonly maximumFiles?: number;
  readonly maximumDepth?: number;
  readonly maximumFilenameLength?: number;
}
const DEFAULT_MAX_FILES = 512;
const DEFAULT_DEPTH = 32;
const DEFAULT_FILENAME_LENGTH = 512;
function positive(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback :
    Number.isSafeInteger(value) && value > 0 ? value : 0;
}
function validComponent(component: string): boolean {
  return component.length > 0 && component.length <= 128 &&
    component !== '.' && component !== '..' &&
    !/[\x00-\x1f\x7f:\\]/.test(component) && !component.includes('%');
}
function parentOf(filename: string): string {
  const index = filename.lastIndexOf('/');
  return index < 0 ? '' : filename.slice(0, index);
}
function basename(filename: string): string {
  const index = filename.lastIndexOf('/');
  return index < 0 ? filename : filename.slice(index + 1);
}
export function validProjectSourcePath(
  filename: string, maxDepth = DEFAULT_DEPTH,
  maxLength = DEFAULT_FILENAME_LENGTH
): boolean {
  if (!filename || filename.length > maxLength || filename.startsWith('/') ||
      !filename.endsWith('.srp')) { return false; }
  const components = filename.split('/');
  return components.length <= maxDepth && components.every(validComponent);
}
/**
 * Deterministic in-memory project tree. This never explores directories:
 * callers supply bounded project-root-relative source filenames.
 *
 * The returned tree contains a root folder and all intermediate folders,
 * even if there are no top-level sources. Counts allow the UI to display
 * whether a nested practice folder actually has readable Scarp files.
 */
export function buildScarpProjectTree(
  filenames: readonly string[], options: ScarpProjectTreeOptions = {}
): ScarpProjectTree {
  const maxFiles = positive(options.maximumFiles, DEFAULT_MAX_FILES);
  const maxDepth = positive(options.maximumDepth, DEFAULT_DEPTH);
  const maxFilenameLength = positive(
    options.maximumFilenameLength, DEFAULT_FILENAME_LENGTH
  );
  const rejected: string[] = [];
  const sourceNames: string[] = [];
  const unique = new Set<string>();
  for (const filename of [...filenames].sort()) {
    if (!validProjectSourcePath(filename, maxDepth, maxFilenameLength)) {
      rejected.push(filename);
      continue;
    }
    if (unique.has(filename)) { continue; }
    if (!maxFiles || sourceNames.length >= maxFiles) {
      rejected.push(filename);
      continue;
    }
    unique.add(filename);
    sourceNames.push(filename);
  }
  const working = new Map<string, {
    kind: ScarpProjectItemKind;
    parent: string;
    name: string;
    depth: number;
    children: Set<string>;
    sourceCount: number;
  }>();
  const addFolder = (folder: string) => {
    if (working.has(folder)) { return; }
    const parent = parentOf(folder);
    if (folder !== '') { addFolder(parent); }
    working.set(folder, {
      kind: 'folder', name: folder === '' ? '(project root)' : basename(folder),
      parent: folder === '' ? '' : parent,
      depth: folder ? folder.split('/').length : 0,
      children: new Set(), sourceCount: 0
    });
    if (folder !== '') { working.get(parent)!.children.add(folder); }
  };
  addFolder('');
  for (const filename of sourceNames) {
    const parent = parentOf(filename);
    addFolder(parent);
    working.set(filename, {
      kind: 'source', parent, name: basename(filename),
      depth: filename.split('/').length,
      children: new Set(), sourceCount: 1
    });
    working.get(parent)!.children.add(filename);
  }
  for (const filename of sourceNames) {
    let parent = parentOf(filename);
    while (true) {
      working.get(parent)!.sourceCount++;
      if (parent === '') { break; }
      parent = parentOf(parent);
    }
  }
  const items: ScarpProjectTreeItem[] = [...working.entries()]
    .map(([filename, item]) => ({
      kind: item.kind, path: filename, parent: item.parent,
      name: item.name, depth: item.depth,
      immediateChildren: item.children.size,
      descendantSources: item.sourceCount
    }))
    .sort((a, b) =>
      a.depth - b.depth ||
      (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) ||
      a.path.localeCompare(b.path));
  return { items, rejected, sourceCount: sourceNames.length };
}
/**
 * Show only immediate children of an existing folder; folders come first.
 * This retains exact project boundaries and rejects guessed parent paths.
 */
export function scarpProjectChildren(
  tree: ScarpProjectTree, folder: string
): readonly ScarpProjectTreeItem[] {
  if (!tree.items.some(item => item.kind === 'folder' && item.path === folder)) {
    return [];
  }
  return tree.items.filter(item => item.path !== folder &&
    item.parent === folder).sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) ||
    a.name.localeCompare(b.name));
}
export function scarpProjectParent(
  tree: ScarpProjectTree, folder: string
): string | undefined {
  const item = tree.items.find(item => item.path === folder && item.kind === 'folder');
  return item ? item.parent : undefined;
}
export function scarpProjectBreadcrumb(
  tree: ScarpProjectTree, folder: string
): readonly string[] {
  if (!tree.items.some(item => item.path === folder && item.kind === 'folder')) {
    return [];
  }
  const result = ['(project root)'];
  if (folder) { result.push(...folder.split('/')); }
  return result;
}
export function scarpProjectFile(
  tree: ScarpProjectTree, filename: string
): ScarpProjectTreeItem | undefined {
  return tree.items.find(item => item.kind === 'source' && item.path === filename);
}
