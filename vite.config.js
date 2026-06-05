import { defineConfig } from 'vite'


export default defineConfig({
  root: 'final01',
  server: {
    port: 5500,
    host: true,
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  }
})