#!/usr/bin/env bash
# Tells whether upstream has released something this fork has not taken in, and how merging it goes.
#
# Run by .github/workflows/upstream-sync.yml. It tries the merge in the working copy and undoes it,
# pushes nothing, and writes one issue for each release. DRY_RUN=1 prints the issue instead.
# Needs the `upstream` remote and GH_TOKEN, and a clean working copy.
set -euo pipefail

UPSTREAM_REPO=Xelltis/udonarium_axe
REPO=kakapo-105/udonarium_axe
# Removed from the fork on purpose (see FORK.md), so a conflict in one of them is not one to solve by hand.
REMOVED_WORKFLOWS='^\.github/workflows/(release|deploy|docs)\.yml$'

latest=$(gh release view --repo "$UPSTREAM_REPO" --json tagName -q .tagName)
if git merge-base --is-ancestor "$latest" HEAD; then
  echo "$latest is already taken in."
  exit 0
fi

title="上流 $latest の取り込み"
if [ "${DRY_RUN:-}" != 1 ] &&
  [ -n "$(gh issue list --repo "$REPO" --state all --search "\"$title\" in:title" --json number -q '.[].number')" ]; then
  echo "An issue for $latest exists already."
  exit 0
fi

git config user.name "${GIT_AUTHOR_NAME:-upstream-check}"
git config user.email "${GIT_AUTHOR_EMAIL:-upstream-check@users.noreply.github.com}"
if git merge --no-commit --no-ff "$latest" >/dev/null 2>&1; then conflicted=''; else
  conflicted=$(git diff --name-only --diff-filter=U | grep -Ev "$REMOVED_WORKFLOWS" || true)
fi
git merge --abort 2>/dev/null || git reset --hard --quiet HEAD

changed=$(git diff --shortstat "HEAD...$latest" | sed 's/^ *//')
count=$(printf '%s' "$conflicted" | grep -c . || true)

notes=$(mktemp)
body=$(mktemp)
{
  echo "上流に \`$latest\` が公開されました。"
  echo
  echo "- 差分: $changed"
  echo "- 試しマージの競合: **$count ファイル**"
  echo
  echo "取り込みは手元で \`/axe-upstream-merge $latest\` を実行します。"
  if [ "$count" -gt 0 ]; then
    echo
    echo '## 競合するファイル'
    echo
    printf '%s\n' "$conflicted" | sed 's/^/- `/; s/$/`/'
  fi
  echo
  echo '## リリースノート'
  for tag in $(git tag --no-merged HEAD --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$'); do
    echo
    echo "### $tag"
    echo
    gh release view "$tag" --repo "$UPSTREAM_REPO" --json body -q .body || echo '(リリースノートを読めませんでした)'
  done
} >"$notes"
# An issue holds 65536 characters. The oldest notes are the ones cut off, and a letter cut in half is left out.
head -c 60000 "$notes" | iconv -f utf-8 -t utf-8 -c >"$body" || true

if [ "${DRY_RUN:-}" = 1 ]; then
  echo "TITLE: $title"
  cat "$body"
else
  gh issue create --repo "$REPO" --title "$title" --body-file "$body"
fi
