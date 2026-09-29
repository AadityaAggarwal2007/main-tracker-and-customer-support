#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# One-time: let this computer (and the AI working on it) reach the VPS as
#   ssh shiptrack-vps
# with no password from then on.
#
# Run it in your own Terminal:  bash vps-setup/connect.sh
# It asks for the VPS IP, then the root password ONCE. Type the password here,
# never into an AI chat — chats keep a history.
# ═══════════════════════════════════════════════════════════════
set -e

ALIAS=shiptrack-vps
KEY="$HOME/.ssh/id_ed25519"
CONFIG="$HOME/.ssh/config"

if ssh -o BatchMode=yes -o ConnectTimeout=5 "$ALIAS" true 2>/dev/null; then
  echo "Already connected — 'ssh $ALIAS' works. Nothing to do."
  exit 0
fi

read -rp "VPS IP address: " IP
IP="${IP// /}"
[ -n "$IP" ] || { echo "No IP given."; exit 1; }

mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -f "$KEY" -C "$(whoami)@shiptrack"

# Replace any earlier shiptrack-vps entry, so re-running fixes a mistyped IP.
touch "$CONFIG"
awk -v a="$ALIAS" '$1=="Host"{skip=($2==a)} !skip' "$CONFIG" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"
printf '\nHost %s\n  HostName %s\n  User root\n  IdentityFile %s\n' "$ALIAS" "$IP" "$KEY" >> "$CONFIG"
chmod 600 "$CONFIG"

echo
echo "Now type the VPS root password (nothing shows while you type), then Enter:"
if ! ssh-copy-id -i "$KEY.pub" -o StrictHostKeyChecking=accept-new "$ALIAS"; then
  echo
  echo "Could not log in. Either the password or IP is wrong (run this again),"
  echo "or the server does not allow password logins. In that case paste this"
  echo "line into the Hostinger web console, then run this script again:"
  echo
  echo "  mkdir -p ~/.ssh && echo '$(cat "$KEY.pub")' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
  exit 1
fi

echo
ssh -o BatchMode=yes "$ALIAS" 'echo "✅ Connected to $(hostname). The AI can now use: ssh shiptrack-vps"'
