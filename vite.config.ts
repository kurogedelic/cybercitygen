import { defineConfig } from 'vite';

// GitHub Pages 配信のため base を /cybercitygen/ に。
// ローカル dev では '/' に戻す。
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/cybercitygen/' : '/',
}));
