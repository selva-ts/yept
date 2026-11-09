/** The message shown instead of the extension's features in a remote window (WSL, SSH, containers, Codespaces). */
export function remoteNotice(remoteName: string | undefined): string | undefined {
  if (!remoteName) return undefined;
  const kinds: Record<string, string> = {
    wsl: 'WSL', 'ssh-remote': 'Remote - SSH', 'dev-container': 'Dev Containers', 'attached-container': 'Dev Containers',
    codespaces: 'Codespaces', tunnel: 'Remote Tunnels'
  };
  const kind = kinds[remoteName] ?? 'remote';
  return `Yept doesn't support ${kind} windows yet. Open the folder in a local VS Code window to use it.`;
}
