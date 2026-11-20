#!/bin/sh
# Opens or updates a factory job's pull request on Azure DevOps with the az CLI.
#
# Run by `job approver complete` through config.json -> pull_request, inside the
# job's worktree, with the $FACTORY_* variables set (see `job help`):
#
#   APPROVE   labels the PR auto-merge and sets it to auto-complete (squash,
#             deleting the source branch) once its policies pass
#   ESCALATE  labels the PR needs-human-review
#
# Safe to run again: an existing active PR for the branch is updated, not
# duplicated, and its label is swapped when an ESCALATE is followed by an APPROVE.
#
# Needs: az with the azure-devops extension (`az extension add --name
# azure-devops`), logged in (`az login`). The organization, project and repo
# are detected from the worktree's git remote; if that fails, set defaults with
# `az devops configure --defaults organization=<url> project=<name>`.
#
# Azure DevOps caps PR descriptions at 4000 characters, so a longer body is cut.
set -eu

case "$FACTORY_OUTCOME" in
  APPROVE)  label=auto-merge;         other=needs-human-review ;;
  ESCALATE) label=needs-human-review; other=auto-merge ;;
  *)
    echo "unknown FACTORY_OUTCOME: $FACTORY_OUTCOME (expected APPROVE or ESCALATE)" >&2
    exit 1
    ;;
esac

limit=4000
note="

_Cut to fit Azure DevOps' $limit character limit. The full decision is in the factory job folder._"
if [ "$(wc -c < "$FACTORY_BODY_FILE")" -le "$limit" ]; then
  description=$(cat "$FACTORY_BODY_FILE")
else
  # Counts bytes, so it never goes over. iconv drops a character cut in half,
  # though some iconv builds (macOS) still exit 1 for it.
  cut=$(head -c "$((limit - ${#note} - 3))" "$FACTORY_BODY_FILE" | iconv -c -f UTF-8 -t UTF-8 2> /dev/null || true)
  description="$cut$note"
fi

# Adds or removes a PR label through the REST API: `az repos pr update` can't.
pr_label() { # <POST|DELETE> <label>
  project=$(az repos pr show --id "$id" --query repository.project.id -o tsv)
  repo=$(az repos pr show --id "$id" --query repository.id -o tsv)
  if [ "$1" = POST ]; then
    body=$(mktemp)
    printf '{"name": "%s"}' "$2" > "$body"
    az devops invoke --area git --resource pullRequestLabels --http-method POST --in-file "$body" \
      --route-parameters project="$project" repositoryId="$repo" pullRequestId="$id" \
      --api-version 7.1 -o none
    rm -f "$body"
  else
    az devops invoke --area git --resource pullRequestLabels --http-method DELETE \
      --route-parameters project="$project" repositoryId="$repo" pullRequestId="$id" labelIdOrName="$2" \
      --api-version 7.1 -o none
  fi
}

git push -u origin "$FACTORY_BRANCH"

id=$(az repos pr list --source-branch "$FACTORY_BRANCH" --status active --query '[0].pullRequestId' -o tsv)
if [ -z "$id" ]; then
  id=$(az repos pr create --source-branch "$FACTORY_BRANCH" --target-branch "$FACTORY_BASE" \
    --title "$FACTORY_TITLE" --description "$description" --labels "$label" \
    --query pullRequestId -o tsv)
else
  az repos pr update --id "$id" --title "$FACTORY_TITLE" --description "$description" -o none
  labels=$(az repos pr show --id "$id" --query 'labels[].name' -o tsv)
  printf '%s\n' "$labels" | grep -qx "$label" || pr_label POST "$label"
  if printf '%s\n' "$labels" | grep -qx "$other"; then pr_label DELETE "$other"; fi
fi

if [ "$FACTORY_OUTCOME" = APPROVE ]; then
  az repos pr update --id "$id" --auto-complete true --squash true --delete-source-branch true -o none
fi

az repos pr show --id "$id" --query "join('', [repository.webUrl, '/pullrequest/', to_string(pullRequestId)])" -o tsv
