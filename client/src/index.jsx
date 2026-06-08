import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { ConvexProvider } from 'convex/react';
import { convex } from './convexClient.js';
import { AuthProvider } from './AuthContext.jsx';

const root = ReactDOM.createRoot(document.getElementById('root'));

const app = (
  <AuthProvider>
    <App />
  </AuthProvider>
);

root.render(
  convex ? (
    <ConvexProvider client={convex}>
      {app}
    </ConvexProvider>
  ) : (
    app
  )
);
