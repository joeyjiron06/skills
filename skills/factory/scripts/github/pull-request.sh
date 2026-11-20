#!/bin/sh
# Opens or updates a factory job's pull request on GitHub with the gh CLI.
#
# Run by `job approver complete` through config.json -> pull_request, inside the
# job's worktree, with the $FACTORY_* variables set (see `job help`):
#
#   APPROVE   labels the PR auto-merge and turns on auto-merge (squash)
#   ESCALATE  labels the PR needs-human-review
#
# Safe to run again: an existing PR for the branch is updated, not duplicated,
# and its label is swapped when an ESCALATE is followed by an APPROVE.
#
# Needs: gh, logged in (`gh auth status`) with access to the repo. Auto-merge
# also needs "Allow auto-merge" on in the repo's settings.
set -eu

case "$FACTORY_OUTCOME" in
  APPROVE)
    label=auto-merge
    other=needs-human-review
    color=0E8A16
    about="The factory approved this PR to merge without human review"
    ;;
  ESCALATE)
    label=needs-human-review
    other=auto-merge
    color=D93F0B
    about="The factory needs a human to review this PR"
    ;;
  *)
    echo "unknown FACTORY_OUTCOME: $FACTORY_OUTCOME (expected APPROVE or ESCALATE)" >&2
    exit 1
    ;;
esac

git push -u origin "$FACTORY_BRANCH"
gh label create "$label" --force --color "$color" --description "$about"

if gh pr view "$FACTORY_BRANCH" > /dev/null 2>&1; then
  gh pr edit "$FACTORY_BRANCH" --title "$FACTORY_TITLE" --body-file "$FACTORY_BODY_FILE" --add-label "$label"
  if gh pr view "$FACTORY_BRANCH" --json labels -q '.labels[].name' | grep -qx "$other"; then
    gh pr edit "$FACTORY_BRANCH" --remove-label "$other"
  fi
else
  gh pr create --base "$FACTORY_BASE" --head "$FACTORY_BRANCH" \
    --title "$FACTORY_TITLE" --body-file "$FACTORY_BODY_FILE" --label "$label"
fi

if [ "$FACTORY_OUTCOME" = APPROVE ]; then
  gh pr merge "$FACTORY_BRANCH" --auto --squash
fi

gh pr view "$FACTORY_BRANCH" --json url -q .url
