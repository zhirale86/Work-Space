import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { ROUTER_FUTURE, buildRoutes } from './App';
import { ToastProvider } from './components/Toast';
import './styles/tokens.css';
import './styles/ui.css';
import './styles/app.css';

type AppRouter = ReturnType<typeof createBrowserRouter>;

function render(router: AppRouter): void {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ToastProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </ToastProvider>
    </StrictMode>,
  );
}

// Демонстрационная сборка (npm run build:demo): сервер в памяти браузера и hash-маршрутизация для file://.
// В обычной сборке условие ложно на этапе сборки, и код web/src/demo в неё не попадает.
if (import.meta.env.VITE_DEMO === '1') {
  void import('./demo').then((demo) => render(demo.startDemo()));
} else {
  render(createBrowserRouter(buildRoutes(), { future: ROUTER_FUTURE }));
}
