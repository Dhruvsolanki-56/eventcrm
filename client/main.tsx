import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/fraunces/latin-500.css';
import '@fontsource/fraunces/latin-600.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.js';
import { ConfirmHost } from './confirm.js';
import './styles.css';
import './workspace-design.css';
import './calm-workspace.css';
import './ui/tokens.css';
import './ui/base.css';
import './ui/shell.css';
import './ui/auth.css';
import './ui/home.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <ConfirmHost />
    </BrowserRouter>
  </React.StrictMode>,
);

// Keep the app itself on the device so it can open without a signal. Not used in development.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => undefined); });
}
