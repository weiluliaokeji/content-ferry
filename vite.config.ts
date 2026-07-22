import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/renderer",
  // The packaged Electron app loads index.html through file://. Relative
  // asset URLs are therefore required; the default "/assets/..." URLs point
  // at the drive root and leave the production window blank.
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true
  }
});
