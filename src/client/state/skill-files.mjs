export function formatResourceSize(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function buildSkillFileTree(files) {
  const root = { name: '', path: '', directory: true, children: [] };
  for (const file of files) {
    const parts = String(file?.path || '').split('/').filter(Boolean);
    let parent = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      const directory = index < parts.length - 1;
      let node = parent.children.find(item => item.name === part && item.directory === directory);
      if (!node) {
        node = { name: part, path, directory, file: directory ? undefined : file, children: [] };
        parent.children.push(node);
      }
      parent = node;
    });
  }
  const sortNodes = nodes => {
    nodes.sort((left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name));
    nodes.forEach(node => sortNodes(node.children));
  };
  sortNodes(root.children);
  return root.children;
}
