---
name: axe-upstream-merge
description: 上流 Xelltis/udonarium_axe の新しいリリースタグを、このフォークへ取り込む。競合を解決し、上流の変更に追いついていない独自コードを直し、検証して main へ反映する。「Axe の取り込み」「上流の vX.Y.Z を取り込む」、GitHub の Issue「上流 vX.Y.Z の取り込み」が来たときに使う。
---

# 上流のリリースを取り込む

`/axe-upstream-merge [vX.Y.Z]`。タグを省略したら、上流の最新のリリースを取り込む。

コミットメッセージは英語、ユーザーへの報告は日本語。lefthook は迂回しない (`--no-verify` 禁止)。
**push と main への反映はユーザーに確認してから行う。** push すると Pages に公開される。

## 1. 調べる

1. 作業ツリーがきれいで main にいて、`main` と `origin/main` が同じことを確かめる
2. `git fetch upstream --tags`
3. 試算する: `git merge-tree --write-tree main <タグ> | grep ^CONFLICT` と `git diff --shortstat <今のタグ> <タグ>`
4. リリースノートを読み、独自機能と重なる機能がないか確かめる (FORK.md の「現在の独自機能」)。
   上流が同じ機能を入れたときは、上流版に寄せて独自部分を減らすほうを勧める。AI GM に影響するので、どちらに寄せるかはユーザーに聞く

## 2. マージする

```sh
git switch -c chore/merge-upstream-<タグ>
git merge --no-ff --no-edit <タグ>
git rm -q --ignore-unmatch .github/workflows/release.yml .github/workflows/deploy.yml .github/workflows/docs.yml
```

- 上流の削除済みワークフロー3つは毎回消す (FORK.md の「上流から削除したワークフロー」)
- `package.json` が変わったら `npm ci`。`website/` も変わったら `npm --prefix website ci`
- 競合を解決する。独自機能は残す。上流が作り直した所は、上流版を土台に独自の差分を載せ直す。
  差分は `git diff <今のタグ> main -- <ファイル>` で見る (`git log` だけでは見落とす)
- 両方のテストが同じ位置で競合したら、両方の `it` を残す。閉じ括弧の位置に気をつける

## 3. 独自コードを上流に追いつかせる

競合しなくても壊れていることがある。**型チェックが通っても終わりではない。**

- `npx tsc -p tsconfig.spec.json --noEmit`
- ゲッターからメソッドに変わったものは型で捕まらない (`!this.role.canEditTabletop` は常に false)。
  `RolePermissionService` のフィールドについて、`()` なしの読み取りがないか grep する
- `src/app/core/network/network-messaging.ts` の `LOCAL_ONLY_EVENTS` と `AUTHORITY_ONLY_EVENTS` の変更を見る。
  **ほかの席へ送る独自のイベントが捨てられていないか。** 単体テストは1台の中で完結するので検出できない
  (v1.68 の `VN_MODE` で、AI からノベルを開けなくなった)
- 上流が `application` から `features` へ移したものは、`application/automation` から直接 import できない。
  トークン (`map-generator.ts`) か、domain だけで書けるなら application のサービスにする
- 上流のテストが増やした前提 (先に別の卓を表示する、など) に、独自のテストを合わせる

## 4. 改行を直す

`core.autocrlf=true` のため、作業コピーの CRLF で pre-commit の eslint が落ちる。

- CR の検出は Python で行う (`b'\r' in bytes`)。Git Bash の grep は見落とす
- **テキストの拡張子だけを直す。** PNG などに掛けると壊れる。
  `.ts .html .css .json .md .mjs .js .yml .yaml .txt .svg .xml` の `b'\r\n'` を `b'\n'` に置き換える
- 掛けたあと、バイナリの blob が上流と同じことを確かめる

## 5. 検証する

全部通るまでコミットしない。

```sh
npx vitest run
(cd tools/mcp-server && npm test)   # pre-commit では走らない
npm run build
npm --prefix website run build
npx eslint <変えたファイル>
npx prettier --check --end-of-line auto .
```

ツールの数が変わったら `tools/mcp-server/test/contracts.test.mjs` の数も直す。

## 6. コミットする

- 件名は既定の `Merge tag '<タグ>' into chore/merge-upstream-<タグ>` だけが commitlint を通る。本文に独自機能への対応を書く
- 先に `npx commitlint < <メッセージのファイル>` で確かめる
- 大きなマージではフックのテストに 45 分ほどかかるので、バックグラウンドで実行する

## 7. 反映する

1. ユーザーの確認を取ってから、main を fast-forward して push する (pre-push で全テストとビルドが走る)
2. `gh run watch` で Pages のデプロイを待ち、公開ページが新しい版に替わったことを確かめる
3. FORK.md とメモリの「今のタグ」を更新する
4. ユーザーに `sw25-ai-gm` で Claude Code を立ち上げ直して `/sw25-test` を回してもらう。
   **PL のブラウザは AI のブラウザとは別のもの。** 上流の取り込みで特に見るのは、ノベルの開閉・BGM・ターン操作・テンプレートの読み込み
5. 問題がなければ、Issue「上流 <タグ> の取り込み」を閉じる。リリースノートから AI GM で使えそうな機能があれば、KB の ideas.md に足す
