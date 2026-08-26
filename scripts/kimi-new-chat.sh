#!/bin/bash
# Kimi Web 一键强制开新对话
# 清除本地持久化的 KIMI 对话 ID，下次发消息自动创建新对话

SESSIONS_FILE="$HOME/.openclaw/kimi-sessions.json"

if [ ! -f "$SESSIONS_FILE" ]; then
  echo "✅ 没有找到 KIMI 会话文件，当前已无持久化对话。"
  exit 0
fi

echo "📋 当前 KIMI 会话内容:"
cat "$SESSIONS_FILE" | python3 -m json.tool 2>/dev/null || cat "$SESSIONS_FILE"

echo ""
echo "🗑️  清除中..."

# 备份旧会话
cp "$SESSIONS_FILE" "${SESSIONS_FILE}.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null
echo "📦 已备份到 ${SESSIONS_FILE}.bak.*"

# 清空（写入空 JSON 对象）
echo "{}" > "$SESSIONS_FILE"

echo "✅ 已强制清除 KIMI 会话！下次发消息将自动创建新对话。"
echo ""
echo "💡 如需恢复旧对话，运行: mv ${SESSIONS_FILE}.bak.* $SESSIONS_FILE"
