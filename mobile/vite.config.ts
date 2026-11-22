import { defineConfig } from 'vite'

// base 用相对路径：Capacitor 打包后资源通过本地 scheme 加载。
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
  },
})
