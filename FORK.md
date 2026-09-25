# このフォークについて

`kakapo-105/udonarium_axe` — [Xelltis/udonarium_axe](https://github.com/Xelltis/udonarium_axe) の個人フォーク。
独自機能を加えつつ、ビルド結果を GitHub Pages で公開する。

## 公開

- URL: https://kakapo-105.github.io/udonarium_axe/
- `main` に push すると [.github/workflows/pages.yml](.github/workflows/pages.yml) が
  `npm ci && npm run build` → `dist/assets/config.json` にバックエンド URL を注入 → Pages へ配信。
- バックエンド URL はソースに入れず、リポジトリ Secret `BACKEND_URL` から注入する
  （Settings → Secrets and variables → Actions）。
- 利用ガイド（`website/` の VitePress）も同じワークフローでビルドし、アプリの隣の
  https://kakapo-105.github.io/udonarium_axe/docs/ に置く。アプリのメニューの「マニュアル」から開ける。
  - 公開パスとサイト URL は `DOCS_BASE` / `DOCS_SITE_URL` で渡す（未指定なら上流の値のまま）。
  - ガイド中の「遊ぶ場所」（上流の `https://axe.xelltis.com`）は、このビルドでだけこのフォークのアプリに置き換える。
    リポジトリの Markdown は書き換えないので、上流の取り込みで競合しない。
  - 手元で見るときは `npm --prefix website run dev`（`npm start` のアプリからメニューで開くと 404 になる）。

## 上流の取り込み（リリースタグ単位）

```sh
git fetch upstream --tags
git merge v1.52.0        # 新しいタグが出たとき
# コンフリクトを解決してコミット
git push                 # → 自動でビルド＆公開
```

`upstream` remote: `https://github.com/Xelltis/udonarium_axe.git`

## 独自機能

- feature ブランチで作って `main` にマージする。
- コミットは小さく、全体整形はしない（上流マージのコンフリクトを局所化するため）。
- 加えた機能は README の「このフォークで加えた機能」に載せる。

現在の独自機能:

- `{tcount}` — ターゲットを取る行でターゲットの数に置き換わる参照（[website/manual/chat-syntax.md](website/manual/chat-syntax.md#ターゲットの数を読む)）
- チャットパレットの 2 段見出し — `◆` の下に `■` の見出しを置き、見出しメニューでサブメニューとして開く（[website/manual/chat-palette.md](website/manual/chat-palette.md#見出しを-2-段にする)）
- `if(条件,真,偽)` — チャットの行・リソース操作・計算項目の式で数値を条件分岐する。リソース操作では `[2d6]` の出目と `$1` での再利用も使える（[website/manual/chat-syntax.md](website/manual/chat-syntax.md#条件で値を切り替える)）
- マニュアル — 利用ガイドをアプリの隣（`docs/`）に公開し、アプリのメニューに「マニュアル」を追加
- MCP による AI 操作 — okamichi さんの `feat/mcp`（1.50.0 ベース）を 1.57.1 へ移植。独自にシート・チャットパレット・バフの操作を追加し、「AI操作」パネルをドラッグで動かせるよう変更。MCP サーバーは `tools/mcp-server` の独立パッケージ（[tools/mcp-server/README.md](tools/mcp-server/README.md)）

## 上流から削除したワークフロー

フォークに合わないため削除済み（`git` 履歴に残る）:

- `release.yml` — semantic-release が自分の `main` にリリースコミットを push してしまう
- `deploy.yml` — 上流の AWS S3 / CloudFront 用（Secret を持っていない）
- `docs.yml` — `website/` の VitePress サイトを同じ `github-pages` 環境へ出すのでアプリ配信と衝突

`ci.yml`（Pull Request 時の lint / test / build）は残してある。
