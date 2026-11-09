import { useStore } from '../store';

/** Always next to Send: which environment this collection's requests run in. */
export function EnvSwitcher({ collectionId }: { collectionId: string }): React.JSX.Element {
  const { envs, setActiveEnv, openEnvEditor } = useStore();
  const list = envs[collectionId];
  const active = list?.active ?? null;
  const tls = list?.environments.find((e) => e.name === active)?.tls;
  return (
    <div className="env-switcher">
      <select
        className={`input env-select ${active ? 'has-env' : ''}`}
        value={active ?? ''}
        onChange={(e) => {
          if (e.target.value === '__manage') openEnvEditor(collectionId);
          else void setActiveEnv(collectionId, e.target.value || null);
        }}
        aria-label="Environment"
        title="Environment for this collection"
      >
        <option value="">No environment</option>
        {list?.environments.map((e) => (
          <option key={e.name} value={e.name}>
            {e.name}
          </option>
        ))}
        <option value="__manage">Manage environments…</option>
      </select>
      {tls?.skipVerify && (
        <span className="badge-warn" title="Certificate checks are turned off for this environment on this machine">
          TLS checks off
        </span>
      )}
    </div>
  );
}
