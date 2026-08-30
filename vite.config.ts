import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // GitHub Pages 项目站点基路径（仓库名 writer-simulator）
  base: '/writer-simulator/',
  plugins: [react()],
})
