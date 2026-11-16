import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// v10.18 发布流：构建时注入一个「构建标识」，发布请求会带上它，
// 用来确认「要发到正式版的」就是测试版上验证过的那一份产物。
const BUILD_HASH =
  process.env.BUILD_HASH ||
  new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-')

export default defineConfig({
  // Cloudflare Pages 部署在根路径，不需要 base；
  // 如需 GitHub Pages 项目站点，可临时改回 base: '/writer-simulator/'
  plugins: [react()],
  define: {
    __BUILD_HASH__: JSON.stringify(BUILD_HASH),
  },
})
