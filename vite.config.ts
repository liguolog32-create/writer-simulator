import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Cloudflare Pages 部署在根路径，不需要 base；
  // 如需 GitHub Pages 项目站点，可临时改回 base: '/writer-simulator/'
  plugins: [react()],
})
