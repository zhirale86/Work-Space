import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './App';
import { ToastProvider } from './components/Toast';
import './styles/tokens.css';
import './styles/ui.css';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </ToastProvider>
  </StrictMode>,
);
