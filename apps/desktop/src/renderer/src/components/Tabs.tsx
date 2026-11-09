import { isDirty, useStore, type Tab } from '@yept/ui/store';
import { confirm } from '@yept/ui/components/Dialogs';

export async function closeWithPrompt(tab: Tab): Promise<void> {
  const { closeTab } = useStore.getState();
  if (isDirty(tab) && !tab.readOnly) {
    const discard = await confirm('Discard unsaved changes?', `"${tab.draft.name}" has unsaved changes. Close it and lose them?`, 'Discard changes', true);
    if (!discard) return;
  }
  closeTab(tab.id);
}

export function Tabs(): React.JSX.Element {
  const { tabs, activeId, selectedCollectionId, activate } = useStore();
  return (
    <div className="tabs" role="tablist">
      {tabs.filter((t) => t.collectionId === selectedCollectionId).map((t) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === activeId}
          className={`tab ${t.id === activeId ? 'active' : ''}`}
          title={t.path}
          onClick={() => activate(t.id)}
          onAuxClick={(e) => e.button === 1 && void closeWithPrompt(t)}
        >
          <span className={`method-tag m-${t.draft.method}`} style={{ width: 'auto' }}>
            {t.draft.method}
          </span>
          <span className="name">{t.draft.name}</span>
          {isDirty(t) && <span className="dirty-dot" title="Unsaved changes" />}
          <button
            className="close"
            aria-label={`Close ${t.draft.name}`}
            onClick={(e) => {
              e.stopPropagation();
              void closeWithPrompt(t);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
