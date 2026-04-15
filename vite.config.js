import UnoCSS from '@unocss/vite';
import { defineConfig } from 'vite';

const repoName = '2026-VibeCoding-Task4';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? `/${repoName}/` : '/',
  plugins: [UnoCSS()],
}));