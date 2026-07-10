import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

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
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        waContacts: path.resolve(__dirname, "wa-contacts.html")
      }
    }
  }
});
