import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';

import './styles/global.css';
import './styles/chat.css';
import './styles/viz.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A phone tabs away constantly; refetching on every focus is noisy and
      // expensive, so rely on explicit refetch intervals and pull-to-refresh.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 10_000,
    },
  },
});

/**
 * Service-worker registration. On plain HTTP the browser refuses to register,
 * which throws — that is the expected, dormant state, so it is swallowed. Once
 * the app is served over TLS this same call silently starts working and the
 * install prompt, offline cache and push all become available.
 */
try {
  registerSW({ immediate: true });
} catch {
  // Not a secure context — PWA features stay off. See README.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
