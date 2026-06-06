import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { ConvexProvider } from 'convex/react';
import { convex } from './convexClient.js';

const root = ReactDOM.createRoot(document.getElementById('root'));

root.render(
  convex ? (
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  ) : (
    <App />
  )
);
