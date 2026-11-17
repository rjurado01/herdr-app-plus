// Match the repository-relative path, regardless of case.
export function filterFiles(files, query) {
  const needle = query.toLowerCase();
  return needle ? files.filter((file) => file.path.toLowerCase().includes(needle)) : files;
}
