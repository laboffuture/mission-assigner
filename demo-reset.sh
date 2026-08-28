#!/usr/bin/env bash
# ==========================================================================
# DEMO RESET  (Task 4)
# Run this IMMEDIATELY before you present, then do not click anything in the
# app until the room is watching. Every click consumes a mission and moves a
# level, so a clean reset right before you start is what keeps your rehearsed
# sequence (Student B at L3, Student A at L2, Student C at L0) intact.
#
# Usage:  bash demo-reset.sh
# ==========================================================================
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Resetting mission_demo to pristine demo state from backup.sql ..."
docker exec mission-mysql mysql -uroot -pdevpass -e "DROP DATABASE IF EXISTS mission_demo;" 2>/dev/null
docker exec -i mission-mysql mysql -uroot -pdevpass < "$DIR/backup.sql" 2>/dev/null

echo ""
echo "Students should read A:2  B:3  C:0  with 0 assignments:"
docker exec mission-mysql mysql -uroot -pdevpass -N \
  -e "SELECT display_name, current_level, consecutive_wrong FROM mission_demo.students ORDER BY id;" 2>/dev/null
CNT=$(docker exec mission-mysql mysql -uroot -pdevpass -N \
  -e "SELECT COUNT(*) FROM mission_demo.assignments;" 2>/dev/null)
echo "assignments = $CNT"
echo ""
[ "$CNT" = "0" ] && echo "READY. Do not touch the app until the room is watching." \
                  || echo "WARNING: assignments not zero — investigate before demo."
