import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Web Bluetooth requires a secure context. localhost counts as one, so the
    // dev server works as-is; a deployed build must be served over https.
    host: 'localhost',
  },
});
