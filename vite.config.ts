import { defineConfig } from "vite";

/**
 * GitHub Pages は https://<user>.github.io/<repo>/ に置かれるため base が要る。
 * ワークフローから BASE_PATH を渡す。ローカル開発では "/"。
 */
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  build: {
    target: "es2022",
    // public/probe/index.html は dist/probe/index.html にそのままコピーされる
  },
});
