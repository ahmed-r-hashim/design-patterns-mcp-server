/**
 * Canonical path resolution for runtime, build, CLI, and tests.
 *
 * Paths are resolved and joined using forward slashes exclusively, rather
 * than Node's OS-conditional `fileURLToPath`/`path.sep`/`path.join`. Node's
 * fs APIs accept forward-slash paths on every platform (including Windows),
 * so this keeps resolution deterministic across host OSes and avoids
 * `fileURLToPath` throwing on `file://` URLs whose format doesn't match the
 * current platform (e.g. POSIX-style URLs supplied to tests on Windows).
 */
export interface ProjectPaths {
  projectRoot: string;
  runtimeDataPath: string;
  sourcePatternsPath: string;
  databasePath: string;
}

function fileUrlToPath(moduleUrl: string): string {
  if (!moduleUrl.startsWith('file://')) {
    return moduleUrl.replace(/\\/g, '/');
  }

  let decoded = decodeURIComponent(moduleUrl.slice('file://'.length));

  // Windows drive-letter URLs (file:///C:/foo) have a leading slash before
  // the drive letter that must be stripped to form a valid path.
  if (/^\/[A-Za-z]:\//.test(decoded)) {
    decoded = decoded.slice(1);
  }

  return decoded;
}

function pathFromSegments(segments: string[]): string {
  const resolved = segments.join('/');
  return resolved === '' ? '/' : resolved;
}

export function resolveProjectRoot(moduleUrl: string = import.meta.url): string {
  const fullPath = fileUrlToPath(moduleUrl);
  const lastSlash = fullPath.lastIndexOf('/');
  const moduleDir = lastSlash >= 0 ? fullPath.slice(0, lastSlash) : fullPath;
  const segments = moduleDir.split('/');
  const distIndex = segments.lastIndexOf('dist');

  if (distIndex > 0) {
    return pathFromSegments(segments.slice(0, distIndex));
  }

  const srcIndex = segments.lastIndexOf('src');
  if (srcIndex > 0) {
    return pathFromSegments(segments.slice(0, srcIndex));
  }

  return process.cwd().replace(/\\/g, '/');
}

export function resolveRuntimeDataPath(moduleUrl: string = import.meta.url): string {
  return `${resolveProjectRoot(moduleUrl)}/data`;
}

export function resolvePatternsPath(moduleUrl: string = import.meta.url): string {
  return `${resolveRuntimeDataPath(moduleUrl)}/patterns`;
}

export function resolveDatabasePath(
  databasePath?: string,
  moduleUrl: string = import.meta.url
): string {
  return databasePath ?? `${resolveRuntimeDataPath(moduleUrl)}/design-patterns.db`;
}

export function resolveProjectPaths(
  moduleUrl: string = import.meta.url,
  databasePath?: string
): ProjectPaths {
  const projectRoot = resolveProjectRoot(moduleUrl);
  const runtimeDataPath = `${projectRoot}/data`;

  return {
    projectRoot,
    runtimeDataPath,
    sourcePatternsPath: `${runtimeDataPath}/patterns`,
    databasePath: databasePath ?? `${runtimeDataPath}/design-patterns.db`,
  };
}
