import { beforeEach, expect, it, vi } from 'vitest';
import type { LoadedRequest } from '@yept/core/shared/ipc';
import { newRequestItem, toRequestDoc } from '@yept/core/engine/workspace/bruno-adapter';
import { useStore, type Tab } from './store';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('./api', () => ({ yept: { requests: { get } }, errorMessage: String, formatBytes: String, formatMs: String }));

const doc = toRequestDoc(newRequestItem('Request', 1));
const snapshot = { root: 'workspace', collections: [], problems: [] };
const loaded: LoadedRequest = { id: 'request', collectionId: 'collection', path: 'collection/Request.yml', readOnly: false, doc };
beforeEach(() => {
  get.mockReset();
  const tab: Tab = { ...loaded, saved: structuredClone(doc), draft: structuredClone(doc), conflict: null, run: null, history: null, historyOpen: false, viewing: null };
  useStore.setState({ snapshot, tabs: [tab], envs: {} });
});
const change = { snapshot, changedRequestIds: ['request'], removedRequestIds: [] };

it('keeps drafts edited while an external reload is in flight and raises a conflict', async () => {
  let finish!: (value: LoadedRequest) => void;
  get.mockImplementation(() => new Promise<LoadedRequest>((resolve) => { finish = resolve; }));
  const pending = useStore.getState().applyExternal(change);
  useStore.getState().updateDraft('request', (d) => ({ ...d, url: 'https://api.example.test/local' }));
  finish({ ...loaded, doc: { ...doc, url: 'https://api.example.test/remote' } }); await pending;
  expect(useStore.getState().tabs[0].draft.url).toBe('https://api.example.test/local');
  expect(useStore.getState().tabs[0].conflict).toBe('changed');
});

it('does not report a second conflict for duplicate notifications of the saved version', async () => {
  get.mockResolvedValue(loaded);
  useStore.getState().updateDraft('request', (d) => ({ ...d, url: 'https://api.example.test/local' }));
  await useStore.getState().applyExternal(change);
  expect(useStore.getState().tabs[0].conflict).toBe(null);
  expect(useStore.getState().tabs[0].draft.url).toBe('https://api.example.test/local');
});

it('follows a moved file without a conflict when only its path changed', async () => {
  get.mockResolvedValue({ ...loaded, path: 'collection/Moved/Request.yml' });
  useStore.getState().updateDraft('request', (d) => ({ ...d, url: 'https://api.example.test/local' }));
  await useStore.getState().applyExternal(change);
  const tab = useStore.getState().tabs[0];
  expect(tab.conflict).toBe(null);
  expect(tab.path).toBe('collection/Moved/Request.yml');
  expect(tab.draft.url).toBe('https://api.example.test/local');
});

it('reloads a clean tab and retains dirty drafts when a request is removed', async () => {
  get.mockResolvedValue({ ...loaded, doc: { ...doc, url: 'https://api.example.test/remote' } });
  await useStore.getState().applyExternal(change);
  expect(useStore.getState().tabs[0].draft.url).toBe('https://api.example.test/remote');
  useStore.getState().updateDraft('request', (d) => ({ ...d, name: 'Local edit' }));
  await useStore.getState().applyExternal({ snapshot, changedRequestIds: [], removedRequestIds: ['request'] });
  expect(useStore.getState().tabs[0].conflict).toBe('removed');
  expect(useStore.getState().tabs[0].draft.name).toBe('Local edit');
});
