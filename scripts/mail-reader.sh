#!/bin/bash
# mail-reader.sh — READ-ONLY Apple Mail interface for Cal Gateway
#
# ⚠️  This script intentionally contains NO write operations.
#     No "make new outgoing message", no "send", no "reply", no "forward",
#     no "delete", no "move", no flag changes.
#
# Usage:
#   mail-reader.sh accounts                         — list mail accounts
#   mail-reader.sh mailboxes [account]              — list mailboxes
#   mail-reader.sh unread [account] [limit]         — list unread messages
#   mail-reader.sh recent [account] [limit]         — list recent messages
#   mail-reader.sh search <query> [account] [limit] — search UNREAD by subject/sender (fast)
#   mail-reader.sh read <message-id>                — read full message content
#   mail-reader.sh count [account]                  — count unread messages
#   mail-reader.sh summary [account] [limit]        — brief summary of recent unread

set -euo pipefail

ACTION="${1:-help}"
shift 2>/dev/null || true

run_applescript() {
    osascript -e "$1"
}

case "$ACTION" in

accounts)
    run_applescript '
tell application "Mail"
    set output to ""
    repeat with acct in every account
        set output to output & name of acct & " (" & (count of (messages of inbox whose account of mailbox of it is acct)) & " in inbox)" & linefeed
    end repeat
    return output
end tell'
    ;;

mailboxes)
    ACCOUNT="${1:-}"
    run_applescript "
tell application \"Mail\"
    set accountName to \"$ACCOUNT\"
    if accountName is \"\" then
        set acct to first account
    else
        set acct to first account whose name is accountName
    end if
    set output to \"\"
    repeat with mb in every mailbox of acct
        set mbName to name of mb
        set msgCount to count of messages of mb
        set output to output & mbName & \" (\" & msgCount & \")\" & linefeed
    end repeat
    return output
end tell"
    ;;

unread)
    ACCOUNT="${1:-}"
    LIMIT="${2:-10}"
    run_applescript "
tell application \"Mail\"
    set accountName to \"$ACCOUNT\"
    if accountName is \"\" then
        set acct to first account
    else
        set acct to first account whose name is accountName
    end if
    set inbx to mailbox \"Inbox\" of acct
    set unreadMsgs to (messages of inbx whose read status is false)
    set msgCount to count of unreadMsgs
    if msgCount is 0 then
        return \"No unread messages.\"
    end if
    set maxMsgs to $LIMIT
    if msgCount < maxMsgs then set maxMsgs to msgCount
    set output to \"Unread: \" & msgCount & \" total\" & linefeed & \"---\" & linefeed
    repeat with i from 1 to maxMsgs
        set m to item i of unreadMsgs
        try
            set output to output & \"ID: \" & (id of m) & linefeed
            set output to output & \"Subject: \" & (subject of m) & linefeed
            set output to output & \"From: \" & (sender of m) & linefeed
            set output to output & \"Date: \" & (date received of m as string) & linefeed
            set output to output & \"---\" & linefeed
        end try
    end repeat
    return output
end tell"
    ;;

recent)
    ACCOUNT="${1:-}"
    LIMIT="${2:-10}"
    run_applescript "
tell application \"Mail\"
    set accountName to \"$ACCOUNT\"
    if accountName is \"\" then
        set acct to first account
    else
        set acct to first account whose name is accountName
    end if
    set inbx to mailbox \"Inbox\" of acct
    -- Just get the first N messages (most recent)
    set msgCount to count of messages of inbx
    if msgCount is 0 then
        return \"No messages in inbox.\"
    end if
    set maxMsgs to $LIMIT
    if msgCount < maxMsgs then set maxMsgs to msgCount
    set output to \"Recent messages (\" & maxMsgs & \" of \" & msgCount & \"):\" & linefeed & \"---\" & linefeed
    repeat with i from 1 to maxMsgs
        set m to message i of inbx
        try
            if read status of m then
                set readFlag to \"✓\"
            else
                set readFlag to \"●\"
            end if
            set output to output & readFlag & \" | \" & (subject of m) & linefeed
            set output to output & \"  From: \" & (sender of m) & linefeed
            set output to output & \"  Date: \" & (date received of m as string) & linefeed
            set output to output & \"  ID: \" & (id of m) & linefeed
            set output to output & \"---\" & linefeed
        end try
    end repeat
    return output
end tell"
    ;;

search)
    QUERY="${1:?Usage: mail-reader.sh search <query> [account] [limit]}"
    ACCOUNT="${2:-}"
    LIMIT="${3:-20}"
    # Search last 3 days (read + unread) - fast enough for most use cases
    run_applescript "
