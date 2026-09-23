# S3-compatible object storage for backups. Source it; do not execute it.
#
# A backup on the same disk as the database does not survive the failure it
# exists for, so every verified backup is pushed offsite. Uses the AWS CLI when
# present (the backup container ships it); any S3-compatible endpoint works —
# MinIO, Backblaze B2, Hetzner, Wasabi, AWS.
#
# Configuration (infra/.env.production.example):
#   BACKUP_S3_ENDPOINT   https://s3.eu-central-1.example.com
#   BACKUP_S3_REGION     eu-central-1
#   BACKUP_S3_BUCKET     mission-hub-backups
#   BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY
#   BACKUP_S3_PREFIX     optional key prefix (default: the database name)
#
# Offsite storage is OPTIONAL for a local run and REQUIRED in production: with
# no endpoint configured the helpers say so and return 2, and backup.sh decides
# what that means (see s3_required).

s3_configured() {
  [ -n "${BACKUP_S3_BUCKET:-}" ] && [ -n "${BACKUP_S3_ENDPOINT:-}" ] &&
    [ -n "${BACKUP_S3_ACCESS_KEY:-}" ] && [ -n "${BACKUP_S3_SECRET_KEY:-}" ]
}

s3_required() {
  # In production a backup that did not leave the machine is a FAILED backup.
  [ "${NODE_ENV:-}" = "production" ] || [ "${BACKUP_S3_REQUIRED:-}" = "true" ]
}

s3_prefix() { printf '%s' "${BACKUP_S3_PREFIX:-${DB_NAME:-mission_demo}}"; }

__aws() {
  AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
    AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}" \
    AWS_EC2_METADATA_DISABLED=true \
    aws --endpoint-url "$BACKUP_S3_ENDPOINT" "$@"
}

# Upload one verified backup. 0 = uploaded, 1 = failed, 2 = not configured.
s3_upload() {
  local file="$1" key
  key="$(s3_prefix)/$(basename "$file")"
  if ! s3_configured; then
    echo "backup: offsite storage is not configured (BACKUP_S3_*)" >&2
    return 2
  fi
  if ! command -v aws >/dev/null 2>&1; then
    echo "backup: the aws CLI is not installed — cannot upload $file" >&2
    return 1
  fi
  if ! __aws s3 cp "$file" "s3://${BACKUP_S3_BUCKET}/${key}" >/dev/null; then
    echo "backup: UPLOAD FAILED for $file -> s3://${BACKUP_S3_BUCKET}/${key}" >&2
    return 1
  fi
  # Prove it landed and is the same size, rather than trusting the exit code.
  local local_size remote_size
  local_size="$(wc -c < "$file" | tr -d ' ')"
  remote_size="$(__aws s3api head-object --bucket "$BACKUP_S3_BUCKET" --key "$key" --query ContentLength --output text 2>/dev/null || echo '')"
  if [ "$local_size" != "$remote_size" ]; then
    echo "backup: UPLOAD VERIFY FAILED for $key (local ${local_size} bytes, remote '${remote_size}')" >&2
    return 1
  fi
  echo "backup: uploaded s3://${BACKUP_S3_BUCKET}/${key} (${local_size} bytes)" >&2
  return 0
}

# Download the newest remote backup to a path. Used by backup-verify.
s3_download_latest() {
  local dest="$1" key
  s3_configured || return 2
  key="$(__aws s3api list-objects-v2 --bucket "$BACKUP_S3_BUCKET" --prefix "$(s3_prefix)/" \
    --query 'sort_by(Contents,&LastModified)[-1].Key' --output text 2>/dev/null)"
  [ -n "$key" ] && [ "$key" != "None" ] || {
    echo "backup: no remote backup found under $(s3_prefix)/" >&2
    return 1
  }
  __aws s3 cp "s3://${BACKUP_S3_BUCKET}/${key}" "$dest" >/dev/null || return 1
  echo "$key"
}

# Retention, applied REMOTELY as well as locally: keep BACKUP_KEEP_DAILY recent
# objects plus a BACKUP_KEEP_WEEKLY allowance, and delete what falls outside
# that window.
s3_prune() {
  local keep_daily="${BACKUP_KEEP_DAILY:-7}" keep_weekly="${BACKUP_KEEP_WEEKLY:-4}"
  s3_configured || return 2
  local keys
  keys="$(__aws s3api list-objects-v2 --bucket "$BACKUP_S3_BUCKET" --prefix "$(s3_prefix)/" \
    --query 'sort_by(Contents,&LastModified)[].Key' --output text 2>/dev/null | tr '\t' '\n')"
  [ -n "$keys" ] || return 0
  local total keep_from i=0
  total="$(printf '%s\n' "$keys" | wc -l | tr -d ' ')"
  # Keep dailies + a weekly allowance; delete anything older than that window.
  keep_from=$((total - keep_daily - keep_weekly))
  [ "$keep_from" -gt 0 ] || return 0
  printf '%s\n' "$keys" | head -n "$keep_from" | while read -r old; do
    [ -n "$old" ] || continue
    __aws s3 rm "s3://${BACKUP_S3_BUCKET}/${old}" >/dev/null && echo "backup: pruned remote $old" >&2
  done
}

# Local retention: the same window, applied to BACKUP_DIR.
local_prune() {
  local dir="$1" keep=$((${BACKUP_KEEP_DAILY:-7} + ${BACKUP_KEEP_WEEKLY:-4}))
  local files count extra
  files="$(ls -1t "$dir"/*.sql.gz 2>/dev/null || true)"
  [ -n "$files" ] || return 0
  count="$(printf '%s\n' "$files" | wc -l | tr -d ' ')"
  extra=$((count - keep))
  [ "$extra" -gt 0 ] || return 0
  printf '%s\n' "$files" | tail -n "$extra" | while read -r old; do
    rm -f "$old" && echo "backup: pruned local $(basename "$old")" >&2
  done
}
