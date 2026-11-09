import { expect, it } from 'vitest';
import { remoteNotice } from './remote';

it('explains remote windows by kind and stays quiet locally', () => {
  expect(remoteNotice(undefined)).toBeUndefined();
  expect(remoteNotice('')).toBeUndefined();
  expect(remoteNotice('wsl')).toBe("Yept doesn't support WSL windows yet. Open the folder in a local VS Code window to use it.");
  expect(remoteNotice('ssh-remote')).toContain('Remote - SSH');
  expect(remoteNotice('dev-container')).toContain('Dev Containers');
  expect(remoteNotice('something-new')).toContain("doesn't support remote windows");
});
