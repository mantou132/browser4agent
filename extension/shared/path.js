export const displayHomePath = (path, home) => {
  if (!path || !home) return path || '';

  const windows = /^[a-z]:[\\/]/i.test(home) || home.startsWith('\\\\');
  const trimEnd = (value) => value.replace(/[\\/]+$/, '');
  const normalizedHome = trimEnd(home);
  const normalizedPath = trimEnd(path);
  const comparableHome = windows ? normalizedHome.replaceAll('\\', '/').toLowerCase() : normalizedHome;
  const comparablePath = windows ? normalizedPath.replaceAll('\\', '/').toLowerCase() : normalizedPath;

  if (comparablePath === comparableHome) return '~';
  if (!comparablePath.startsWith(`${comparableHome}/`)) return path;

  return `~/${normalizedPath.slice(normalizedHome.length + 1).replaceAll('\\', '/')}`;
};
