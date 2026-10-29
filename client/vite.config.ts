import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// RTS_LAN=1 binds 0.0.0.0 so other devices on the LAN can open the dashboard.
// base './' keeps built asset URLs relative so the desktop shell can load
// client/dist from file:// — there location.hostname is empty, so production
// builds also default VITE_SERVER_URL to localhost unless one is already set.
export default defineConfig(({ command, mode }) => {
  if (command === 'build' && !loadEnv(mode, process.cwd(), 'VITE_')['VITE_SERVER_URL']) {
    process.env['VITE_SERVER_URL'] = 'http://localhost:4444';
  }
  return {
    base: './',
    plugins: [react()],
    server: {
      port: 4445,
      strictPort: true,
      host: process.env['RTS_LAN'] === '1' ? '0.0.0.0' : 'localhost',
    },
  };
});
