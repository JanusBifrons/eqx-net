/**
 * src/client — Phase 0 stub.
 *
 * Phase 1 replaces this with a React/MUI splash → Pixi mount.
 * See the approved plan file.
 */
import { createRoot } from 'react-dom/client';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <div style={{ padding: 24 }}>
      <h1>EQX Peri</h1>
      <p>Phase 0 foundation. Join screen arrives in Phase 1.</p>
    </div>,
  );
}
