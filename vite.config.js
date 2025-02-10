import { defineConfig } from "vite";
export default defineConfig({
  build: {
    target: "esnext",
    assetsDir: "assets",
    rollupOptions: {
      output: {
        assetFileNames: "./dist/assets/[name]-[hash][extname]",
        chunkFileNames: "./dist/assets/[name]-[hash].js",
        entryFileNames: "./dist/assets/[name]-[hash].js",
      },
    },
  },
  base: "/metal_pins/",
});
