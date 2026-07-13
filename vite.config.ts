import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Single-page app: one `index.html` entry mounts the router. The former
// `wa-contacts.html` entry folded into the `/contacts` route.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5900,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3600"
    }
  },
  preview: {
    host: "127.0.0.1",
    port: 5900,
    strictPort: true
  }
});