tell application \"Mail\"
    set accountName to \"$ACCOUNT\"
    if accountName is \"\" then
        set acct to first account
    else
        set acct to first account whose name is accountName
    end if
    set inbx to mailbox \"Inbox\" of acct
    set query to \"$QUERY\"
    set threeDaysAgo to (current date) - (3 * days)

    -- Search last 3 days (read + unread)
    set recentMsgs to (messages of inbx whose date received > threeDaysAgo)
    set matches to {}

    repeat with m in recentMsgs
        try
            set subj to subject of m
            set sndr to sender of m
            if subj contains query or sndr contains query then
                set end of matches to m
            end if
        end try
    end repeat

    set msgCount to count of matches
    if msgCount is 0 then
        return \"No messages matching: $QUERY (last 3 days)\"
    end if

    set maxMsgs to $LIMIT
    if msgCount < maxMsgs then set maxMsgs to msgCount
    set output to \"Found \" & msgCount & \" matches for: $QUERY (last 3 days)\" & linefeed & \"---\" & linefeed

    repeat with i from 1 to maxMsgs
        set m to item i of matches
        try
            if read status of m then
                set readFlag to \"[READ]\"
            else
                set readFlag to \"[UNREAD]\"
            end if
            set output to output & \"ID: \" & (id of m) & linefeed
            set output to output & \"Status: \" & readFlag & linefeed
            set output to output & \"Subject: \" & (subject of m) & linefeed
            set output to output & \"From: \" & (sender of m) & linefeed
            set output to output & \"Date: \" & (date received of m as string) & linefeed
            set output to output & \"---\" & linefeed
        end try
    end repeat
    return output
end tell"
    ;;

read)
    MSG_ID="${1:?Usage: mail-reader.sh read <message-id>}"
    run_applescript "
tell application \"Mail\"
    set allAccounts to every account
    repeat with acct in allAccounts
        try
            set m to first message of mailbox \"Inbox\" of acct whose id is $MSG_ID
            set output to \"Subject: \" & (subject of m) & linefeed
            set output to output & \"From: \" & (sender of m) & linefeed
            set output to output & \"To: \" & (address of to recipient 1 of m) & linefeed
            set output to output & \"Date: \" & (date received of m as string) & linefeed
            set output to output & \"Read: \" & (read status of m) & linefeed
            set output to output & \"---\" & linefeed
            set output to output & (content of m)
            return output
        end try
    end repeat
    return \"Message not found with ID: $MSG_ID\"
end tell"
    ;;

count)
    ACCOUNT="${1:-}"
    # Only count unread (fast)
    run_applescript "
tell application \"Mail\"
    set accountName to \"$ACCOUNT\"
    if accountName is \"\" then
        set acct to first account
    else
        set acct to first account whose name is accountName
    end if
    set inbx to mailbox \"Inbox\" of acct
    set unreadMsgs to (messages of inbx whose read status is false)
    set unreadCount to count of unreadMsgs
    return \"Unread: \" & unreadCount
end tell"
    ;;

summary)
    ACCOUNT="${1:-}"
    LIMIT="${2:-5}"
    run_applescript "
tell application \"Mail\"
    set accountName to \"$ACCOUNT\"
    if accountName is \"\" then
        set acct to first account
    else
        set acct to first account whose name is accountName
    end if
    set inbx to mailbox \"Inbox\" of acct
    set unreadMsgs to (messages of inbx whose read status is false)
    set unreadCount to count of unreadMsgs
    if unreadCount is 0 then
        return \"✅ No unread messages.\"
    end if
    set maxMsgs to $LIMIT
    if unreadCount < maxMsgs then set maxMsgs to unreadCount
    set output to \"📬 \" & unreadCount & \" unread message(s):\" & linefeed
    repeat with i from 1 to maxMsgs
        set m to item i of unreadMsgs
        try
            set subj to subject of m
            set sndr to sender of m
            set output to output & \"  • \" & subj & \" — \" & sndr & linefeed
        end try
    end repeat
    if unreadCount > maxMsgs then
        set output to output & \"  ... and \" & (unreadCount - maxMsgs) & \" more\" & linefeed
    end if
    return output
end tell"
    ;;

help|*)
    echo "mail-reader.sh — READ-ONLY Apple Mail interface"
    echo ""
    echo "Commands:"
    echo "  accounts                          List mail accounts"
    echo "  mailboxes [account]               List mailboxes (default: first account)"
    echo "  unread [account] [limit]          List unread messages"
    echo "  recent [account] [limit]          List recent messages (first N)"
    echo "  search <query> [account] [limit]  Search last 3 days (read + unread)"
    echo "  read <message-id>                 Read full message content"
    echo "  count [account]                   Count unread messages"
    echo "  summary [account] [limit]         Brief unread summary"
    echo ""
    echo "⚠️  This script is READ-ONLY. No send/reply/delete/move operations."
    echo "⚠️  'search' searches last 3 days by default (good balance of speed + coverage)"
    ;;

esac
