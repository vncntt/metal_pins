import { defineConfig } from "vite";
export default defineConfig({
  build: {
    target: "esnext",
    assetsDir: "assets",
    rollupOptions: {
      output: {
        assetFileNames: "./assets/[name]-[hash][extname]",
        chunkFileNames: "./assets/[name]-[hash].js",
        entryFileNames: "./assets/[name]-[hash].js",
      },
    },
  },
  base: "/metal_pins/",
});
