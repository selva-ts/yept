import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@yept/ui/monaco';
import '@yept/ui/styles.css';
import { App } from './App';
import { useStore } from '@yept/ui/store';

// Apply the theme and fonts before the first paint, so a non-default theme doesn't flash the default one.
void useStore.getState().loadAppearance().finally(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
);
