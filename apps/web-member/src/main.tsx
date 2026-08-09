import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App.js';

// Stylesheets are imported by App.tsx, in the order the cascade needs them.
// (Stages 10–14 carried no CSS at all under BUILD-PLAN §0 rule 1; Stage 17
// lifted that, and `client-invariants.test.ts` records what the retired
// assertions were replaced with.)
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    {/* Real paths, not hashes: the app is installed to a home screen and
        served by Caddy with an index.html fallback, so /offers/spa is a URL
        that survives a cold start and a share. */}
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
