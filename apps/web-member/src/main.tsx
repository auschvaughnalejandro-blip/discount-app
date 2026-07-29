import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.js';

// No stylesheet import. BUILD-PLAN §0 rule 1: no CSS files, no Tailwind, no
// component library. `test/no-styling.test.ts` in the API workspace asserts
// that stays true.
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
